# RabbitGlobe

A daily geo-guess: each day brings **three street-level photos** from around the
world. For each, line the map's crosshair up with where you think it was taken —
the closer you are, the more of the 5,000 points you keep (within 25 km keeps
them all; 15,000 for a flawless day).

Like [`rabbit-words`](../rabbit-words/), it's both a real game and a reference
implementation. It mirrors the RabbitWords skeleton and adds a map.

## What it demonstrates

- `whenReady()` — wait for `init` before reading.
- `storage.get` / `set` — `today` (3-round state, incl. a `submitted` flag), `stats`,
  `streak`, `seen_intro`.
- `content.daily` — fetch the day's three locations (`{ locations: [...] }`) from the
  server, date-gated so future answers aren't shipped to the client. Locations are
  **server-only** (the coordinates are the answer) — there's no bundled set, so an
  unavailable round shows a holding screen. **The game needs server content seeded
  to be playable** (see the backend repo's `tools/seed-rabbit-globe.php`).
- `scores.submit` — one result per `(round, user)`; `score` = the day's total
  (0–15,000), higher is better. Sent once: success or `scores/already-submitted`
  sets `today.submitted`; guests stay unflagged so signing in later still counts.
  `metadata.guesses` (`[lat, lng] ×3`) lets the server **recompute** the score
  against the round's content and store its own number — see *Trust model*.
- `scores.friends` / `scores.distribution` — end-of-round Friends panel + community
  histogram. Because geo scores are near-continuous, the raw distribution is folded
  into five score **bands** client-side (`bucketForTotal`).
- `actions.share` — full share modal: proximity grid (🟩 per round by closeness),
  copy, native share, per-network buttons, and a downloadable 1080×1080 canvas image
  (a drawn globe, never the day's photo — that would spoil it for friends).
- `actions.haptic` — pin-drop / guess feedback (no-op on web).
- `actions.requestSignIn` — sign-in CTA in the Friends panel for guests.
- `initialState` — `{ target: 'leaderboard', roundKey: 'puzzle-N' }` deep-link from a
  push tap; opens the past-day leaderboard modal (🏆 header button, prev/next 7 days).
- `lifecycle.on('pause' | 'resume')` — save on pause; on resume (and on the minute
  tick) reload a finished game once midnight UTC has passed, or retry the
  "unavailable" screen. An in-progress game is never swapped out mid-day.
- `colorScheme`, `ready()` — same idioms as RabbitWords.

## How it works

- **Map**: [Leaflet](https://leafletjs.com) + OpenStreetMap tiles, **bundled** via
  esbuild (`src/main.ts` imports `leaflet`; `leaflet.css` is copied into `dist/`).
  Markers are CSS-themed `circleMarker`s / `divIcon`s, which also avoids Leaflet's
  bundled-PNG path issue. Dark mode inverts the tile pane with a CSS filter.
- **Guessing**: the guess is the map's centre under a fixed crosshair — drag the
  map, tap a spot to pan there, or use arrow keys. Guess unlocks once the map has
  been moved. The stored guess is `wrap()`ed to −180…180, and reveal lines take
  the short way across the date line (`nearLng`).
- **Reveal**: the round map stays draggable/zoomable; the end screen adds a map of
  all three rounds and a personal score histogram (`stats.distribution`).
- **Scoring**: great-circle (`haversineKm`) → `5000·e^(−km/SCALE_KM)` per round,
  and a flat 5,000 within `PERFECT_KM` (25 km).
- **Rounds**: `ROUNDS_PER_DAY = 3`; state is an array, so the count is one constant
  to change.
- **Daily content** (`content.daily` payload): `{ locations: [ { image, images?,
  lat, lng, place, attribution } ×3 ] }`. `images` is optional extra frames of the
  same spot, shown as thumbnails after `image`. Coordinates ship to the client (client-side
  scoring) — same trust model as the RabbitWords answer.

## Trust model

The answer coordinates ship to the client, because the game scores locally to
draw each reveal. The backend's `AppScoreVerifier` closes half of the gap: it
recomputes the day's score from `metadata.guesses` and stores that instead of
the claimed number, so no one can post a total their pins didn't earn. It also
strips the guesses before storing, because board reads return metadata and a
strong player's guesses would give away the answers.

What it doesn't stop is reading the answers from devtools and pinning them
exactly. Closing that needs the coordinates kept server-side and a per-guess
bridge verb that returns the truth only after a guess is locked in. The scoring
constants and formulas in `src/main.ts` must stay in step with the verifier's;
its PHPUnit test pins reference values produced by this file's functions.

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
(`tile.openstreetmap.org`) and the photo host — confirm the games host's
CSP/Permissions-Policy allows both. OSM's tile policy suits light use; if traffic
grows, switch `TILE_URL` in `src/main.ts` to a commercial provider.

## See also

- Parent SDK: [`../README.md`](../README.md)
- Sibling reference: [`../rabbit-words/`](../rabbit-words/) — the shared idioms this mirrors
