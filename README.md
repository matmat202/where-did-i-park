# Where Did I Park

Works out where you parked a car or bike from your speed and position, then points
you back. Installable on a phone; nothing ever leaves the device.

**→ https://matmat202.github.io/where-did-i-park/**

On iPhone: open that link in Safari, tap **Share → Add to Home Screen**. It then runs
full screen, offline, with its own icon.

## The idea it rests on

**A vehicle stopping is not a vehicle parking.** Red lights, traffic jams and
drive-throughs all produce a stationary car. What distinguishes parking is that you
*get out and walk away*. Requiring displacement — not just a speed drop — is what
makes this work with nothing but GPS: no accelerometer, no Bluetooth pairing, no map
data, no server, no account.

## How it decides

1. Sustained vehicular speed for at least **25 s**. Above **6.0 m/s** (~21 km/h) reads
   as a car; **2.8–6.0 m/s** as a bike, which sets the recorded mode.
2. Speed drops to walking or below → a **candidate** opens at the last vehicular fix.
3. You stay non-vehicular for **75 s** *and* get at least **25 m** away → recorded.

Driving again before step 3 cancels the candidate, which is what rejects red lights
and stop-and-go traffic. Sitting in the car for twenty minutes does **not** cancel it —
the car is still where you stopped. A **gap in the fix stream over 15 minutes** does
cancel it: once the data has a hole, there is no honest way to promise the vehicle did
not move.

Fixes with accuracy worse than 60 m are discarded, and speed is median-smoothed over 5
samples so a single GPS spike cannot fabricate a journey.

## Tested

```bash
node test.mjs     # 20 assertions over 11 synthetic traces
```

The negative cases are the point — a detector that fires on a red light is worse than
none, because you would trust it. Covered: red light, 12 cycles of stop-and-go, sitting
in the car 20 minutes, sitting then walking away, a 20-minute hole in the data,
walking-only, low-accuracy spikes, a device that reports no speed field, and two trips
in one session.

`detector.js` has no DOM, geolocation or storage dependency, which is what makes those
traces testable in node.

## Honest limits

**Browsers suspend geolocation when you leave the page.** iOS gives web apps no
background location at all — no Background Sync, no Periodic Background Sync, no
geofencing — so automatic detection only sees the trip while the page is open and in
front. **Mark spot now** is always available as a one-tap fallback, and it is the
reliable path if you habitually pocket your phone while driving.

True hands-off detection needs a native app. See `NATIVE.md` in the project notes for
what that involves.

## Privacy

Positions are held in this browser's `localStorage` and nothing else. There is no
server, no analytics, and no network request other than fetching the page itself and
its webfont.
