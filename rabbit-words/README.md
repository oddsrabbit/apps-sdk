# RabbitWords

Reference implementation of an OddsRabbit app and the Phase 1 launch title for the Games surface.

A daily 5-letter word puzzle in the Wordle tradition. Beyond being a real game, this serves as the canonical SDK example for third-party developers — every bridge method on `window.OddsRabbit` gets exercised here.

## What it demonstrates

- `whenReady()` — wait for `init` to deliver `user` + `sessionToken` before reading.
- `storage.get` / `set` — `today`, `streak`, `stats`, `seen_intro` keys.
- `scores.submit` — one result per `(round, user)`; `score = ROW_COUNT + 1 - guessCount` for a win, `0` for a loss.
- `scores.friends` — the end-of-round + leaderboard "Friends" comparison panel.
- `scores.distribution` — community histogram, derived from the scores table (the source of truth; no separate `aggregate` write).
- `content.daily` — fetch the day's answer (`{ answer }`) from the server, date-gated so future answers aren't shipped to the client. The answer is **server-only**: there's no bundled answer pool, so an unavailable round shows a holding screen rather than a spoiler-readable local answer. (`words.ts` keeps only the merged, sorted *guess-validation* dictionary — no answer list, no day→answer order.)
- `actions.share` — emoji result string.
- `actions.haptic` — tile/win/loss feedback (no-op on web).
- `actions.requestSignIn` — sign-in CTA in the friends panel for guests.
- `lifecycle.on('pause')` — flush in-progress state when backgrounded.
- `colorScheme` — first paint matches the host theme (see `index.html`).
- `initialState` — `{ target: 'leaderboard', roundKey: 'puzzle-N' }` deep-link from a push tap.
- `ready()` — hide the host's loading skeleton.

Reading the source (`src/main.ts`) is the recommended starting point for any third-party developer building against the SDK.

## Running locally

The bundled output goes to `../dist/rabbit-words/` from the parent SDK build. To iterate:

```bash
cd ..                  # /apps-sdk
npm run build          # builds SDK + sandbox host + rabbit-words
# Serve dist/ via any static server, then open dist/rabbit-words/index.html
```

In the WebView host (mobile or web), point at `https://apps.oddsrabbit.com/host/?app=rabbit-words` once the manifest is registered, or use the dev `?gameUrl=` override during local development.

## See also

- Parent SDK: [`../README.md`](../README.md) — bridge API and integration overview
- Live: [oddsrabbit.com/games/rabbit-words](https://www.oddsrabbit.com/games/rabbit-words/)
