/* Synthetic-trace tests for the parking detector.
 * Run: node test.mjs
 *
 * Each trace is a scripted walk/drive. The point is the negative cases: a detector
 * that fires on a red light is worse than useless, because you would trust it.
 */
import { ParkingDetector, haversine, bearing, headingFrom, turnTo, walkLink, sampleBestFix, screenKeeper, placeLabel, DEFAULTS } from './detector.js';
import { LANDMARKS } from './landmarks.js';
import { zoneAt, zoneLine, ruleNow, stanfordClock, RULES, SHARED, hoursFree, freeLots, holidayNote, HOLIDAYS } from './zone.js';
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

  r = rig(); r.run(); r.fix(15);
  check('a 15 m fix is good enough at once', r.out.got?.coords.accuracy === 15);
  r = rig(); r.run(); r.fix(15.5); r.advance(4999);
  check('a 15.5 m fix waits, and the window is 5 s, not a ms more', r.out.got === null);
  r.advance(1);
  check('... and closes at 5000 ms', r.out.got?.coords.accuracy === 15.5);
}

console.log('\n12. thresholds stood on exactly, and the median (bin/mutate survivors, 2026-10-26)');
{
  // rows: [seconds, metres east of ORIGIN, device speed]. smoothWindow 1 makes the speed
  // the classifier sees the raw one, so every threshold below is met exactly, not about.
  const seq = (rows, opts = {}) => run(rows.map(([s, m, v]) => ({ ...offset(ORIGIN, m, 90), t: T0 + s * 1000, accuracy: 10, speed: v })),
    { smoothWindow: 1, ...opts });
  const drive = n => Array.from({ length: n + 1 }, (_, i) => [i, i * 10, 10]);       // n seconds at 10 m/s
  const stopAt = n => [n + 1, n * 10, 0];
  const cands = r => r.events.filter(e => e.type === 'candidate').length;
  check('a drive of exactly minMovingMs (25 s) can be a park, 24 s cannot',
    cands(seq([...drive(25), stopAt(25)])) === 1 && cands(seq([...drive(24), stopAt(24)])) === 0);
  const walkOff = (n, upTo) => Array.from({ length: upTo - n }, (_, i) => [n + 1 + i, n * 10 + 1.5 * (i + 1), 1.5]);
  const conf = seq([...drive(30), ...walkOff(30, 140)]);
  check('a park confirms at exactly confirmParkMs (75 s) after the stop',
    conf.parks.length === 1 && conf.parks[0].at.confirmedAtMs - conf.parks[0].at.atMs === 75_000,
    String(conf.parks[0] && conf.parks[0].at.confirmedAtMs - conf.parks[0].at.atMs));
  // A grid sweep of random traces found this one: '&&' -> '||' re-announced the same stop on
  // every fix while it waited for the walk-away. 110 fixes of walking, one candidate.
  check('a pending stop is announced once, not once per fix', cands(conf) === 1, String(cands(conf)));
  const standAt = (n, m) => [[n + 1, n * 10, 0], [n + 90, n * 10 + m, 0]];
  check('walkAwayM is 25 m: 25.5 m away confirms, 24.5 m does not',
    seq([...drive(30), ...standAt(30, 25.5)]).parks.length === 1 && seq([...drive(30), ...standAt(30, 24.5)]).parks.length === 0);
  const gapThen = (n, sec) => [[n + 1, n * 10, 0], [n + 1 + sec, n * 10 + 100, 1]];
  check('a hole of exactly 15 min is still trusted; 15.5 min is not',
    seq([...drive(30), ...gapThen(30, 900)]).parks.length === 1 && seq([...drive(30), ...gapThen(30, 930)]).parks.length === 0);
  const ride = v => [...Array.from({ length: 31 }, (_, i) => [i, i * v, v]), ...Array.from({ length: 110 }, (_, k) => [31 + k, 30 * v + 1.5 * (k + 1), 1.5])];
  check('peak speed exactly vehicularSpeed (6 m/s) is a car, 5.9 a bike',
    seq(ride(6)).parks[0]?.at.mode === 'car' && seq(ride(5.9)).parks[0]?.at.mode === 'bike',
    `${seq(ride(6)).parks[0]?.at.mode}/${seq(ride(5.9)).parks[0]?.at.mode}`);
  const c = new ParkingDetector();
  check('classify on the thresholds: 6 drives, 2.8 cycles, 0.6 is stationary',
    c._classify(6) === 'driving' && c._classify(2.8) === 'cycling' && c._classify(0.6) === 'stationary');
  const acc = new ParkingDetector();
  acc.push({ ...ORIGIN, t: T0, accuracy: 60.5 }); acc.push({ ...ORIGIN, t: T0 + 1000, accuracy: 60 });
  check('the accuracy limit is 60 m (literal, not read back from DEFAULTS)', acc.rejected === 1 && acc.fixes.length === 1);
  // The median, four speeds handed over out of order: [4, 1, 12, 8] -> (4 + 8) / 2. Unsorted
  // it would be (1 + 12) / 2 = 6.5 -- and [4, 1, 12, 9] gives 6.5 both ways, so it tested nothing.
  const med = new ParkingDetector();
  [4, 1, 12, 8].forEach((v, i) => med.push({ ...ORIGIN, t: T0 + i * 1000, speed: v }));
  check('median of an even window averages the middle two of the SORTED speeds', med.peakSpeed === 6, String(med.peakSpeed));
  const win = new ParkingDetector();
  [0, 0, 0, 9, 9, 9].forEach((v, i) => win.push({ ...ORIGIN, t: T0 + i * 1000, speed: v }));
  check('the speed window is 5 fixes: three 9s after three 0s already read as driving', win.state === 'driving', win.state);
  const s = new ParkingDetector(), a = { ...ORIGIN, t: T0 };
  check('derived speed is exact: 10 m in 1 s is 10 m/s', Math.abs(s._speedFor({ ...offset(ORIGIN, 10, 90), t: T0 + 1000 }, a) - 10) < 1e-6);
  check('derived speed at 2 Hz: 5 m in 0.5 s is 10 m/s, not 0', Math.abs(s._speedFor({ ...offset(ORIGIN, 5, 90), t: T0 + 500 }, a) - 10) < 1e-6);
  check('derived speed: a first fix, or a repeat time, is 0 (never NaN or 1)',
    s._speedFor({ ...ORIGIN, t: T0 }) === 0 && s._speedFor({ ...ORIGIN, t: T0 }, a) === 0);
  check('bearing (0,0) -> (1,1) is 44.9956364553 deg (Python, independently)', Math.abs(bearing({ lat: 0, lon: 0 }, { lat: 1, lon: 1 }) - 44.99563645534488) < 1e-9);
  check('iOS heading 360 is north, 0', headingFrom({ webkitCompassHeading: 360 }) === 0);
  check('turnTo from a NaN needle snaps to the target', turnTo(NaN, 90) === 90);
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

  r = rig(); r.show(); await tick();
  check('coming back to the page before any hold() takes no lock', r.nav.asked === 0 && !r.k.held);

  r = rig(); r.k.hold(); r.k.hold(); r.show(); await tick();
  check('a second hold while the first request is in flight does not ask again (no leaked lock)', r.nav.asked === 1 && r.nav.locks.length === 1);

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
  const o = (m, b) => offset({ lat: n[0], lon: n[1] }, m, b);
  check('placeLabel: "at" means under 15 m', placeLabel(o(14.5, 0), L) === 'at North Hall' && placeLabel(o(15.5, 0), L) === '15 m N of North Hall');
  check('placeLabel: 80 m is the edge', placeLabel(o(79.5, 0), L) === '80 m N of North Hall' && placeLabel(o(80.5, 0), L) === null);
  check('placeLabel: 160 deg reads S and 350 deg reads N (the bins wrap)',
    placeLabel(o(40, 160), L) === '40 m S of North Hall' && placeLabel(o(40, 350), L) === '40 m N of North Hall');
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

  // freeLots: the inverse question, "where may I park right now with no permit?"
  check('hoursFree: 0 while enforced', hoursFree(P, stanfordClock(MON_10AM)) === 0);
  check('hoursFree: Sat noon to Mon 6 am is 42 h', hoursFree(P, stanfordClock(SAT_NOON)) === 42);
  check('hoursFree: 24/7 is never free', hoursFree(RULES.always, stanfordClock(SAT_NOON)) === 0);
  const sq = (lat, lon, d = 0.0005) => [[lat, lon], [lat, lon + d], [lat + d, lon + d], [lat + d, lon]];
  const near = { lat: 37.4300, lon: -122.1700 };
  const FL = [
    ['C', 'Far C', [sq(37.4300, -122.1500)]],           // ~1.75 km east: past maxM
    ['ACV', 'Garage', [sq(37.4310, -122.1700)]],         // ~140 m north
    ['C', 'Close C', [sq(37.4302, -122.1702)]],          // ~40 m
    ['T', 'Twenty', [sq(37.4301, -122.1701)]],           // 20-min only
    ['C', 'Resident', [sq(SHARED[1].lat - 0.00025, SHARED[1].lon - 0.00025)]],
  ];
  const fs = freeLots(near, { lots: FL }, SAT_NOON);
  check('freeLots: weekend returns nearest first, drops far, 20-min and shared lots',
    fs.map(r => r.lot).join() === 'Close C,Garage');
  check('freeLots: a garage reports the kind free longest (visitor to Mon 8 > permit to Mon 6)',
    fs[1].kind === 'visitor' && fs[1].text === 'not enforced until Mon 8 am');
  const f10 = freeLots(near, { lots: FL }, MON_10AM);
  check('freeLots: weekday 10 am, nothing is free, but 3 lots were in range (shared not counted)', f10.length === 0 && f10.nearby === 3);
  const f7 = freeLots(near, { lots: FL }, MON_7AM);
  check('freeLots: 7 am Monday only visitor spaces are free', f7.length === 1 && f7[0].lot === 'Garage' && f7[0].kind === 'visitor');
  check('freeLots: C lots free after 4 pm say tomorrow 6 am', freeLots(near, { lots: FL }, MON_5PM)[0].text === 'not enforced until tomorrow 6 am');
  check('freeLots: bad coords -> []', freeLots({ lat: NaN, lon: 0 }, { lots: FL }).length === 0 && freeLots(null, { lots: FL }).length === 0);
  check('freeLots: limit caps the list', freeLots(near, { lots: FL }, SAT_NOON, { limit: 1 }).length === 1);
  const quad = { lat: 37.4275, lon: -122.1697 };
  const realSat = freeLots(quad, real, SAT_NOON);
  check('real data: Saturday noon at the Quad finds 5 free lots, all within 1.5 km',
    realSat.length === 5 && realSat.every(r => r.m <= 1500) && realSat.every((r, i, a) => !i || a[i - 1].m <= r.m));
  check('real data: Monday 10 am at the Quad finds none', freeLots(quad, real, MON_10AM).length === 0);
  check('real data: Palo Alto airport finds none, and no lot in range', freeLots({ lat: 37.4611, lon: -122.1150 }, real, SAT_NOON).nearby === 0);

  // Holidays: "enforcement remains as posted, including winter closure, except on university
  // holidays". PST is UTC-8 from Nov 1.
  const THANKS_10AM = at('2026-11-26T18:00:00Z'), THANKS_5PM = at('2026-11-27T01:00:00Z'),
    BLACKFRI = at('2026-11-27T18:00:00Z'), WED_BEFORE_5PM = at('2026-11-26T01:00:00Z'),
    CLOSURE_TUE = at('2026-12-22T18:00:00Z'), DEC23_5PM = at('2026-12-24T01:00:00Z'),
    XMAS = at('2026-12-25T18:00:00Z'), NYE_5PM = at('2027-01-01T01:00:00Z'),
    THANKS_2028 = at('2028-11-23T18:00:00Z');
  check('stanfordClock: carries the Stanford date, not the UTC one', stanfordClock(WED_BEFORE_5PM).ymd === '2026-11-25');
  check('holiday: Thanksgiving 10 am, permit is off until Mon 6 am and says why',
    ruleNow(P, stanfordClock(THANKS_10AM)).on === false
    && ruleNow(P, stanfordClock(THANKS_10AM)).text === 'not enforced until Mon 6 am (university holiday)');
  check('holiday: Oval and visitor are lifted too', !ruleNow(RULES.oval, stanfordClock(THANKS_10AM)).on && !ruleNow(RULES.visitor, stanfordClock(BLACKFRI)).on);
  check('holiday: the day before skips Thu+Fri to Mon, with no holiday tag today',
    ruleNow(P, stanfordClock(WED_BEFORE_5PM)).text === 'not enforced until Mon 6 am');
  check('holiday: hoursFree Wed 5 pm before Thanksgiving is 109 h (to Mon 6 am)', hoursFree(P, stanfordClock(WED_BEFORE_5PM)) === 109);
  check('holiday: shared and resident lots keep their hours', ruleNow(RULES.evening, stanfordClock(THANKS_5PM)).on && ruleNow(RULES.always, stanfordClock(THANKS_10AM)).on);
  check('holiday: winter closure is NOT a holiday (the 2019 r/stanford question)', ruleNow(P, stanfordClock(CLOSURE_TUE)).text === 'enforced until 4 pm');
  check('holiday: Dec 23 5 pm skips Dec 24-25 to Mon 6 am', ruleNow(P, stanfordClock(DEC23_5PM)).text === 'not enforced until Mon 6 am');
  check('holiday: Dec 31 5 pm skips Jan 1 to Mon 6 am', ruleNow(P, stanfordClock(NYE_5PM)).text === 'not enforced until Mon 6 am');
  check('holiday: past the published list it says enforced (safe)', ruleNow(P, stanfordClock(THANKS_2028)).on === true);
  check('holiday: a clock with no date has no holidays', ruleNow(P, { day: 4, hour: 10 }).on === true);
  check('holiday: zoneLine on Thanksgiving', zoneLine({ types: 'C', lot: 'x' }, THANKS_10AM) === 'C permit · not enforced until Mon 6 am (university holiday)');
  const ft = freeLots(near, { lots: FL }, THANKS_10AM);
  check('holiday: freeLots on Thanksgiving 10 am lists what Monday 10 am does not',
    ft.map(r => r.lot).join() === 'Close C,Garage' && ft[1].kind === 'visitor');
  check('holiday: real data, the Quad on Thanksgiving 10 am finds 5 free lots', freeLots(quad, real, THANKS_10AM).length === 5);
  check('holidayNote: Thanksgiving', holidayNote(THANKS_10AM) === 'Thanksgiving: permit, Oval and visitor parking not enforced today');
  check('holidayNote: the Friday after', holidayNote(BLACKFRI) === 'The Friday after Thanksgiving: permit, Oval and visitor parking not enforced today');
  check('holidayNote: Christmas', holidayNote(XMAS).startsWith('The winter holiday: '));
  check('holidayNote: closure names the holidays inside it',
    holidayNote(CLOSURE_TUE) === 'Winter closure: enforced as posted, except university holidays Dec 24, Dec 25 and Jan 1');
  check('holidayNote: an ordinary day is null', holidayNote(MON_10AM) === null && holidayNote(SAT_NOON) === null);
  // Mutation-audit, 2026-10-26: the checks above never stood on a boundary (6:00 sharp,
  // 4 pm sharp, 2 am sharp), never asked about Thursday or Sunday, and only tested inRing
  // on a rectangle, whose crossing formula is constant. Each line below killed a survivor.
  const T = iso => stanfordClock(at(iso));
  check('boundary: permit is on at 6:00 sharp, off at 4:00 pm sharp',
    ruleNow(P, T('2026-10-26T13:00:00Z')).text === 'enforced until 4 pm'
    && ruleNow(P, T('2026-10-26T23:00:00Z')).text === 'not enforced until tomorrow 6 am');
  check('boundary: overnight rule is off at 2:00 am sharp, and on (not just labelled) at 1 am',
    ruleNow(RULES.evening, T('2026-10-27T09:00:00Z')).on === false && ruleNow(RULES.evening, stanfordClock(TUE_1AM)).on === true);
  check('boundary: Oval on at 6:30 am, off at 6:30 pm; visitor off at 4:30 pm',
    ruleNow(RULES.oval, T('2026-10-26T13:30:00Z')).on && ruleNow(RULES.oval, T('2026-10-27T01:30:00Z')).text === 'not enforced until tomorrow 6 am'
    && ruleNow(RULES.visitor, T('2026-10-26T23:30:00Z')).text === 'not enforced until tomorrow 8 am');
  const week = ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'];
  check('every day: permit on 10 am Mon-Fri only',
    week.map(d => ruleNow(P, T(d + 'T17:00:00Z')).on ? 1 : 0).join('') === '0111110');
  check('every day: the evening rule is on at 5 pm all seven days, and runs past midnight into each',
    ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'].every(d => ruleNow(RULES.evening, T(d + 'T00:00:00Z')).on)
    && week.every(d => ruleNow(RULES.evening, T(d + 'T08:00:00Z')).on));
  check('weekday math: Saturday before MLK Day waits for Tuesday', ruleNow(P, T('2026-01-17T20:00:00Z')).text === 'not enforced until Tue 6 am'
    && hoursFree(P, T('2026-01-17T20:00:00Z')) === 66);
  check('hoursFree: 5 am Monday is 1 h, not 25', hoursFree(P, stanfordClock(MON_5AM)) === 1);
  const friNight = { label: 'x', days: [5], from: 20, to: 26 };
  check('overnight rule that starts Friday is on at 1 am Saturday, off at 1 am Friday',
    ruleNow(friNight, T('2026-10-31T08:00:00Z')).on === true && ruleNow(friNight, T('2026-10-30T08:00:00Z')).on === false);
  check('a once-a-week rule a week out names the date, not the weekday',
    ruleNow({ label: 'x', days: [1], from: 6, to: 16 }, stanfordClock(MON_5PM)).text === 'not enforced until Nov 2 6 am');
  check('a rule with no days is never on and never free-until',
    JSON.stringify(ruleNow({ label: 'x', days: [], from: 6, to: 16 }, stanfordClock(MON_5PM))) === '{"on":false,"text":"not enforced"}'
    && hoursFree({ label: 'x', days: [], from: 6, to: 16 }, stanfordClock(MON_5PM)) === Infinity);
  const tri = [[37.4200, -122.1700], [37.4200, -122.1600], [37.4300, -122.1700]];   // hypotenuse lat = 37.43 - (lon + 122.17)
  const zt = { markers: [], lots: [['C', 'Tri', [tri]]], shared: [] };
  check('zoneAt: a slanted lot edge is honoured on both sides',
    zoneAt({ lat: 37.4270, lon: -122.1680 }, zt)?.lot === 'Tri' && zoneAt({ lat: 37.4290, lon: -122.1680 }, zt) === null
    && zoneAt({ lat: 37.4210, lon: -122.1620 }, zt)?.lot === 'Tri' && zoneAt({ lat: 37.4210, lon: -122.1595 }, zt) === null);
  // On a vertex's exact meridian the crossing test must stay half-open: '>=' on either side
  // made every point due south of a real lot read as inside it (found by a grid sweep).
  check('zoneAt: a point on a vertex\'s meridian, outside the lot, is outside',
    [-122.1700, -122.1600].every(o => zoneAt({ lat: 37.4100, lon: o }, zt) === null && zoneAt({ lat: 37.4400, lon: o }, zt) === null));
  const m0 = { lat: 37.4000, lon: -122.1600 };
  const zm = { markers: [[m0.lat, m0.lon, 'C']], lots: [], shared: [] };
  check('zoneAt: street markers count to 40 m and no further', zoneAt(offset(m0, 39.5, 90), zm)?.types === 'C' && zoneAt(offset(m0, 40.5, 90), zm) === null);
  // Literal radii: reading s.r back out of SHARED would move with a mutated table.
  check('zoneAt: each shared lot\'s radius is the published one (90, 60, 70, 80 m)',
    SHARED.length === 4 && [90, 60, 70, 80].every((r, i) => zoneAt(offset(SHARED[i], r - 0.5, 0), { markers: [], lots: [] })?.shared === SHARED[i]
      && zoneAt(offset(SHARED[i], r + 0.5, 0), { markers: [], lots: [], shared: [SHARED[i]] }) === null));
  check('zoneLine: the Blackwelder lot reads the C-evening rule',
    zoneLine(zoneAt(SHARED[0], { markers: [], lots: [] }), MON_5PM) === "Blackwelder / EVGR-A shared lot · 'C' enforced until 2 am");
  const box = (q, d = 0.0002) => [[q.lat - d, q.lon - d], [q.lat - d, q.lon + d], [q.lat + d, q.lon + d], [q.lat + d, q.lon - d]];
  const edge = freeLots(near, { lots: [['C', 'In', [box(offset(near, 1499.5, 0))]], ['C', 'Out', [box(offset(near, 1500.5, 0))]]], shared: [] }, SAT_NOON);
  check('freeLots: 1.5 km means 1499.5 m in, 1500.5 m out', edge.map(r => r.lot).join() === 'In' && edge.nearby === 1);
  const six = [600, 100, 500, 200, 400, 300].map(mm => ['C', 'L' + mm, [box(offset(near, mm, 0))]]);
  check('freeLots: the default list is 5 long, nearest first from scrambled input',
    freeLots(near, { lots: six, shared: [] }, SAT_NOON).map(r => r.lot).join() === 'L100,L200,L300,L400,L500');
  check('freeLots: a permit-only multi-type lot names its permit letters',
    freeLots(near, { lots: [['ACT', 'Mixed', [box(offset(near, 50, 0))]]], shared: [] }, SAT_NOON)[0]?.kind === 'A/C permit');
  check('holidayNote: first day of the closure is a closure day', holidayNote(at('2026-12-21T18:00:00Z')).startsWith('Winter closure:'));
  check('holidayNote: two holidays read "X and Y", none reads nothing',
    holidayNote(CLOSURE_TUE, { closures: [['2026-12-21', '2026-12-31']] }) === 'Winter closure: enforced as posted, except university holidays Dec 24 and Dec 25'
    && holidayNote(CLOSURE_TUE, { closures: [['2026-12-21', '2026-12-24']] }) === 'Winter closure: enforced as posted, except university holidays Dec 24'
    && holidayNote(CLOSURE_TUE, { closures: [['2026-12-21', '2026-12-23']] }) === 'Winter closure: enforced as posted');
  check('holidayNote: a closure includes its last day and a holiday on its first',
    holidayNote(at('2026-12-23T18:00:00Z'), { closures: [['2026-12-21', '2026-12-23']] }) === 'Winter closure: enforced as posted'
    && holidayNote(at('2026-12-28T18:00:00Z'), { closures: [['2026-12-24', '2026-12-31']] }) === 'Winter closure: enforced as posted, except university holidays Dec 24 and Dec 25');
  check('overnight: a rule ending at 1 am is on at 0:30',
    ruleNow({ label: 'x', days: [0, 1, 2, 3, 4, 5, 6], from: 20, to: 25 }, T('2026-10-27T07:30:00Z')).on === true);
  check('overnight: a holiday-lifted night rule stays lifted past midnight, and only that night',
    ruleNow({ label: 'x', days: [1, 2, 3, 4, 5], from: 20, to: 26, holidays: true }, T('2026-11-27T09:00:00Z')).on === false
    && ruleNow({ label: 'x', days: [1, 2, 3, 4, 5], from: 20, to: 26, holidays: true }, T('2026-11-26T09:00:00Z')).on === true);
  check('HOLIDAYS: 20 dates, all valid, all weekdays', HOLIDAYS.size === 20
    && [...HOLIDAYS.keys()].every(d => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w >= 1 && w <= 5; }));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
