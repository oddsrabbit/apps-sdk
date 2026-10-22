# 2048

Port of Gabriele Cirulli's [2048](https://github.com/gabrielecirulli/2048) (MIT) for the OddsRabbit Games surface.

## What changed from the upstream

- `js/local_storage_manager.js` → `js/storage_manager.js` — same interface, persistence moved from `window.localStorage` to `OddsRabbit.storage` so best score + saved game sync across the user's mobile and web sessions.
- `js/application.js` — async bootstrap that awaits `OddsRabbit.whenReady()` and `storage.hydrate()` before constructing `GameManager`; calls `OddsRabbit.ready()` after first paint to hide the host skeleton.
- Reaching the 2048 tile fires `OddsRabbit.actions.share` once per page load.
- Dropped the three legacy polyfills (`bind_polyfill.js`, `classlist_polyfill.js`, `animframe_polyfill.js`) — modern WebView/Chromium covers all three natively.
- Stripped the Clear Sans `@import` from `styles.css`; the existing `Helvetica Neue, Arial, sans-serif` fallback chain renders cleanly on iOS and Android.
- Removed standalone-PWA meta tags (`apple-touch-icon`, `apple-mobile-web-app-capable`, `HandheldFriendly`) — the game runs inside the apps.oddsrabbit.com sandbox host iframe, not as a standalone web app.

Game logic (`game_manager.js`, `grid.js`, `tile.js`, `html_actuator.js`, `keyboard_input_manager.js`) is unchanged from upstream — touch swipe input was already built in.

## Manifest scopes required

- `bridge:storage` — best score + saved game.
- `bridge:share` — milestone share when 2048 is first reached.

## License

MIT — copyright (c) 2014 Gabriele Cirulli. See `LICENSE.txt`. Modifications for the OddsRabbit Games surface are also MIT under the apps-sdk repo's top-level license.
