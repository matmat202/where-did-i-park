/* Synthetic-trace tests for the parking detector.
 * Run: node test.mjs
 *
 * Each trace is a scripted walk/drive. The point is the negative cases: a detector
 * that fires on a red light is worse than useless, because you would trust it.
 */
import { ParkingDetector, haversine } from './detector.js';

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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
