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
