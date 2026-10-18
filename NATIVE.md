# Making the parking tracker a real iPhone app

Researched 2026-10-17. Verdict first, then the detail.

## Verdict

**The PWA is installable today and is already on your phone's home screen if you want
it — but it can never detect parking automatically, and no amount of work changes
that.** iOS gives web apps no background location whatsoever. The web version's
honest ceiling is: open the app, press one button, get the spot.

**A native app can do the real thing, and you can build it from this Linux machine
without owning a Mac.** The path is React Native + Expo, built on Expo's hosted macOS
runners. The blocking cost is the Apple Developer Program at **$99/year** — not
optional, because device installation and TestFlight both require signing.

The best news: **the detector logic ports over unchanged.** `site/detector.js` has no
DOM, geolocation or storage dependency — that was deliberate so it could be tested
against synthetic traces, and the payoff is that the same file is the core of the
native app, with its 20 trace tests still valid.

## Why the web version cannot do it

Not a gap to engineer around — a platform decision:

- iOS supports **no Background Sync, no Periodic Background Sync, no Background
  Fetch** for web apps, with no announced timeline.
- Service workers **cannot access geolocation at all** — it is not exposed to workers
  on any platform.
- When Safari or a home-screen web app leaves the foreground, `watchPosition` stops
  delivering.

So the web app sees your drive only while you are staring at it. Every "background
location PWA" claim online is either Android-only or wrong.

## What native unlocks

iOS has first-class APIs for exactly this problem, and two of them are better than
the GPS-speed heuristic the web version has to use:

| API | What it gives | Why it matters here |
|---|---|---|
| **Core Motion activity** (`CMMotionActivityManager`) | `automotive` / `cycling` / `walking` / `running` / `stationary` with a confidence level, straight from the motion coprocessor | Replaces speed-threshold guessing almost entirely, at near-zero battery. iOS 7+; cycling since iOS 8. |
| **Significant-location-change monitoring** | Wakes a terminated app on roughly 500 m of movement | Lets the app sleep through the day and still catch trips |
| **Geofencing** (`startGeofencingAsync`) | The system **restarts the terminated app** on a region event | How you get a notification when you walk away, without running continuously |
| **Background location** (`UIBackgroundModes: location`) | `watchPosition`-equivalent that keeps running when backgrounded | The actual missing capability |
| **`CLVisit` / visit monitoring** | iOS's own arrival/departure detection | A cross-check on the detector's own conclusion |

One important gotcha found in the research: Core Motion's activity flags are **not
mutually exclusive**. A car stopped at a red light can report `cycling` **and**
`stationary` simultaneously. Any port must treat the flags as a confidence vector, not
an enum — and must keep the displacement test, which is the part that actually
distinguishes parking from stopping. The existing state machine is still the right
shape; motion activity just makes its inputs far cleaner.

## Recommended stack, given a Linux machine

**React Native + Expo, built with EAS Build.**

- `eas build --platform ios` compiles and signs on **Expo's hosted macOS runners**, so
  no Mac is required. `eas submit --platform ios` uploads to App Store Connect from
  Linux.
- `expo-location` exposes everything needed: `startLocationUpdatesAsync`,
  `startGeofencingAsync`, `activityType`, `pausesUpdatesAutomatically`,
  `showsBackgroundLocationIndicator`, and — critically —
  `watchMotionActivityAsync()` returning Automotive / Cycling / Walking / Running /
  Stationary. No custom native module needed.
- `detector.js` drops in as-is. The JS is identical; only the input adapter changes.

Required configuration:

```
Info.plist:
  NSLocationWhenInUseUsageDescription
  NSLocationAlwaysAndWhenInUseUsageDescription
  NSMotionUsageDescription
  UIBackgroundModes: ["location"]
```

Documented constraints: background location needs a **development build** (it does not
work in Expo Go), and geofencing is capped at **20 simultaneous regions** — irrelevant
here, since parking needs exactly one.

Swift/SwiftUI would be the alternative. It is the better long-term choice for a
location-heavy app and gives direct access to `CLVisit`, but it requires macOS for
day-to-day development and discards the tested detector. Not worth it unless this
becomes a serious product.

## Cost and effort, honestly

| item | cost |
|---|---|
| Apple Developer Program | **$99/year**, unavoidable for device install or TestFlight |
| EAS Build | Free tier covers low build volumes; paid tiers for frequent builds |
| Mac | **Not needed** |
| My time to port | roughly a session or two to a working TestFlight build |

Distribution options, cheapest first:

1. **Free provisioning** (7-day app signing) — **not available to you**: it requires
   Xcode on macOS. Rules this out on Linux.
2. **TestFlight** ($99/yr) — install on your own device, 90-day builds, no App Store
   review for internal testers. **This is the right target.**
3. **App Store** ($99/yr + review) — only if you want other students to install it.

## Prior art worth knowing

[LocoKit](https://github.com/sobri909/LocoKit) is a mature open-source iOS framework
for exactly this domain — location, motion and activity recording, with Visits and
Paths, and reportedly better accuracy than raw `CLVisit`. If this goes native and
Swift, start by reading LocoKit rather than rebuilding its wheel. It does not help a
React Native port.

Also worth knowing: **iOS already has a built-in parked-car feature** that triggers off
CarPlay or a car's Bluetooth disconnect. If your car has either, Apple Maps may already
do 80% of this for free. The app earns its place for **bikes**, and for cars without
Bluetooth pairing — which is worth being honest about before spending $99.

## Open questions for you

1. Is **$99/year** worth it, given the manual "Mark spot now" button already works?
2. **Bike or car?** If mostly bike, native is clearly worth more — iOS's built-in
   feature does nothing for bikes.
3. Does your car connect to your phone over **Bluetooth or CarPlay**? If yes, check
   whether Apple Maps already shows your parked car before building anything.

## Recommendation

Use the PWA for a week with the manual button. It costs nothing and will tell you
whether you actually reach for it. If you find yourself wanting it to be automatic —
especially for a bike — the native port is a short job precisely because the hard part
is already written and tested, and the $99 becomes the only real decision.
