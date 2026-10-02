# Contrail — Project Brief

> Working title. Rename freely; just keep it original (see Hard Rules).

## 1. What we're building

A personal focus timer for Henry that turns each study/work session into a simulated flight:
pick a duration → see which airports are in range → choose seat class and purpose → get a
boarding pass → tear the stub to take off → fly across a 3D globe → land, get stamped, and log it.

- **User:** Henry (single user, personal use, not published to any store).
- **Platform:** static web app (PWA) hosted on **GitHub Pages** from this repo.
- **Devices:** Samsung **Galaxy S24 Ultra** (portrait, main) and **Galaxy Tab S10 FE 5G** (landscape). Browser: **Chrome for Android**.
- **Purpose:** CFA Level 1 + FMVA self-study, NEU coursework, and Waasee work sessions.

## 2. Hard rules

1. **Original design only.** This app shares a genre with FocusFlight (iOS), but you must not copy its name, logo, icons, illustrations, screenshots, colors, layouts or sounds. Don't look up FocusFlight screenshots for reference. The interaction ideas below (time-to-distance radar, tear-to-start, seat-class strictness, stamps) are generic mechanics. Give each its own visual treatment.
2. **UI copy is in English.** Talk to Henry in **Vietnamese** (chat, progress updates, questions).
3. **Static site, no backend server.** Firebase (Auth + Firestore) is the only cloud service. Ask Henry before adding anything that costs money.
4. **Secrets:** the Google Maps API key and Firebase web config are client-side by design. They go in `config.js`, and they are only safe because of the referrer restriction and the Firestore security rules. Never commit anything else secret.
5. **Small, working increments.** After every milestone, deploy to Pages, give Henry the link and say what to test on which device. **Stop at the end of M1 and wait for his feedback** before continuing.

## 3. Tech stack (suggested; adjust if you have a strong reason)

- Vanilla JS (ES modules) + HTML/CSS. No build step, so Pages serves the repo root directly. Third-party libraries come from a CDN with **pinned versions**.
- **Globe:** `globe.gl` (three.js). Day texture: NASA Blue Marble. Night texture: NASA Black Marble (city lights). A custom shader blends them along the **real day/night terminator**, computed from the subsolar point at the current UTC time.
- **Cinematic 3D (optional, M3):** Google Maps JavaScript API **Photorealistic 3D Maps** (`Map3DElement`, camera fly-to/fly-around). Check the current docs for the correct version channel and API names. It is only used for take-off and landing, and the user can turn it off.
- **Airports:** OurAirports (public domain), filtered to `large_airport` + `medium_airport` with scheduled service and an IATA code. Bundle it as compact JSON (iata, name, city, country, lat, lon).
- **Audio:** Web Audio API only. Generate every sound in code (engine hum, rain, cabin chime, paper tear, seatbelt click, radar blip, stamp thud), so there are no licensed sound files.
- **Storage:** IndexedDB, local-first. M4 adds Firebase Auth (Google sign-in) + Firestore sync with last-write-wins on each flight record.
- **PWA:** manifest, original app icon, and a service worker for offline use of everything except the Google 3D mode.

## 4. Core flow and features

### 4.1 Departure (home)
- Home airport defaults to **HAN (Hà Nội – Nội Bài)** and can be changed.
- **Time dial:** 5–180 min, with a tactile detent every minute (haptic tick, see §6). While the dial moves:
  - A **radar ring** expands from the home airport on the globe. Radius = duration × cruise speed (default **800 km/h**, measured as great-circle distance).
  - Airports **light up with a small pop and a radar blip** as the ring reaches them. Airports out of range dim.
  - The camera zooms out to fit the ring (25 min ≈ northern Vietnam, 3 h ≈ Southeast Asia).
  - A suggestion list below sorts the in-range airports by how closely their flight time matches the chosen duration.
- **Reverse pick:** tapping any airport snaps the dial to its computed flight time.
- **Setting "Route scale":** 1× (real speed), 2×, 4×. This lets long-haul destinations fit inside a 3-hour session. Show the active scale on the pass.

### 4.2 Seat class = strictness
| Class | Rules |
|---|---|
| Economy | Pause allowed. |
| Business | No pause. If the app stays hidden for more than **10 s** (`visibilitychange`), the flight is **Diverted** (logged as incomplete, still earns the miles flown so far, with a gentle message, not a punishment). |
| First | Business rules plus: Screen Wake Lock, fullscreen, ambience starts automatically. |

- Seat picker: a top-down cabin view in an **original style**. Picking a seat plays a seatbelt click and haptic.

### 4.3 Purpose tags
- Defaults: `CFA L1`, `FMVA`, `NEU`, `Waasee`, `Reading`, `Deep Work`. Henry can add, rename, recolor and reorder tags.
- Selecting a tag swings it with spring physics (overshoot, then settle).

### 4.4 Boarding pass and take-off
- The pass prints out with a short feed animation and shows: passenger **HENRY NGUYEN**, origin → destination IATA codes, scheduled duration, ETA (local time), seat, class, tag, flight number (generated), and route scale.
- **Tear-to-start:** there is no Start button. Henry drags the stub across a perforation line. The tear needs resistance (it follows the finger with a threshold), then the stub flies off with momentum. A paper-tear sound and a strong haptic play at the moment it separates. Releasing before the threshold springs the stub back.
- Take-off: if Cinematic 3D is on and a key is configured, do a short Google 3D fly-around of the origin airport and then pull up into the globe. Otherwise, pull up directly into the globe view.

### 4.5 In-flight
- **Globe view:** the plane moves along the great-circle arc in real time, trailing a light **contrail**. Show the live terminator and the remaining time/distance.
- **Window view:** sky colour follows the **local solar time at the plane's current position**. Parallax cloud layers tilt with the **gyroscope** (`deviceorientation`).
- **Ambience mixer:** engine hum, rain on the fuselage, quiet cabin. Each has its own level and the mixer is swipeable.
- **"Close shade" (pure mode):** a shade slides down over everything, leaving only a thin countdown on true black (good for OLED, saves battery).
- **Abort:** press and **hold 3 s**. A ring fills while holding; letting go cancels the abort.
- **ETA notification:** when the app is backgrounded, show a notification with the destination and ETA (and a static progress label where possible).

### 4.6 Landing
- Cabin chime, a warm light sweep, and confetti at 60 fps.
- **Stamp:** the passport stamp (city, date, duration, tag) hovers, then **slams down** with the strongest haptic and a thud sound.
- **First visit to a city** unlocks it: it gets a new stamp design, and the city's marker changes from a dashed outline to filled on every future globe.

### 4.7 Logbook (passport)
- Passport-style pages with a page-turn interaction (original styling).
- Stamp collection grid. Stats: total hours, total **miles** (km toggle), flights, unlocked cities, current streak.
- **Heatmap** of focus minutes per day (last 12 months), filterable by tag.
- Flight list with each pass archived. Export and import JSON as a backup, available even before Firebase.

### 4.8 Cockpit mode (tablet)
- When the device is landscape **and** charging (Battery API), offer a dim red night-instrument clock screen showing the current flight's progress.

## 5. Visual direction: "Night Cabin" (original)

- **Mood:** a quiet long-haul night flight. Deep blue-black cabin, warm amber reading-light accents, ivory/cream paper for passes and stamps, with a small, sparing signal colour for alerts.
- **Typography:** choose a characterful display face for codes and numbers (a departure-board or ticket feel), a calm readable body face, and a monospace for flight data. Use Google Fonts, avoid Inter/Space Grotesk, and record the choices as CSS tokens.
- **Themes:** the night palette is the default. A day palette switches in automatically by local time (or by a manual toggle).
- **Motion:** slow and deliberate. Use spring physics for physical objects (stubs, tags, stamps). Respect `prefers-reduced-motion`.
- All icons, illustrations and the app icon are drawn from scratch, as SVG or canvas.

## 6. Haptics (`navigator.vibrate`, patterns in ms)

| Moment | Pattern (starting point; tune on the S24 Ultra) |
|---|---|
| Dial detent | `8` |
| Radar reaches airport | `[12, 30, 12]` |
| Seatbelt click | `20` |
| Tag snap | `10` |
| Stub tears off | `[40, 20, 60]` |
| Abort ring complete | `[30, 40, 30, 40, 80]` |
| Stamp slam | `[90]` |

Chrome only controls timing, not intensity, so make the moments feel different through rhythm. Keep the pattern map in one place so it's easy to tune.

## 7. Device targets and performance

- **S24 Ultra:** portrait first. High-quality globe textures. Animate at the display's refresh rate (use rAF and avoid layout thrash).
- **Tab S10 FE:** landscape layout with two columns (globe | pass and controls). In-flight is a full-bleed globe. Cinematic 3D defaults to **medium** quality.
- **Quality setting:** Auto / High / Medium / Low (texture resolution, pixel ratio cap, 3D on/off).
- Check on both devices that nothing scrolls horizontally and that touch targets are at least 44 px.

## 8. External setup (Henry does these; walk him through them in Vietnamese when needed)

- **GitHub Pages:** Settings → Pages → deploy from `main` / root. The URL is `https://<user>.github.io/<repo>/`.
- **Google Cloud (M3):** project with billing, enable **Maps JavaScript API** and **Map Tiles API**, an API key restricted to **Websites → `https://<user>.github.io/*`** and to those two APIs only, a **daily quota cap** on Map Tiles, and a **budget alert at USD 1**. Expect about one 3D session per flight. Measure real usage and report it to Henry.
- **Firebase (M4):** a web app, Google sign-in enabled, the Pages domain added to authorized domains, and Firestore rules that let only the signed-in user read and write `users/{uid}/**`.
- If Google 3D coverage around HAN/SGN turns out to be terrain-only, tell Henry and keep the globe fallback.

## 9. Milestones

| # | Scope | Done when |
|---|---|---|
| **M0** | Repo scaffold, Pages deploy, design tokens, airport dataset, PWA shell | Henry opens the Pages URL on both devices |
| **M1** | Departure (dial + radar + reverse pick), seat class, tags, boarding pass, **tear-to-start**, take-off on the globe | **Stop. Henry tests the feel on the S24 Ultra and gives feedback** |
| M2 | In-flight (globe, window, ambience, shade, abort), landing + stamp, logbook + heatmap, JSON backup | A full 5-minute test flight works end to end, also offline |
| M3 | Google 3D cinematic take-off/landing + toggle + quality tiers | Works with Henry's key; usage measured |
| M4 | Firebase Google sign-in + sync between phone and tablet | A flight on the phone appears on the tablet |
| M5 | Cockpit mode, ETA notification, polish pass, haptic tuning | Henry signs off |

## 10. Working agreements

- After each milestone, post in Vietnamese: the link, what changed, what to test on which device, and any known issues.
- Ask before big direction changes, new paid services, or removing a feature in this brief.
- Write commit messages in English, keep them small and descriptive.
