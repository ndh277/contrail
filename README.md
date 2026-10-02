# Contrail

Personal flight-themed focus timer. Static PWA served by GitHub Pages from `main` / root —
no build step. See `CLAUDE.md` for the full brief.

```
index.html, sw.js, manifest.webmanifest, config.js
css/        tokens.css (design tokens), fonts.css (self-hosted Google Fonts), app.css
js/         ES modules (main, globe, geo, airports, settings, store, ...)
data/       airports.json — built by tools/build-airports.py from OurAirports
vendor/     pinned third-party libs (globe.gl 2.46.2, three.js core 0.185.1)
assets/     icons, fonts, NASA Blue Marble / Black Marble textures
```

Run locally: `python3 -m http.server` in the repo root, then open http://localhost:8000/.

Credits: airport data © OurAirports (public domain); Earth textures NASA Visible Earth
(Blue Marble, Black Marble); globe.gl and three.js (MIT); fonts Big Shoulders Display,
Be Vietnam Pro and IBM Plex Mono (SIL OFL); close-up satellite imagery (3D and window views,
loaded online) Sentinel-2 cloudless by EOX IT Services GmbH, contains modified Copernicus
Sentinel data, CC BY-NC-SA 4.0. Clouds, sky, airliner and stamps are generated in code.
