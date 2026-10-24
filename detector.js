/* detector.js — infer where a vehicle was parked from a stream of GPS fixes.
 *
 * Pure logic: no DOM, no geolocation, no storage. Feed it fixes, it emits events.
 * That keeps it testable against synthetic traces, which matters because the
 * failure modes (red lights, traffic jams, GPS spikes) are exactly the ones you
 * cannot reproduce on demand with a real phone.
 *
 * The central idea: a vehicle stopping is not a parking event. Parking is
 * "vehicle stopped AND the person walked away from it". The displacement test is
 * what separates a red light from a parked car, and it is why this works without
 * any map data, accelerometer, or bluetooth.
 */

export const DEFAULTS = {
  // speed thresholds, metres/second
  vehicularSpeed: 6.0,     // ~21 km/h — sustained above this means wheels
  bikeSpeed: 2.8,          // ~10 km/h — above a brisk walk, below traffic speed
  pedestrianSpeed: 2.0,    // ~7 km/h — at or below this you are on foot
  stationarySpeed: 0.6,

  // durations, milliseconds
  minMovingMs: 25_000,     // must travel this long before a stop can be "parking"
  confirmParkMs: 75_000,   // stay non-vehicular this long to confirm
  // A pending stop does NOT expire with age: if you sit in the car for 20 minutes
  // and then walk away, the car is still exactly where you stopped. What does
  // invalidate it is a hole in the data — if fixes stop arriving (app backgrounded,
  // tunnel, GPS lost) we cannot know the vehicle did not move, so we give up.
  maxFixGapMs: 15 * 60_000,

  // distances, metres
  walkAwayM: 25,           // must get this far from the stop point to confirm
  accuracyLimitM: 60,      // discard fixes worse than this

  smoothWindow: 5,         // median window for speed, in samples
};

export const STATE = {
  UNKNOWN: 'unknown',
  STATIONARY: 'stationary',
  WALKING: 'walking',
  CYCLING: 'cycling',
  DRIVING: 'driving',
};

const R_EARTH = 6_371_000;

export function haversine(a, b) {
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(a, b) {
  const toRad = d => (d * Math.PI) / 180;
  const la1 = toRad(a.lat), la2 = toRad(b.lat), dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * Compass heading (degrees clockwise from north) from a device-orientation event, or
 * null when the event carries none. Two dialects:
 *  - iOS Safari fires plain `deviceorientation` with `webkitCompassHeading`, and never
 *    fires `deviceorientationabsolute` or sets `absolute` (MDN browser-compat-data).
 *    Reading only the standard path left the arrow north-up on every iPhone.
 *  - Chrome/Firefox fire `deviceorientationabsolute` with absolute=true and alpha
 *    counter-clockwise from north. A non-absolute alpha is relative to wherever the
 *    phone happened to point at page load, so it is no heading at all.
 */
export function headingFrom(e) {
  if (!e) return null;
  const w = e.webkitCompassHeading;
  if (typeof w === 'number' && Number.isFinite(w) && w >= 0) return w % 360;
  if (e.absolute === true && typeof e.alpha === 'number' && Number.isFinite(e.alpha))
    return (360 - e.alpha) % 360;
  return null;
}

/**
 * The needle angle to set, given the one it shows now, so it turns the short way.
 * rotate(b - heading) jumps by ~360 whenever the heading crosses north, and a CSS
 * transition interpolates that literally: a full spin. Keeping the angle unwrapped
 * (prev + the signed shortest difference, in [-180, 180)) makes every step <= 180.
 */
export function turnTo(prev, target) {
  if (prev == null || !Number.isFinite(prev)) return target;
  const d = (((target - prev) % 360) + 540) % 360 - 180;
  return prev + d;
}

/**
 * Walking directions back to the spot. The old link was Google's search action, which
 * drops a pin ("a place, not a route"), so getting back meant tapping Directions and
 * then switching off the driving default. On Apple devices Apple Maps is always
 * installed and opens natively; everywhere else Google's directions action does.
 * Coordinates only, so nothing but the spot leaves the page.
 */
export function walkLink(p, apple) {
  const ll = `${(+p.lat).toFixed(6)},${(+p.lon).toFixed(6)}`;
  return apple
    ? `https://maps.apple.com/directions?destination=${ll}&mode=walking`
    : `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=walking`;
}

/**
 * A name for where the spot is: "40 m SE of Y2E2". A pin and a compass get you back to
 * the right rack field, but at Stanford the rack fields are huge and look alike, and a
 * building is what you remember. `list` is [[lat, lon, name], ...] (landmarks.js, bundled,
 * so no lookup ever sends the spot anywhere). Null past `maxM`, so off campus says nothing
 * rather than naming something a kilometre away. Under `atM` it is just "at <name>".
 */
export function placeLabel(p, list, { maxM = 80, atM = 15 } = {}) {
  if (!p || !Number.isFinite(+p.lat) || !Number.isFinite(+p.lon) || !list) return null;
  let best = null, bestD = Infinity;
  for (const row of list) {
    const d = haversine({ lat: row[0], lon: row[1] }, p);
    if (d < bestD) { bestD = d; best = row; }
  }
  if (!best || bestD > maxM) return null;
  const name = best[2];
  if (bestD < atM) return `at ${name}`;
  const dir = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][
    Math.round(bearing({ lat: best[0], lon: best[1] }, p) / 45) % 8];
  return `${Math.round(bestD / 5) * 5} m ${dir} of ${name}`;
}

/**
 * Manual "mark my spot" is the only path that works on iPhone, and its first fix is often
 * a coarse Wi-Fi/cell one that GPS refines over the next few seconds. So watch for up to
 * `windowMs` after the first fix and keep the most accurate one, stopping early once a fix
 * is within `goodM`. `geo` is navigator.geolocation (injectable for tests); the timers too.
 * Calls done(position) with the best fix, or fail(error) if none arrived. Returns cancel().
 */
export function sampleBestFix(geo, done, fail, o = {}) {
  const { windowMs = 5000, goodM = 15, timeoutMs = 20000,
          setT = setTimeout, clearT = clearTimeout } = o;
  let best = null, id = null, over = false, win = null;
  const acc = pos => (Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : Infinity);
  const stop = () => {
    over = true; clearT(win); clearT(cap);
    if (id != null) geo.clearWatch(id);
  };
  const finish = () => { if (over) return; stop(); done(best); };
  const cap = setT(() => {
    if (over) return;
    if (best) finish();
    else { stop(); fail({ code: 3, message: 'No position fix arrived in time.' }); }
  }, timeoutMs);
  id = geo.watchPosition(pos => {
    if (over) return;
    if (!best || acc(pos) < acc(best)) best = pos;
    if (acc(best) <= goodM) return finish();
    if (win == null) win = setT(finish, windowMs);
  }, err => {
    if (over) return;
    if (best) finish();
    else { stop(); fail(err); }
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs });
  if (over && id != null) geo.clearWatch(id);   // a fake geo can answer synchronously
  return () => { if (!over) stop(); };
}

/**
 * Automatic detection only sees fixes while the page is open in front, so tracking holds a
 * screen wake lock. Browsers drop that lock whenever the page is hidden (measured in Chromium:
 * minimise -> released, restore -> still released), so one glance at another app used to
 * leave the screen free to sleep for the rest of the drive. hold() keeps asking for it each
 * time the page is visible again; release() lets the screen sleep once tracking stops.
 * `nav` and `doc` are navigator and document, injectable for tests.
 */
export function screenKeeper(nav, doc) {
  let wanted = false, lock = null, asking = false;
  const take = () => {
    if (!wanted || asking || !nav.wakeLock || doc.visibilityState !== 'visible') return;
    if (lock && !lock.released) return;
    asking = true;
    nav.wakeLock.request('screen').then(l => {
      asking = false;
      if (wanted) lock = l; else l.release().catch(() => {});
    }, () => { asking = false; });
  };
  if (nav.wakeLock) doc.addEventListener('visibilitychange', take);
  return {
    hold() { wanted = true; take(); },
    release() {
      wanted = false;
      if (lock && !lock.released) lock.release().catch(() => {});
      lock = null;
    },
    get held() { return !!lock && !lock.released; },
  };
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class ParkingDetector {
  /** @param {object} opts  overrides for DEFAULTS
   *  @param {(ev:object)=>void} onEvent  receives {type:'park'|'candidate'|'cancel'|'state', …} */
  constructor(opts = {}, onEvent = () => {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.onEvent = onEvent;
    this.reset();
  }

  reset() {
    this.fixes = [];          // accepted fixes, oldest first (bounded)
    this.speeds = [];         // raw speeds aligned to fixes
    this.state = STATE.UNKNOWN;
    this.movingSinceMs = null;
    this.lastVehicularFix = null;
    this.candidate = null;    // {fix, atMs, mode}
    this.parked = null;       // confirmed {lat, lon, atMs, accuracy, mode}
    this.peakSpeed = 0;
    this.rejected = 0;
  }

  /** Speed for a fix: trust the device if it reports one, else derive it. */
  _speedFor(fix, prev) {
    if (typeof fix.speed === 'number' && fix.speed >= 0 && Number.isFinite(fix.speed)) {
      return fix.speed;
    }
    if (!prev) return 0;
    const dt = (fix.t - prev.t) / 1000;
    if (dt <= 0) return 0;
    const d = haversine(prev, fix);
    // A jump that implies > 60 m/s is GPS noise, not teleportation.
    const v = d / dt;
    return v > 60 ? 0 : v;
  }

  _classify(v) {
    if (v >= this.o.vehicularSpeed) return STATE.DRIVING;
    if (v >= this.o.bikeSpeed) return STATE.CYCLING;
    if (v > this.o.stationarySpeed) return STATE.WALKING;
    return STATE.STATIONARY;
  }

  /** Feed one fix: {lat, lon, t (ms epoch), accuracy?, speed?} */
  push(fix) {
    if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || !Number.isFinite(fix.t)) return;
    if (Number.isFinite(fix.accuracy) && fix.accuracy > this.o.accuracyLimitM) {
      this.rejected++;
      return;                               // too vague to reason about
    }
    const prev = this.fixes[this.fixes.length - 1];
    if (prev && fix.t <= prev.t) return;    // out-of-order fix

    const raw = this._speedFor(fix, prev);
    this.fixes.push(fix);
    this.speeds.push(raw);
    if (this.fixes.length > 600) { this.fixes.shift(); this.speeds.shift(); }

    const v = median(this.speeds.slice(-this.o.smoothWindow));
    const next = this._classify(v);
    const vehicular = next === STATE.DRIVING || next === STATE.CYCLING;

    if (next !== this.state) {
      this.state = next;
      this.onEvent({ type: 'state', state: next, speed: v, t: fix.t });
    }
    this.peakSpeed = Math.max(this.peakSpeed, v);

    if (vehicular) {
      this.lastVehicularFix = fix;
      if (this.movingSinceMs === null) this.movingSinceMs = fix.t;
      // Resuming vehicular motion invalidates any pending stop — red light, not parking.
      if (this.candidate) {
        this.onEvent({ type: 'cancel', reason: 'resumed vehicular motion', t: fix.t });
        this.candidate = null;
      }
      return;
    }

    // Non-vehicular from here on.
    const movedLongEnough = this.movingSinceMs !== null &&
      this.lastVehicularFix && (this.lastVehicularFix.t - this.movingSinceMs) >= this.o.minMovingMs;

    // A bout too short to count is over: forget it, or the next short bout minutes
    // later measures "moving" from this one and passes the minMovingMs test. On real
    // GPS (projects/park-eval) that summing of noise spikes was a third of all false
    // parks during walks.
    if (!this.candidate && !movedLongEnough && this.movingSinceMs !== null) {
      this.movingSinceMs = null;
      this.lastVehicularFix = null;
      this.peakSpeed = 0;
    }

    if (!this.candidate && movedLongEnough && this.lastVehicularFix) {
      this.candidate = {
        fix: this.lastVehicularFix,
        atMs: this.lastVehicularFix.t,
        mode: this.peakSpeed >= this.o.vehicularSpeed ? 'car' : 'bike',
      };
      this.onEvent({ type: 'candidate', at: this.candidate, t: fix.t });
    }

    if (this.candidate) {
      const age = fix.t - this.candidate.atMs;
      const away = haversine(this.candidate.fix, fix);
      const gap = prev ? fix.t - prev.t : 0;
      if (gap > this.o.maxFixGapMs) {
        this.onEvent({
          type: 'cancel',
          reason: `gap of ${Math.round(gap / 60000)} min in fixes — cannot vouch for it`,
          t: fix.t,
        });
        // Everything learned before the hole is now untrustworthy. Clearing the
        // candidate alone is not enough: a stale lastVehicularFix would let the very
        // next fix rebuild the same candidate and confirm it instantly, since by then
        // both the age and the walk-away distance are trivially satisfied.
        this.candidate = null;
        this.lastVehicularFix = null;
        this.movingSinceMs = null;
        this.peakSpeed = 0;
      } else if (age >= this.o.confirmParkMs && away >= this.o.walkAwayM) {
        // Stopped long enough AND physically left the vehicle.
        this.parked = {
          lat: this.candidate.fix.lat,
          lon: this.candidate.fix.lon,
          accuracy: this.candidate.fix.accuracy ?? null,
          atMs: this.candidate.atMs,
          mode: this.candidate.mode,
          confirmedAtMs: fix.t,
          walkedAwayM: Math.round(away),
        };
        this.onEvent({ type: 'park', at: this.parked, t: fix.t });
        this.candidate = null;
        this.movingSinceMs = null;
        this.lastVehicularFix = null;
        this.peakSpeed = 0;
      }
    }
  }

  /** Where is it, and which way do I walk? */
  guidance(from) {
    if (!this.parked || !from) return null;
    return {
      distanceM: Math.round(haversine(from, this.parked)),
      bearingDeg: Math.round(bearing(from, this.parked)),
      parked: this.parked,
    };
  }
}
