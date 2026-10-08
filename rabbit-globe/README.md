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
  **server-only** — there's no bundled set, so an unavailable round shows a holding
  screen. **The game needs server content seeded to be playable** (see the backend
  repo's `tools/seed-rabbit-globe.php`).
- `content.reveal` — lock in a round's pin and get its answer (`{ lat, lng, place }`),
  which `content.daily` withholds. See *Trust model*. A host without the verb gets an
  "update to play" screen for a day whose answers are withheld.
- `scores.submit` — one result per `(round, user)`; `score` = the day's total
  (0–15,000), higher is better. Sent once: success or `scores/already-submitted`
  sets `today.submitted`. The server **recomputes** the score and stores its own
  number: from the pins it recorded through `content.reveal`, or for older rounds
  from `metadata.guesses` (`[lat, lng] ×3`) — see *Trust model*. A guest's pins
  aren't recorded, so a guest who signs in mid-day can't post that day.
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
  attribution } ×3 ] }`. `images` is optional extra frames of the same spot, shown as
  thumbnails after `image`. Each round's `{ lat, lng, place }` comes from
  `content.reveal` and is stored into the location; rounds from before the cutover
  still ship it inline and are scored without a reveal.

## Trust model

The answers stay on the server. `content.daily` sends the photos only, and the
game gets a round's answer from `content.reveal` by sending its pin. For a
signed-in player the server records the **first** pin per round and answers with
that one from then on, so fetching an answer and then "guessing" it doesn't work,
and neither does clearing storage to replay. At submit, the backend's
`AppScoreVerifier` scores the day from those recorded pins against the round's
content and stores its own number; whatever the client claims or sends in
`metadata.guesses` is ignored. Rounds with no recorded pins can't post a score.
The verifier also keeps the pins off the stored row, because board reads return
metadata and a strong player's pins would give away the answers.

The cutover is per puzzle (`AppContentReveal::revealFrom()` in the backend): rounds
before it ship their answers inline and are scored from `metadata.guesses` as before.

What this doesn't stop: anyone can get a round's answers by guessing as a guest
or on a second account first, then playing their real account. Nothing on the
client can prevent that, and it's the same for every daily game. A player's
`kmTotal` (kept in the score metadata) is the tell: pins that copy the answers
land within metres of them.

The scoring constants and formulas in `src/main.ts` must stay in step with the
verifier's; its PHPUnit test pins reference values produced by this file's
functions.

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
