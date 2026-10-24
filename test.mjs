/* Synthetic-trace tests for the parking detector.
 * Run: node test.mjs
 *
 * Each trace is a scripted walk/drive. The point is the negative cases: a detector
 * that fires on a red light is worse than useless, because you would trust it.
 */
import { ParkingDetector, haversine, bearing, headingFrom, turnTo, walkLink, sampleBestFix, screenKeeper, placeLabel, DEFAULTS } from './detector.js';
import { LANDMARKS } from './landmarks.js';
import { zoneAt, zoneLine, ruleNow, stanfordClock, RULES, SHARED } from './zone.js';
import { MARKERS, LOTS } from './zones.js';

const ORIGIN = { lat: 37.4275, lon: -122.1697 };   // Stanford-ish
let T0 = 1_700_000_000_000;

/** Move `metres` along `bearingDeg` from a point. */
function offset(p, metres, bearingDeg) {
  const R = 6_371_000, br = (bearingDeg * Math.PI) / 180;
  const lat = (p.lat * Math.PI) / 180, lon = (p.lon * Math.PI) / 180;
  const l2 = Math.asin(Math.sin(lat) * Math.cos(metres / R) +
    Math.cos(lat) * Math.sin(metres / R) * Math.cos(br));
  const o2 = lon + Math.atan2(Math.sin(br) * Math.sin(metres / R) * Math.cos(lat),
    Math.cos(metres / R) - Math.sin(lat) * Math.sin(l2));
  return { lat: (l2 * 180) / Math.PI, lon: (o2 * 180) / Math.PI };
}

/** Build fixes: a sequence of legs {speed (m/s), seconds, bearing?, jitter?}. */
function trace(legs, { hz = 1, accuracy = 10, reportSpeed = true } = {}) {
  let pos = { ...ORIGIN }, t = T0, out = [];
  for (const leg of legs) {
    const steps = Math.round(leg.seconds * hz);
    for (let i = 0; i < steps; i++) {
      const dt = 1 / hz;
      pos = leg.speed > 0 ? offset(pos, leg.speed * dt, leg.bearing ?? 90) : pos;
      t += dt * 1000;
      const p = { lat: pos.lat, lon: pos.lon, t, accuracy };
      if (leg.jitter) {                       // simulate a bad fix
        const j = offset(p, leg.jitter, (i * 73) % 360);
        p.lat = j.lat; p.lon = j.lon; p.accuracy = leg.jitterAccuracy ?? accuracy;
      }
      if (reportSpeed) p.speed = leg.speed;
      out.push(p);
    }
  }
  return out;
}

function run(fixes, opts = {}) {
  const events = [];
  const d = new ParkingDetector(opts, e => events.push(e));
  for (const f of fixes) d.push(f);
  return { d, events, parks: events.filter(e => e.type === 'park') };
}

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`); }
}

console.log('\n1. drive 5 min, stop, walk away 100 m  -> should detect a car park');
{
  const f = trace([
    { speed: 13, seconds: 300, bearing: 90 },   // ~47 km/h
    { speed: 0,  seconds: 30 },                 // park, gather things
    { speed: 1.4, seconds: 120, bearing: 0 },   // walk off at ~5 km/h
  ]);
  const { parks, d } = run(f);
  check('exactly one park detected', parks.length === 1, `got ${parks.length}`);
  check('mode is car', parks[0]?.at.mode === 'car', parks[0]?.at.mode);
  const err = parks[0] ? haversine(parks[0].at, f[299]) : Infinity;
  check('park location within 30 m of the real stop', err < 30, `${err.toFixed(1)} m`);
  check('guidance reports a sane distance',
    (d.guidance(f[f.length - 1])?.distanceM ?? 0) > 80);
}

console.log('\n2. red light: drive, stop 45 s, drive on  -> must NOT detect');
{
  const { parks } = run(trace([
    { speed: 13, seconds: 240, bearing: 90 },
    { speed: 0,  seconds: 45 },
    { speed: 13, seconds: 240, bearing: 90 },
  ]));
  check('no park detected', parks.length === 0, `got ${parks.length}`);
}

console.log('\n3. stopped 20 min but never left the vehicle  -> must NOT detect');
{
  const { parks, events } = run(trace([
    { speed: 13, seconds: 300, bearing: 90 },
    { speed: 0,  seconds: 1200 },              // waiting in the car
  ]));
  check('no park detected (no displacement)', parks.length === 0, `got ${parks.length}`);
  check('a candidate stays pending while fixes keep arriving',
    events.some(e => e.type === 'candidate') && !events.some(e => e.type === 'cancel'));
}

console.log('\n3b. sat in the car 20 min, THEN walked away  -> should detect');
{
  const f = trace([
    { speed: 13, seconds: 300, bearing: 90 },
    { speed: 0,  seconds: 1200 },              // long phone call
    { speed: 1.4, seconds: 120, bearing: 0 },  // finally walk off
  ]);
  const { parks } = run(f);
  check('park detected after a long sit', parks.length === 1, `got ${parks.length}`);
  const err = parks[0] ? haversine(parks[0].at, f[299]) : Infinity;
  check('still pinned to the stop point', err < 30, `${err.toFixed(1)} m`);
}

console.log('\n3c. stop, then a 20 min hole in the fixes, then walking far away -> must NOT detect');
{
  const f = trace([
    { speed: 13, seconds: 300, bearing: 90 },
    { speed: 0,  seconds: 30 },
  ]);
  const last = f[f.length - 1];
  // app backgrounded: next fix arrives 20 minutes later, 300 m away on foot
  const far = offset(last, 300, 45);
  f.push({ lat: far.lat, lon: far.lon, t: last.t + 20 * 60_000, accuracy: 10, speed: 1.4 });
  f.push({ lat: far.lat, lon: far.lon, t: last.t + 20 * 60_000 + 60_000, accuracy: 10, speed: 1.4 });
  const { parks, events } = run(f);
  check('no park detected across the data hole', parks.length === 0, `got ${parks.length}`);
  check('cancelled with a gap reason',
    events.some(e => e.type === 'cancel' && /gap of/.test(e.reason)));
}

console.log('\n4. stop-and-go traffic jam  -> must NOT detect');
{
  const legs = [];
  for (let i = 0; i < 12; i++) {
    legs.push({ speed: 8, seconds: 20, bearing: 90 }, { speed: 0, seconds: 40 });
  }
  const { parks } = run(trace(legs));
  check('no park detected', parks.length === 0, `got ${parks.length}`);
}

console.log('\n5. bike ride then lock up  -> detect, mode bike');
{
  const f = trace([
    { speed: 4.5, seconds: 400, bearing: 45 },  // ~16 km/h, cycling band
    { speed: 0,   seconds: 40 },
    { speed: 1.3, seconds: 120, bearing: 200 },
  ]);
  const { parks } = run(f);
  check('one park detected', parks.length === 1, `got ${parks.length}`);
  check('mode is bike', parks[0]?.at.mode === 'bike', parks[0]?.at.mode);
}

console.log('\n6. walking only, never vehicular  -> must NOT detect');
{
  const { parks } = run(trace([{ speed: 1.4, seconds: 900, bearing: 90 }]));
  check('no park detected', parks.length === 0, `got ${parks.length}`);
}

console.log('\n7. GPS noise: low-accuracy spikes during the drive  -> still detects');
{
  const f = trace([
    { speed: 13, seconds: 150, bearing: 90 },
    { speed: 13, seconds: 30, bearing: 90, jitter: 120, jitterAccuracy: 300 }, // junk fixes
    { speed: 13, seconds: 120, bearing: 90 },
    { speed: 0,  seconds: 30 },
    { speed: 1.4, seconds: 120, bearing: 0 },
  ]);
  const { parks, d } = run(f);
  check('one park detected despite noise', parks.length === 1, `got ${parks.length}`);
  check('bad fixes were rejected', d.rejected >= 25, `rejected ${d.rejected}`);
}

console.log('\n8. device reports no speed field  -> derived from positions');
{
  const f = trace([
    { speed: 13, seconds: 300, bearing: 90 },
    { speed: 0,  seconds: 30 },
    { speed: 1.4, seconds: 120, bearing: 0 },
  ], { reportSpeed: false });
  const { parks } = run(f);
  check('one park detected from derived speed', parks.length === 1, `got ${parks.length}`);
}

console.log('\n9. two trips in one session  -> both detected, latest kept');
{
  const f = trace([
    { speed: 13, seconds: 300, bearing: 90 },
    { speed: 0, seconds: 30 }, { speed: 1.4, seconds: 120, bearing: 0 },
    { speed: 1.4, seconds: 60, bearing: 180 },
    { speed: 13, seconds: 300, bearing: 270 },
    { speed: 0, seconds: 30 }, { speed: 1.4, seconds: 120, bearing: 0 },
  ]);
  const { parks } = run(f);
  check('two parks detected', parks.length === 2, `got ${parks.length}`);
  check('the two are in different places',
    parks.length === 2 && haversine(parks[0].at, parks[1].at) > 100);
}

console.log('\n10. walking only, with brief speed spikes minutes apart  -> no park');
{
  // Found on real GPS (projects/park-eval, GeoLife): a bout of vehicular speed too
  // short to count used to leave movingSinceMs set, so a second short bout minutes
  // later measured "moving" from the FIRST one and passed the 25 s test. Two
  // 10-second blips, five minutes apart, on an ordinary walk.
  const walk = s => ({ speed: 1.3, seconds: s, bearing: 0 });
  const blip = { speed: 8, seconds: 10, bearing: 0 };
  const { parks } = run(trace([walk(120), blip, walk(300), blip, walk(200)]));
  check('no park from summed blips', parks.length === 0, `got ${parks.length}`);
}

// Cases found by bin/mutate (projects/mutation-audit): the trace tests above never
// exercise the input guards, the geometry the guidance arrow uses, or bad device speed.
console.log('\n11. input guards, geometry and device speed (bin/mutate survivors)');
{
  const d = new ParkingDetector();
  const ok = { ...ORIGIN, t: T0, accuracy: 10 };
  d.push(ok);
  d.push({ ...ORIGIN, t: T0 });                       // same timestamp
  d.push({ ...ORIGIN, t: T0 - 1000 });                // earlier
  check('out-of-order and duplicate-time fixes ignored', d.fixes.length === 1, String(d.fixes.length));
  d.push({ lat: NaN, lon: ORIGIN.lon, t: T0 + 1000 });
  d.push({ lat: ORIGIN.lat, lon: undefined, t: T0 + 2000 });
  d.push({ lat: ORIGIN.lat, lon: ORIGIN.lon, t: NaN });
  check('fixes with a non-finite lat, lon or t ignored', d.fixes.length === 1, String(d.fixes.length));
  d.push({ ...ORIGIN, t: T0 + 3000, accuracy: DEFAULTS.accuracyLimitM + 1 });
  check('accuracy worse than the limit rejected and counted', d.fixes.length === 1 && d.rejected === 1);
  d.push({ ...ORIGIN, t: T0 + 4000, accuracy: DEFAULTS.accuracyLimitM });
  check('accuracy exactly at the limit kept', d.fixes.length === 2, String(d.fixes.length));

  const s = new ParkingDetector();
  const a = { ...ORIGIN, t: T0 }, b = { ...offset(ORIGIN, 10, 90), t: T0 + 1000 };
  check('negative device speed falls back to derived (~10 m/s)',
    Math.abs(s._speedFor({ ...b, speed: -1 }, a) - 10) < 0.5, String(s._speedFor({ ...b, speed: -1 }, a)));
  check('device speed 0 is trusted, not derived', s._speedFor({ ...b, speed: 0 }, a) === 0);
  const far = { ...offset(ORIGIN, 61, 90), t: T0 + 1000 };
  check('an implied jump over 60 m/s reads as 0, not teleportation', s._speedFor(far, a) === 0);
  check('a jump just under 60 m/s is kept',
    s._speedFor({ ...offset(ORIGIN, 59, 90), t: T0 + 1000 }, a) > 58);

  const many = new ParkingDetector();
  for (let i = 0; i < 700; i++) many.push({ ...ORIGIN, t: T0 + i * 1000 });
  check('fix buffer capped at 600', many.fixes.length === 600 && many.speeds.length === 600);

  const ev = [];
  const st = new ParkingDetector({}, e => ev.push(e));
  for (let i = 0; i < 10; i++) st.push({ ...ORIGIN, t: T0 + i * 1000, speed: 0 });
  check('a state event fires on change only, not every fix',
    ev.filter(e => e.type === 'state').length === 1, String(ev.filter(e => e.type === 'state').length));

  for (const [deg, name] of [[0, 'north'], [90, 'east'], [180, 'south'], [270, 'west']]) {
    const to = offset(ORIGIN, 200, deg);
    const got = bearing(ORIGIN, to);
    check(`bearing due ${name} is ${deg}`, Math.abs(((got - deg + 540) % 360) - 180) < 0.5, got.toFixed(2));
    check(`haversine 200 m ${name}`, Math.abs(haversine(ORIGIN, to) - 200) < 0.5,
      haversine(ORIGIN, to).toFixed(2));
  }
  check('no guidance before a park', new ParkingDetector().guidance(ORIGIN) === null);
  const { d: parked } = run(trace([{ speed: 13, seconds: 300 }, { speed: 0, seconds: 30 },
                                   { speed: 1.4, seconds: 120, bearing: 0 }]));
  check('no guidance without a position', parked.parked && parked.guidance(null) === null);
  const g = parked.guidance(offset(parked.parked, 150, 0));
  check('guidance points back south, ~150 m', g && Math.abs(g.distanceM - 150) <= 1 && Math.abs(g.bearingDeg - 180) <= 1,
    g && `${g.distanceM} m @ ${g.bearingDeg}`);
}

// Heading from device orientation. iOS Safari (the platform this is installed on) only ever
// sends webkitCompassHeading on plain deviceorientation; reading absolute/alpha alone left
// the arrow north-up on every iPhone.
{
  check('iOS webkitCompassHeading is used as-is', headingFrom({ webkitCompassHeading: 123.5, alpha: 10, absolute: false }) === 123.5);
  check('iOS heading wins over a relative alpha', headingFrom({ webkitCompassHeading: 0, alpha: 270 }) === 0);
  check('iOS uncalibrated (-1) is no heading', headingFrom({ webkitCompassHeading: -1, alpha: 40 }) === null);
  check('iOS NaN heading is no heading', headingFrom({ webkitCompassHeading: NaN }) === null);
  check('absolute alpha 90 (phone faces west) is heading 270', headingFrom({ absolute: true, alpha: 90 }) === 270);
  check('absolute alpha 0 is north, not 360', headingFrom({ absolute: true, alpha: 0 }) === 0);
  check('relative alpha is not a heading', headingFrom({ absolute: false, alpha: 90 }) === null);
  check('null alpha is not a heading', headingFrom({ absolute: true, alpha: null }) === null);
  check('no event, no heading', headingFrom(undefined) === null);
}

// The needle is set to rotate(b - heading). Crossing north moves that by ~360, and
// the CSS transition spins the long way round unless the angle stays unwrapped.
{
  const close = (x, y) => Math.abs(x - y) < 1e-9;
  check('first paint takes the target as-is', turnTo(null, 37) === 37);
  check('359 -> 1 turns +2, not -358', close(turnTo(359, 1), 361));
  check('1 -> 359 turns -2, not +358', close(turnTo(1, 359), -1));
  check('a small step is unchanged', close(turnTo(90, 100), 100));
  check('target 720 away is no turn', close(turnTo(45, 765), 45));
  check('exactly opposite picks one way, not a spin', Math.abs(turnTo(0, 180) - 0) <= 180);
  // Same visible direction as the naive angle, every step <= 180, over a noisy full turn.
  let prev = null, worst = 0, aligned = true, seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 2000; i++) {
    const h = ((i * 0.9 + (rnd() - 0.5) * 8) % 360 + 360) % 360, raw = 200 - h;
    const a = turnTo(prev, raw);
    if (prev != null) worst = Math.max(worst, Math.abs(a - prev));
    if (!close(((a - raw) % 360 + 360) % 360 % 360, 0) && !close(((a - raw) % 360 + 360) % 360, 360)) aligned = false;
    prev = a;
  }
  check('noisy 5-turn trace never steps more than 180', worst <= 180, `worst ${worst.toFixed(1)}`);
  check('unwrapped angle always points where the naive one does', aligned);
}

// The maps link is for walking back, so it must be a route on foot, not a pin.
{
  const spot = { lat: 37.4275, lon: -122.1697 };
  const g = new URL(walkLink(spot, false)), a = new URL(walkLink(spot, true));
  check('google link is the directions action', g.origin + g.pathname === 'https://www.google.com/maps/dir/' && g.searchParams.get('api') === '1');
  check('google link walks', g.searchParams.get('travelmode') === 'walking');
  check('google destination is the spot', g.searchParams.get('destination') === '37.427500,-122.169700');
  check('apple link is the directions action', a.origin + a.pathname === 'https://maps.apple.com/directions');
  check('apple link walks', a.searchParams.get('mode') === 'walking');
  check('apple destination is the spot', a.searchParams.get('destination') === '37.427500,-122.169700');
  check('no origin is sent, the phone supplies it', !g.searchParams.has('origin') && !a.searchParams.has('source'));
  check('southern/western signs survive', new URL(walkLink({ lat: -33.8, lon: -70.1 }, false)).searchParams.get('destination') === '-33.800000,-70.100000');
}

// Manual mark: keep the best fix over a short window, not the first coarse one.
{
  // A fake clock and a fake navigator.geolocation that the test drives by hand.
  function rig() {
    let now = 0, seq = 0; const timers = new Map();
    const setT = (f, ms) => { const id = ++seq; timers.set(id, { at: now + ms, f }); return id; };
    const clearT = id => timers.delete(id);
    const advance = ms => {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].f();
      }
      now = end;
    };
    const geo = { watches: 0, cleared: 0, opts: null, ok: null, bad: null,
      watchPosition(ok, bad, opts) { this.watches++; this.ok = ok; this.bad = bad; this.opts = opts; return 7; },
      clearWatch(id) { if (id === 7) this.cleared++; } };
    const fix = accuracy => geo.ok({ coords: { latitude: 37.4, longitude: -122.1, accuracy }, timestamp: now });
    const out = { got: null, err: null };
    const run = o => sampleBestFix(geo, p => { out.got = p; }, e => { out.err = e; }, { setT, clearT, ...o });
    return { geo, fix, advance, out, run, pending: () => timers.size };
  }

  let r = rig(); r.run();
  r.fix(65); r.advance(1000); r.fix(30); r.advance(1000); r.fix(40);
  check('mark waits out the window instead of taking the first fix', r.out.got === null);
  r.advance(3000);
  check('mark keeps the most accurate fix in the window', r.out.got?.coords.accuracy === 30, `${r.out.got?.coords.accuracy}`);
  check('mark stops watching once done', r.geo.cleared === 1 && r.pending() === 0);
  check('mark asks for high accuracy and no cached fix', r.geo.opts.enableHighAccuracy === true && r.geo.opts.maximumAge === 0);

  r = rig(); r.run(); r.fix(65); r.advance(500); r.fix(9);
  check('a good-enough fix ends the wait early', r.out.got?.coords.accuracy === 9 && r.geo.cleared === 1);
  r.fix(3);
  check('fixes after done are ignored', r.out.got?.coords.accuracy === 9);

  r = rig(); r.run(); r.advance(20000);
  check('no fix at all times out as an error', r.out.err?.code === 3 && r.out.got === null && r.geo.cleared === 1);

  r = rig(); r.run(); r.geo.bad({ code: 1, message: 'denied' });
  check('permission denied is passed through', r.out.err?.code === 1 && r.geo.cleared === 1 && r.pending() === 0);

  r = rig(); r.run(); r.fix(50); r.geo.bad({ code: 2, message: 'lost' });
  check('an error after a fix still saves the best fix', r.out.got?.coords.accuracy === 50 && r.out.err === null);

  r = rig(); r.run(); r.fix(undefined); r.fix(40); r.advance(5000);
  check('a fix with no accuracy loses to one that has it', r.out.got?.coords.accuracy === 40);

  r = rig(); r.run({ windowMs: 5000, timeoutMs: 20000 }); r.advance(18000); r.fix(70); r.advance(2000);
  check('a late first fix is still saved at the cap', r.out.got?.coords.accuracy === 70 && r.pending() === 0);

  r = rig(); const cancel = r.run(); r.fix(60); cancel(); r.advance(10000);
  check('cancel stops without calling back', r.out.got === null && r.out.err === null && r.geo.cleared === 1);
}

// --- screenKeeper: the wake lock must come back after the page was hidden -----------------
{
  const tick = () => new Promise(r => setTimeout(r, 0));
  const rig = ({ refuse = false } = {}) => {
    const doc = { visibilityState: 'visible', fns: [],
      addEventListener(t, f) { if (t === 'visibilitychange') this.fns.push(f); } };
    const nav = { asked: 0, locks: [], wakeLock: { request(kind) {
      nav.asked++;
      if (refuse || kind !== 'screen') return Promise.reject(new Error('NotAllowedError'));
      const l = { released: false, release() { this.released = true; return Promise.resolve(); } };
      nav.locks.push(l); return Promise.resolve(l);
    } } };
    // what the browser does on hide: drop every lock, then tell the page
    const hide = () => { doc.visibilityState = 'hidden'; nav.locks.forEach(l => { l.released = true; }); doc.fns.forEach(f => f()); };
    const show = () => { doc.visibilityState = 'visible'; doc.fns.forEach(f => f()); };
    return { doc, nav, hide, show, k: screenKeeper(nav, doc) };
  };

  let r = rig(); r.k.hold(); await tick();
  check('hold takes a screen lock', r.nav.asked === 1 && r.k.held);

  r = rig(); r.k.hold(); await tick(); r.hide(); await tick(); r.show(); await tick();
  check('the lock is taken again when the page comes back', r.nav.asked === 2 && r.k.held, `asked=${r.nav.asked}`);

  r = rig(); r.k.hold(); await tick(); r.hide(); await tick();
  check('no lock is asked for while hidden', r.nav.asked === 1 && !r.k.held);

  r = rig(); r.k.hold(); await tick(); r.show(); r.show(); await tick();
  check('a visible page that already holds the lock does not ask twice', r.nav.asked === 1);

  r = rig(); r.k.hold(); await tick(); r.k.release(); await tick();
  check('release drops the lock', r.nav.locks[0].released && !r.k.held);

  r = rig(); r.k.hold(); await tick(); r.k.release(); r.hide(); r.show(); await tick();
  check('after release, coming back does not re-take it', r.nav.asked === 1 && !r.k.held);

  r = rig(); r.k.hold(); r.k.release(); await tick();
  check('a lock that lands after release is let go at once', r.nav.locks[0].released && !r.k.held);

  r = rig(); r.doc.visibilityState = 'hidden'; r.k.hold(); await tick(); r.show(); await tick();
  check('hold while hidden takes the lock on return', r.nav.asked === 1 && r.k.held);

  r = rig({ refuse: true }); r.k.hold(); await tick(); r.hide(); r.show(); await tick();
  check('a refused lock is retried on return and never throws', r.nav.asked === 2 && !r.k.held);

  const doc = { visibilityState: 'visible', n: 0, addEventListener() { this.n++; } };
  const k = screenKeeper({}, doc); k.hold(); k.release();
  check('no wakeLock API: hold/release are no-ops and add no listener', doc.n === 0 && !k.held);
}

// --- placeLabel: a building name for the saved spot ---------------------------------
{
  const L = [[37.4300, -122.1700, 'North Hall'], [37.4290, -122.1700, 'South Hall']];
  const n = L[0];
  check('placeLabel: on top of a building is "at <name>"',
    placeLabel({ lat: n[0], lon: n[1] }, L) === 'at North Hall');
  const east = offset({ lat: n[0], lon: n[1] }, 40, 90);
  check('placeLabel: 40 m east reads "40 m E of"', placeLabel(east, L) === '40 m E of North Hall');
  const se = offset({ lat: n[0], lon: n[1] }, 30, 135);
  check('placeLabel: direction is FROM the building TO the spot', placeLabel(se, L) === '30 m SE of North Hall');
  const mid = offset({ lat: 37.4290, lon: -122.1700 }, 20, 0);   // 20 m N of South, ~91 m S of North
  check('placeLabel: picks the nearest, not the first', placeLabel(mid, L) === '20 m N of South Hall');
  check('placeLabel: past maxM says nothing', placeLabel(offset({ lat: n[0], lon: n[1] }, 120, 0), L) === null);
  check('placeLabel: maxM is configurable', placeLabel(offset({ lat: n[0], lon: n[1] }, 120, 0), L, { maxM: 200 }) === '120 m N of North Hall');
  check('placeLabel: no spot / bad coords / no list -> null',
    placeLabel(null, L) === null && placeLabel({ lat: NaN, lon: 1 }, L) === null && placeLabel({ lat: 1, lon: 1 }) === null);
  check('placeLabel: string coords from storage still work', placeLabel({ lat: String(n[0]), lon: String(n[1]) }, L) === 'at North Hall');
  // The real bundled list: a spot outside Green Library resolves to it; Palo Alto airport does not.
  const green = LANDMARKS.find(r => r[2] === 'Cecil H. Green Library');
  check('landmarks.js: bundled list is non-trivial and well-formed',
    LANDMARKS.length > 300 && LANDMARKS.every(r => r.length === 3 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && typeof r[2] === 'string' && /[A-Za-z]/.test(r[2])));
  check('landmarks.js: Green Library is in it', !!green);
  check('placeLabel: on the real list, Green Library labels its own centre', !!green && placeLabel({ lat: green[0], lon: green[1] }, LANDMARKS) === 'at Cecil H. Green Library');
  check('placeLabel: on the real list, Palo Alto airport is unlabelled', placeLabel({ lat: 37.4611, lon: -122.1150 }, LANDMARKS) === null);
}

// --- zone: permit type at the spot, and whether it is enforced now ---------------
{
  // Stanford time, fixed instants. 2026-10-24 is a Saturday; PDT is UTC-7.
  const at = iso => new Date(iso);
  const SAT_NOON = at('2026-10-24T19:00:00Z'), MON_7AM = at('2026-10-26T14:00:00Z'),
    MON_10AM = at('2026-10-26T17:00:00Z'), MON_5PM = at('2026-10-27T00:00:00Z'),
    THU_5PM = at('2026-10-30T00:00:00Z'), MON_5AM = at('2026-10-26T12:00:00Z'),
    TUE_1AM = at('2026-10-27T08:00:00Z'), TUE_3AM = at('2026-10-27T10:00:00Z');
  const c = stanfordClock(SAT_NOON);
  check('stanfordClock: Sat noon Pacific from UTC', c.day === 6 && c.hour === 12);
  check('stanfordClock: ignores the phone zone (DST-aware, Jan is UTC-8)',
    stanfordClock(at('2026-01-05T16:30:00Z')).day === 1 && stanfordClock(at('2026-01-05T16:30:00Z')).hour === 8.5);
  const P = RULES.permit;
  check('ruleNow: permit on a weekday morning', ruleNow(P, stanfordClock(MON_10AM)).text === 'enforced until 4 pm');
  check('ruleNow: permit on Saturday waits for Monday', ruleNow(P, stanfordClock(SAT_NOON)).text === 'not enforced until Mon 6 am');
  check('ruleNow: permit before 6 am says today', ruleNow(P, stanfordClock(MON_5AM)).text === 'not enforced until 6 am');
  check('ruleNow: permit after 4 pm Thu says tomorrow', ruleNow(P, stanfordClock(THU_5PM)).text === 'not enforced until tomorrow 6 am');
  check('ruleNow: the Oval runs to 6 pm (the r/stanford 5 pm ticket)', ruleNow(RULES.oval, stanfordClock(MON_5PM)).on === true
    && ruleNow(RULES.oval, stanfordClock(MON_5PM)).text === 'enforced until 6 pm' && ruleNow(P, stanfordClock(MON_5PM)).on === false);
  check('ruleNow: visitor starts at 8, not 6', ruleNow(RULES.visitor, stanfordClock(MON_7AM)).text === 'not enforced until 8 am');
  check('ruleNow: overnight rule is on at 1 am the next day', ruleNow(RULES.evening, stanfordClock(TUE_1AM)).text === 'enforced until 2 am');
  check('ruleNow: overnight rule off at 3 am, back at 4 pm', ruleNow(RULES.evening, stanfordClock(TUE_3AM)).text === 'not enforced until 4 pm');
  check('ruleNow: 24/7 is always on', ruleNow(RULES.always, stanfordClock(SAT_NOON)).on === true);

  const M = [[37.4000, -122.1600, 'C'], [37.4001, -122.1600, 'V'], [37.4100, -122.1600, 'O']];
  const ring = [[37.4200, -122.1700], [37.4200, -122.1690], [37.4210, -122.1690], [37.4210, -122.1700]];
  const Lt = [['ACV', 'Test Garage', [ring]]];
  const z = { markers: M, lots: Lt, shared: [] };
  check('zoneAt: inside a lot takes the lot\'s whole set', zoneAt({ lat: 37.4205, lon: -122.1695 }, z).types === 'ACV'
    && zoneAt({ lat: 37.4205, lon: -122.1695 }, z).lot === 'Test Garage');
  check('zoneAt: street spot takes markers within 40 m', zoneAt(offset({ lat: 37.4000, lon: -122.1600 }, 25, 270), z).types === 'CV');
  check('zoneAt: nothing within 40 m and no lot -> null', zoneAt(offset({ lat: 37.4000, lon: -122.1600 }, 60, 270), z) === null);
  check('zoneAt: bad coords -> null', zoneAt({ lat: NaN, lon: 0 }, z) === null && zoneAt(null, z) === null);
  const shz = zoneAt({ lat: SHARED[1].lat, lon: SHARED[1].lon }, { markers: M, lots: Lt });
  check('zoneAt: a shared resident lot overrides everything', !!shz && shz.shared === SHARED[1]);
  check('zoneLine: shared 24/7 lot never says "not enforced"', zoneLine(shz, SAT_NOON) === 'Quillen Ct shared lot · resident enforced 24/7');

  check('zoneLine: weekend C lot', zoneLine({ types: 'C', lot: '' }, SAT_NOON) === 'C permit · not enforced until Mon 6 am');
  check('zoneLine: garage lists permit and visitor separately at 7 am',
    zoneLine({ types: 'ACV', lot: 'G' }, MON_7AM) === 'A/C permit · enforced until 4 pm; visitor · not enforced until 8 am');
  check('zoneLine: 20-min only says nothing', zoneLine({ types: 'T', lot: '' }, MON_10AM) === null);
  check('zoneLine: 20-min alongside C is flagged', zoneLine({ types: 'CT', lot: '' }, MON_10AM) === 'C permit · enforced until 4 pm; 20-min spaces as posted');
  check('zoneLine: null zone -> null', zoneLine(null) === null);

  // The real bundled data.
  check('zones.js: markers well-formed, all four kinds present',
    MARKERS.length > 200 && MARKERS.every(m => m.length === 3 && Number.isFinite(m[0]) && /^[ACOVT]$/.test(m[2]))
    && ['A', 'C', 'O', 'V'].every(t => MARKERS.some(m => m[2] === t)));
  check('zones.js: lots carry rings and types', LOTS.length > 40 && LOTS.every(l => /^[ACOVT]+$/.test(l[0]) && l[2].length && l[2][0].length >= 3));
  const ovalA = MARKERS.find(m => m[2] === 'O');
  const real = { markers: MARKERS, lots: LOTS };
  check('real data: an Oval A space reads the 6 pm rule at 5 pm Monday',
    !!ovalA && zoneLine(zoneAt({ lat: ovalA[0], lon: ovalA[1] }, real), MON_5PM) === 'Oval A · enforced until 6 pm');
  check('real data: Palo Alto airport has no zone', zoneAt({ lat: 37.4611, lon: -122.1150 }, real) === null);
  const garage = LOTS.find(l => l[1] === 'Roth Way Garage');
  const cen = garage && garage[2][0].reduce((a, p, i, r) => [a[0] + p[0] / r.length, a[1] + p[1] / r.length], [0, 0]);
  check('real data: inside Roth Way Garage reads its lot set', !!cen && zoneAt({ lat: cen[0], lon: cen[1] }, real)?.lot === 'Roth Way Garage');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
