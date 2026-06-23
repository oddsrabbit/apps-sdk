# RabbitGlobe

A daily geo-guess: each day brings **three street-level photos** from around the
world. For each, drop a pin on the map where you think it was taken — the closer
you are, the more of the 5,000 points you keep (15,000 for a flawless day).

Like [`rabbit-words`](../rabbit-words/), it's both a real game and a reference
implementation. It mirrors the RabbitWords skeleton and adds a map.

## What it demonstrates

- `whenReady()` — wait for `init` before reading.
- `storage.get` / `set` — `today` (3-round state), `stats`, `streak`, `seen_intro`.
- `content.daily` — fetch the day's three locations (`{ locations: [...] }`) from the
  server, date-gated so future answers aren't shipped to the client. Locations are
  **server-only** (the coordinates are the answer) — there's no bundled set, so an
  unavailable round shows a holding screen. **The game needs server content seeded
  to be playable** (see the backend repo's `tools/seed-rabbit-globe.php`).
- `scores.submit` — one result per `(round, user)`; `score` = the day's total
  (0–15,000), higher is better.
- `scores.friends` / `scores.distribution` — end-of-round Friends panel + community
  histogram. Because geo scores are near-continuous, the raw distribution is folded
  into five score **bands** client-side (`bucketForTotal`).
- `actions.share` — full share modal: proximity grid (🟩 per round by closeness),
  copy, native share, per-network buttons, and a downloadable 1080×1080 canvas image.
- `actions.haptic` — pin-drop / guess feedback (no-op on web).
- `actions.requestSignIn` — sign-in CTA in the Friends panel for guests.
- `initialState` — `{ target: 'leaderboard', roundKey: 'puzzle-N' }` deep-link from a
  push tap; opens the past-day leaderboard modal (🏆 header button, prev/next 7 days).
- `lifecycle.on('pause')`, `colorScheme`, `ready()` — same idioms as RabbitWords.

## How it works

- **Map**: [Leaflet](https://leafletjs.com) + OpenStreetMap tiles, **bundled** via
  esbuild (`src/main.ts` imports `leaflet`; `leaflet.css` is copied into `dist/`).
  Markers are CSS-only `divIcon`s to avoid Leaflet's bundled-PNG path issue.
- **Scoring**: great-circle (`haversineKm`) → `5000·e^(−km/SCALE_KM)` per round.
- **Rounds**: `ROUNDS_PER_DAY = 3`; state is an array, so the count is one constant
  to change.
- **Daily content** (`content.daily` payload): `{ locations: [ { image, lat, lng,
  place, attribution } ×3 ] }`. Coordinates ship to the client (client-side
  scoring) — same trust model as the RabbitWords answer.

## Imagery / content

The daily locations are **street-level Mapillary** imagery, sourced and
**re-hosted** server-side (Mapillary thumbnail URLs expire), then served via
`content.daily`. That pipeline lives in the private backend repo (see its
`tools/seed-rabbit-globe.php` + `docs/content-daily.md`), not here. There is **no
bundled fallback** — until the backend is seeded, the game shows its "unavailable"
holding screen.

> **Attribution is required.** Always render each location's `attribution` string
> with its photo (the game does, in the clue caption).

## Running locally

```bash
cd ..                  # /apps-sdk
npm run build          # builds SDK + sandbox host + games (bundles Leaflet)
# Serve dist/ via any static server, then open dist/rabbit-globe/index.html
```

The iframe needs network access to **OpenStreetMap tiles**
(`*.tile.openstreetmap.org`) and the photo host — confirm the games host's
CSP/Permissions-Policy allows both.

## See also

- Parent SDK: [`../README.md`](../README.md)
- Sibling reference: [`../rabbit-words/`](../rabbit-words/) — the shared idioms this mirrors
