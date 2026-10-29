/* What kind of space is the saved spot, and is it enforced right now?
 *
 * Stanford's default enforcement hours (transportation.stanford.edu, Parking Enforcement,
 * read 2026-10-24), all "unless otherwise posted", so a sign always wins:
 *   A, C, E and shared commuter lots   Mon-Fri 6 am - 4 pm
 *   A at the Oval                      Mon-Fri 6 am - 6 pm
 *   visitor                            Mon-Fri 8 am - 4 pm
 *   Blackwelder / EVGR-A shared lot    'C' permits 4 pm - 2 am, every day
 *   Quillen Ct, EVGR North, Hulme Ct   24 hours, every day
 * University holidays lift the commuter, Oval and visitor rules ("enforcement remains as
 * posted, including winter closure, except on university holidays"). HOLIDAYS is that list,
 * from cardinalatwork.stanford.edu's University Holiday Schedule (read 2026-10-25). Past
 * its last date nothing is a holiday, so the page goes back to saying "enforced": the safe
 * way to be wrong. Shared and resident lots keep their hours on a holiday here too; the
 * page excludes only non-shared residential lots from the lift, but residents still park
 * in the shared ones, so this file does not promise them.
 * Times are Stanford's (America/Los_Angeles) whatever zone the phone is in.
 */
import { haversine } from './detector.js';

/** Stanford university holidays (Stanford dates), and the winter closure around them. */
export const HOLIDAYS = new Map([
  ['2026-01-01', "New Year's Day"], ['2026-01-19', 'Martin Luther King, Jr. Day'],
  ['2026-02-16', "Presidents' Day"], ['2026-05-25', 'Memorial Day'], ['2026-07-03', 'Independence Day'],
  ['2026-09-07', 'Labor Day'], ['2026-11-26', 'Thanksgiving'], ['2026-11-27', 'the Friday after Thanksgiving'],
  ['2026-12-24', 'the winter holiday'], ['2026-12-25', 'the winter holiday'],
  ['2027-01-01', "New Year's Day"], ['2027-01-18', 'Martin Luther King, Jr. Day'],
  ['2027-02-15', "Presidents' Day"], ['2027-05-31', 'Memorial Day'], ['2027-07-05', 'Independence Day'],
  ['2027-09-06', 'Labor Day'], ['2027-11-25', 'Thanksgiving'], ['2027-11-26', 'the Friday after Thanksgiving'],
  ['2027-12-23', 'the winter holiday'], ['2027-12-24', 'the winter holiday'],
]);
export const CLOSURES = [['2026-12-21', '2027-01-01']];   // 2027/28 dates "announced in spring 2027"

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY = [0, 1, 2, 3, 4, 5, 6];
export const RULES = {
  permit: { label: 'permit', days: WEEKDAYS, from: 6, to: 16, holidays: true },
  oval: { label: 'Oval A', days: WEEKDAYS, from: 6, to: 18, holidays: true },
  visitor: { label: 'visitor', days: WEEKDAYS, from: 8, to: 16, holidays: true },
  evening: { label: "'C'", days: EVERY, from: 16, to: 26 },   // 26 = 2 am the next day
  always: { label: 'resident', days: EVERY, from: 0, to: 24 },
};
const GROUP = { A: 'permit', C: 'permit', O: 'oval', V: 'visitor' };

/** Shared resident/commuter lots with their own hours, as circles around the buildings. */
export const SHARED = [
  { name: 'Blackwelder / EVGR-A shared lot', lat: 37.4246, lon: -122.1581, r: 90, rule: 'evening' },
  { name: 'Quillen Ct shared lot', lat: 37.4262, lon: -122.1589, r: 60, rule: 'always' },
  { name: 'EVGR North shared lot', lat: 37.4277, lon: -122.1565, r: 70, rule: 'always' },
  { name: 'Hulme Ct shared lot', lat: 37.4278, lon: -122.1540, r: 80, rule: 'always' },
];

function inRing(lat, lon, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a1, o1] = ring[i], [a2, o2] = ring[j];
    if ((o1 > lon) !== (o2 > lon) && lat < (a2 - a1) * (lon - o1) / (o2 - o1) + a1) c = !c;
  }
  return c;
}

/**
 * The parking around `p`: { types: 'AC', lot: name|'' , shared: SHARED row|undefined } or null.
 * Inside a mapped lot, the lot's whole marker set counts (a garage holds A, C and visitor).
 * Otherwise markers within `nearM`, for street-side spaces like the Oval's. Null past that:
 * off campus, or a corner the map has no marker for, says nothing rather than guess.
 */
export function zoneAt(p, { markers, lots, shared = SHARED }, { nearM = 40 } = {}) {
  if (!p || !Number.isFinite(+p.lat) || !Number.isFinite(+p.lon)) return null;
  const sh = shared.find(s => haversine(s, p) <= s.r);
  if (sh) return { types: '', lot: sh.name, shared: sh };
  const lot = lots.find(([, , rings]) => rings.some(r => inRing(p.lat, p.lon, r)));
  if (lot) return { types: lot[0], lot: lot[1] };
  const near = new Set(markers.filter(m => haversine({ lat: m[0], lon: m[1] }, p) <= nearM).map(m => m[2]));
  return near.size ? { types: [...near].sort().join(''), lot: '' } : null;
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Weekday (0 = Sun), fractional hour and 'YYYY-MM-DD' date at Stanford. */
export function stanfordClock(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).map(x => [x.type, x.value]));
  return {
    day: DAY.indexOf(parts.weekday), hour: (+parts.hour % 24) + (+parts.minute) / 60,
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** 'YYYY-MM-DD' `k` days after `ymd`. */
const addDays = (ymd, k) => new Date(Date.parse(ymd + 'T12:00:00Z') + k * 864e5).toISOString().slice(0, 10);
/** Is `rule` lifted on the Stanford date `k` days from `now`? A clock with no date has no holidays. */
const lifted = (rule, now, k) => !!(rule.holidays && now.ymd && HOLIDAYS.has(addDays(now.ymd, k)));

/**
 * The holiday or closure line for the page, or null on an ordinary day:
 *   "Thanksgiving: permit, Oval and visitor parking not enforced today"
 *   "Winter closure: enforced as posted, except university holidays Dec 24, Dec 25 and Jan 1"
 * The second is the r/stanford 2019 question: closure is not a holiday.
 */
export function holidayNote(date = new Date(), { holidays = HOLIDAYS, closures = CLOSURES } = {}) {
  const { ymd } = stanfordClock(date);
  if (holidays.has(ymd)) return `${cap(holidays.get(ymd))}: permit, Oval and visitor parking not enforced today`;
  const c = closures.find(([a, b]) => ymd >= a && ymd <= b);
  if (!c) return null;
  const days = [...holidays.keys()].filter(d => d >= c[0] && d <= c[1]).map(shortDate);
  return `Winter closure: enforced as posted${days.length ? `, except university holidays ${list(days)}` : ''}`;
}
const cap = s => s.replace(/^the /, 'The ').replace(/^./, x => x.toUpperCase());
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = ymd => `${MON[+ymd.slice(5, 7) - 1]} ${+ymd.slice(8, 10)}`;
const list = xs => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;

const clockLabel = h => {
  const hh = Math.floor(h) % 24;
  return `${hh % 12 || 12} ${hh < 12 ? 'am' : 'pm'}`;
};

/** { on, text } for one rule at Stanford-time {day, hour}. */
export function ruleNow(rule, now) {
  const { day, hour } = now;
  if (rule.from === 0 && rule.to === 24) return { on: true, text: 'enforced 24/7' };
  const yesterday = (day + 6) % 7;
  if (rule.days.includes(day) && hour >= rule.from && hour < rule.to && !lifted(rule, now, 0))
    return { on: true, text: `enforced until ${clockLabel(rule.to)}` };
  if (rule.to > 24 && rule.days.includes(yesterday) && hour < rule.to - 24 && !lifted(rule, now, -1))
    return { on: true, text: `enforced until ${clockLabel(rule.to)}` };
  for (let k = 0; k < 15; k++) {
    const d = (day + k) % 7;
    if (!rule.days.includes(d) || (k === 0 && hour >= rule.from) || lifted(rule, now, k)) continue;
    const when = k === 0 ? '' : k === 1 ? 'tomorrow ' : k < 7 ? DAY[d] + ' ' : shortDate(addDays(now.ymd, k)) + ' ';
    const why = rule.days.includes(day) && lifted(rule, now, 0) ? ' (university holiday)' : '';
    return { on: false, text: `not enforced until ${when}${clockLabel(rule.from)}${why}` };
  }
  return { on: false, text: 'not enforced' };
}

/**
 * One line for the spot strip, e.g. "C permit · not enforced until Mon 6 am", or
 * "A/C permit · enforced until 4 pm; visitor · not enforced until 8 am". Null for no zone,
 * and for a 20-minute space alone, whose limit is whatever its sign says.
 */
export function zoneLine(zone, date = new Date()) {
  if (!zone) return null;
  const now = stanfordClock(date);
  if (zone.shared) return `${zone.shared.name} · ${RULES[zone.shared.rule].label} ${ruleNow(RULES[zone.shared.rule], now).text}`;
  const groups = {};
  for (const t of zone.types) if (GROUP[t]) (groups[GROUP[t]] ||= []).push(t);
  const parts = Object.entries(groups).map(([g, ts]) => {
    const name = g === 'permit' ? `${ts.join('/')} permit` : RULES[g].label;
    return `${name} · ${ruleNow(RULES[g], now).text}`;
  });
  if (zone.types.includes('T')) parts.push('20-min spaces as posted');
  return groups.permit || groups.oval || groups.visitor ? parts.join('; ') : null;
}

/** Hours from Stanford-time {day, hour} until `rule` is next enforced: 0 if it is now. */
export function hoursFree(rule, now) {
  if (ruleNow(rule, now).on) return 0;
  for (let k = 0; k < 15; k++) {
    const start = k * 24 + rule.from - now.hour;
    if (rule.days.includes((now.day + k) % 7) && start > 0 && !lifted(rule, now, k)) return start;
  }
  return Infinity;
}

const centroid = ring => ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);

/**
 * The inverse of zoneLine: mapped lots near `p` that a car with no permit may use right now,
 * nearest first. Each row is { lat, lon, m, lot, kind, text }, where kind is the space type
 * that is free ('C permit', 'visitor', ...) and text its ruleNow line, e.g. "not enforced
 * until Mon 6 am". Where several kinds are free, the one free longest wins. Shared resident
 * lots never count (residents only, or 'C' at night), nor 20-minute-only lots, nor anything
 * past `maxM`. Empty is an answer: on a weekday at 10 am every permit lot is enforced. The
 * list's `nearby` says how many lots were in range at all, so off campus can say so instead.
 */
export function freeLots(p, { lots, shared = SHARED }, date = new Date(), { maxM = 1500, limit = 5 } = {}) {
  const rows = Object.assign([], { nearby: 0 });
  if (!p || !Number.isFinite(+p.lat) || !Number.isFinite(+p.lon)) return rows;
  const now = stanfordClock(date);
  for (const [types, name, rings] of lots) {
    const [lat, lon] = centroid(rings[0]);
    if (shared.some(s => haversine(s, { lat, lon }) <= s.r)) continue;
    const m = haversine(p, { lat, lon });
    if (m > maxM) continue;
    rows.nearby++;
    let best = null;
    for (const g of new Set([...types].map(t => GROUP[t]).filter(Boolean))) {
      const h = hoursFree(RULES[g], now);
      if (h > 0 && (!best || h > best.h)) {
        const ts = [...types].filter(t => GROUP[t] === g).join('/');
        best = { h, kind: g === 'permit' ? `${ts} permit` : RULES[g].label, text: ruleNow(RULES[g], now).text };
      }
    }
    if (best) rows.push({ lat, lon, m: Math.round(m), lot: name, kind: best.kind, text: best.text });
  }
  rows.sort((a, b) => a.m - b.m).splice(limit);
  return rows;
}

/**
 * When must a car at `zone` move, if nothing there is enforced now? -> { ymd, hour, hours,
 * kind, label } for the earliest enforcement start within `within` hours, e.g. a C lot on
 * Sunday night gives { ymd: '2026-11-02', hour: 6, kind: 'C permit', label: 'Mon 6 am' }.
 * Null when any rule at the spot is enforced already (the driver either holds that permit
 * or the warning is late), when it is 24/7, when there is no zone, or when the start is
 * further off than `within` (a Friday-evening park does not need a Monday alarm today).
 * `hours` counts Stanford wall-clock hours, so it can be an hour out across a DST change;
 * ymd/hour are wall-clock and are what the calendar file uses.
 */
export function moveBy(zone, date = new Date(), { within = 18 } = {}) {
  if (!zone) return null;
  const now = stanfordClock(date);
  const kinds = zone.shared
    ? [[zone.shared.rule, `${zone.shared.name} (${RULES[zone.shared.rule].label})`]]
    : Object.entries([...zone.types].reduce((g, t) => (GROUP[t] && (g[GROUP[t]] ||= []).push(t), g), {}))
        .map(([g, ts]) => [g, g === 'permit' ? `${ts.join('/')} permit` : RULES[g].label]);
  let best = null;
  for (const [g, kind] of kinds) {
    const h = hoursFree(RULES[g], now);
    if (h === 0 || !Number.isFinite(h)) return null;
    if (!best || h < best.hours) best = { hours: h, kind, rule: RULES[g] };
  }
  if (!best || best.hours > within) return null;
  const k = Math.round((now.hour + best.hours - best.rule.from) / 24);
  const ymd = addDays(now.ymd, k);
  const when = k === 0 ? 'today' : k === 1 ? 'tomorrow' : DAY[(now.day + k) % 7];
  return { ymd, hour: best.rule.from, hours: best.hours, kind: best.kind, label: `${when} ${clockLabel(best.rule.from)}` };
}

const pad2 = n => String(n).padStart(2, '0');
const icsEsc = s => String(s).replace(/[\;,]/g, c => '\\' + c).replace(/\n/g, '\\n');
/**
 * A one-event calendar file for moveBy(): the event sits at the enforcement start in
 * Stanford time (TZID, so the phone's zone and DST don't move it) and alarms 30 minutes
 * before. The UID is per spot and start, so re-adding the same reminder replaces it.
 */
export function moveByICS(mb, spot, stamp = new Date()) {
  const z = stamp.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const d = mb.ymd.replace(/-/g, ''), t = `T${pad2(mb.hour)}0000`;
  const end = `T${pad2(mb.hour)}1500`;
  const where = `${spot.lat.toFixed(5)},${spot.lon.toFixed(5)}`;
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//where-did-i-park//move-by//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE', 'TZID:America/Los_Angeles',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0800', 'TZOFFSETTO:-0700', 'TZNAME:PDT',
    'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0800', 'TZNAME:PST',
    'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT', `UID:${d}${t}-${where.replace(/[^0-9]/g, '')}@where-did-i-park`, `DTSTAMP:${z}`,
    `DTSTART;TZID=America/Los_Angeles:${d}${t}`, `DTEND;TZID=America/Los_Angeles:${d}${end}`,
    `SUMMARY:${icsEsc(`Move the car: ${mb.kind} enforced from ${clockLabel(mb.hour)}`)}`,
    `GEO:${spot.lat.toFixed(5)};${spot.lon.toFixed(5)}`, `LOCATION:${icsEsc(where)}`,
    `DESCRIPTION:${icsEsc('Default Stanford enforcement hours; a posted sign always wins.')}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT30M', 'DESCRIPTION:Move the car', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
}
