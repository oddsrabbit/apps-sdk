# RabbitWords

Reference implementation of an OddsRabbit app and the Phase 1 launch title for the Games surface.

A daily 5-letter word puzzle in the Wordle tradition. Beyond being a real game, this serves as the canonical SDK example for third-party developers — every bridge method on `window.OddsRabbit` gets exercised here.

## What it demonstrates

- `whenReady()` — wait for `init` to deliver `user` + `sessionToken` before reading.
- `storage.get` / `set` — `today`, `streak`, `stats`, `seen_intro` keys.
- `aggregate.count` — community guess-distribution after the player finishes.
- `actions.share` — emoji result string.
- `actions.haptic` — tile/win/loss feedback (no-op on web).
- `lifecycle.on('pause')` — flush in-progress state when backgrounded.
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
