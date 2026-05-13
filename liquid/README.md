# Liquid

Port of Pavel Dobryakov's [WebGL Fluid Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation) (MIT) for the OddsRabbit Games surface.

An interactive, touch-driven fluid dynamics toy — drag a finger and Navier-Stokes-simulated liquid swirls across the screen with bloom, sunrays, and color cycling. Hosted under the Games surface as a visual showcase of what the platform can render in a WebView.

## File layout

Matches the `2048/` port:

```
liquid/
├── LICENSE.txt
├── README.md
├── index.html
└── js/
    ├── bootstrap.js      bridge wiring (whenReady, ready, lifecycle pause/resume, fatal error UI)
    ├── dat.gui.min.js    Apache 2.0, vendored verbatim
    └── script.js         upstream sim, modified (see below)
```

## What changed from upstream

- **App Store / Play Store promo banner removed** (`js/script.js`) — the 20-second mobile upsell + the entire `.promo` HTML/CSS were stripped. No purchase prompts, matching the platform's no-monetization policy.
- **Google Analytics removed** (`index.html`) — the inline `ga('create', ...)` setup and async `analytics.js` loader are gone. A `window.ga` no-op stub is left in `js/script.js` so any future upstream merges don't break on residual `ga(...)` call sites.
- **Social buttons removed** (`js/script.js`, `startGUI()`) — the Github / Twitter / Discord / "Check out mobile app" buttons inside the dat.gui panel were removed along with their iconfont-backed `<span>` icons. The host already provides the share affordance.
- **PWA chrome removed** (`index.html`) — `apple-touch-icon`, `apple-mobile-web-app-*` meta tags, OpenGraph metadata, and the iconfont @font-face declaration are stripped since the game runs inside the sandbox host iframe, not as a standalone web app.
- **Bridge bootstrap added** (`js/bootstrap.js`) — mirrors the structure of `2048/js/application.js`: `showFatalError()` for surfacing bootstrap failures with `role="alert"`, an `OddsRabbit` availability check, and the `whenReady()` → `ready()` flow.
- **Lifecycle pause/resume hook added** — `bootstrap.js` toggles the sim's built-in `config.PAUSED` flag via a `window.__liquidSetPaused` helper exposed from `js/script.js`. When the host fires `pause` (mobile background, tab switch), the GPU step short-circuits — material battery saving for a WebGL-heavy toy. `resume` flips it back.

Simulation code (the WebGL setup, shaders, advection, projection, dye, bloom, sunrays, splat logic) is unchanged from upstream — touch input via `pointerdown` / `pointermove` was already built in.

## Manifest scopes required

This is a stateless visual toy. No bridge scopes are needed in v1:
- No `bridge:storage` — settings live in `dat.gui` config and reset per session.
- No `bridge:share` — no in-app share moment (no scoring loop).

A future scoring loop (e.g., "trace the shape") could opt into `bridge:share` for milestone announcements.

## Licenses

- `script.js` — MIT, copyright (c) 2017 Pavel Dobryakov. See `LICENSE.txt`.
- `dat.gui.min.js` — Apache License 2.0, copyright (c) 2011 Data Arts Team, Google Creative Lab.
- Port modifications for the OddsRabbit Games surface — MIT under the apps-sdk repo's top-level license.
