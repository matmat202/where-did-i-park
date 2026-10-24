/* What kind of space is the saved spot, and is it enforced right now?
 *
 * Stanford's default enforcement hours (transportation.stanford.edu, Parking Enforcement,
 * read 2026-10-24), all "unless otherwise posted", so a sign always wins:
 *   A, C, E and shared commuter lots   Mon-Fri 6 am - 4 pm
 *   A at the Oval                      Mon-Fri 6 am - 6 pm
 *   visitor                            Mon-Fri 8 am - 4 pm
 *   Blackwelder / EVGR-A shared lot    'C' permits 4 pm - 2 am, every day
 *   Quillen Ct, EVGR North, Hulme Ct   24 hours, every day
 * University holidays lift the commuter and visitor rules; this file does not know them,
 * so on a holiday it says "enforced" when it is not. That is the safe way to be wrong.
 * Times are Stanford's (America/Los_Angeles) whatever zone the phone is in.
 */
import { haversine } from './detector.js';

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY = [0, 1, 2, 3, 4, 5, 6];
export const RULES = {
  permit: { label: 'permit', days: WEEKDAYS, from: 6, to: 16 },
  oval: { label: 'Oval A', days: WEEKDAYS, from: 6, to: 18 },
  visitor: { label: 'visitor', days: WEEKDAYS, from: 8, to: 16 },
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
/** Weekday (0 = Sun) and fractional hour at Stanford. */
export function stanfordClock(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { day: DAY.indexOf(parts.weekday), hour: (+parts.hour % 24) + (+parts.minute) / 60 };
}

const clockLabel = h => {
  const hh = Math.floor(h) % 24;
  return `${hh % 12 || 12} ${hh < 12 ? 'am' : 'pm'}`;
};

/** { on, text } for one rule at Stanford-time {day, hour}. */
export function ruleNow(rule, { day, hour }) {
  if (rule.from === 0 && rule.to === 24) return { on: true, text: 'enforced 24/7' };
  const yesterday = (day + 6) % 7;
  if (rule.days.includes(day) && hour >= rule.from && hour < rule.to)
    return { on: true, text: `enforced until ${clockLabel(rule.to)}` };
  if (rule.to > 24 && rule.days.includes(yesterday) && hour < rule.to - 24)
    return { on: true, text: `enforced until ${clockLabel(rule.to)}` };
  for (let k = 0; k < 8; k++) {
    const d = (day + k) % 7;
    if (!rule.days.includes(d) || (k === 0 && hour >= rule.from)) continue;
    return { on: false, text: `not enforced until ${k === 0 ? '' : k === 1 ? 'tomorrow ' : DAY[d] + ' '}${clockLabel(rule.from)}` };
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
