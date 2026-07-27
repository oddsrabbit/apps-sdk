# OddsRabbit Apps SDK

The SDK for building games and apps on [OddsRabbit](https://www.oddsrabbit.com).

> 🚧 **Alpha.** APIs subject to change.

- **Full developer guide:** [oddsrabbit.com/developers/games](https://www.oddsrabbit.com/developers/games/)
- **Reference games:** [`rabbit-words/`](./rabbit-words/), [`rabbit-globe/`](./rabbit-globe/), [`2048/`](./2048/), [`snake/`](./snake/), [`match3/`](./match3/), [`solitaire/`](./solitaire/), [`liquid/`](./liquid/)

## Hello world

```html
<!doctype html>
<script src="https://apps.oddsrabbit.com/sdk-v1.js"></script>
<h1>Hello!</h1>
<script>
  OddsRabbit.whenReady().then(() => {
    document.querySelector('h1').textContent = OddsRabbit.user
      ? `Hi ${OddsRabbit.user.username}!`
      : 'Welcome, guest!';
    OddsRabbit.ready(); // hides the host's loading skeleton
  });
</script>
```

## Install

**CDN** (vanilla HTML — recommended):

```html
<script src="https://apps.oddsrabbit.com/sdk-v1.js"></script>
```

**npm** (TypeScript / build-tool apps):

```bash
npm install @oddsrabbit/apps-sdk
```

```ts
import { OddsRabbit } from '@oddsrabbit/apps-sdk';
```

## What you get

Everything available on `window.OddsRabbit` once `await OR.whenReady()` resolves:

- **`OR.user`** — the signed-in user's profile, or `null` for guests:
  - `uuid` — stable platform UUID. Treat as opaque.
  - `username` — display handle (1–64 chars).
  - `avatar` — absolute avatar URL, or `null` if the user has no avatar set or the host doesn't populate it. Fall back to initials from `username` when null.
  - `createdAt` — ISO datetime the account was created, or `null` if the host doesn't expose it. Useful for "OG player" badges and onboarding branches.
- **`OR.sessionToken`** — short-lived JWT for verifying the user on your backend.
- **`OR.colorScheme`** — the host's `'light'` or `'dark'` theme.
- **`OR.storage.get/set/delete`** — per-user key/value store. Syncs across the user's mobile and web sessions; falls back to local browser storage for guests.
- **`OR.scores.submit` / `OR.scores.friends` / `OR.scores.distribution` / `OR.scores.top`** — per-round leaderboards. `submit` records `{ score, metadata }` once per `(round, user)`, or pass `keepBest: true` under a constant round key for a rising all-time best; `friends` returns the people you follow for a round; `distribution` returns the community score histogram (`[{ score, count }]`) for a round, derived from the scores themselves so it always matches the recorded results; `top` returns the global top-N for a round (`order: 'top'` by score, `'first'` by earliest submission) and is public, so guests see the board. The three read methods resolve to `[]` rather than rejecting when the host doesn't support them.
- **`OR.scores.season`** — the monthly board: every player's daily rows across one calendar month, aggregated server-side into one ranked number. Public. Takes `{ period: 'YYYY-MM', metric?, limit? }` — no `roundKey`, since a season spans a month of them and only the server can expand `period` into the app's actual key list. `period` is a **UTC** month; use `OddsRabbitUI.currentPeriod()` rather than building it from local date parts, or players east of UTC jump to next month's empty board hours early. `metric` is `'sum'` (total points), `'max'` (best single score), or `'qualified_avg'` (play `qualifyingDays` of `puzzleDays` to qualify, then rank by mean); omit it to take the app's server-side default. Resolves to a `{ period, metric, puzzleDays, qualifyingDays, entries }` envelope — the extra fields exist so the UI can state the rule it's ranking by — or **`null`** (not `[]`) on a host without the verb, so a game can tell "no season board here" from "the season board is empty" and hide the tab rather than show an empty one. A malformed board **rejects** rather than resolving `null`: a broken response should reach the player as an error, not as a month nobody played. Treat the returned `metric` as an open string — the platform can add aggregations without a client release, and a board captioned generically still ranks correctly.
- **`OR.capabilities.has(verb)` / `OR.capabilities.all()`** — which bridge verbs *this host* implements, e.g. `OR.capabilities.has('scores.top')`. Gate optional UI on this, **not** on `typeof OR.scores.top === 'function'`: every SDK bundle exposes every method, while hosts differ (the mobile app has no `actions.requestSignIn`, and a native host can trail the SDK by an App Store review). **Read it only after `await OR.whenReady()`** — the host's answer arrives with `init`, so a call before that quietly returns the pre-handshake baseline instead of this host's real answer. Hosts that predate the handshake don't declare capabilities; the SDK then assumes that baseline and narrows it as verbs are actually rejected, so a `has()` call after a failed attempt still tells the truth.
- **`OR.content.daily`** — fetch server-authored, date-gated content for a round (e.g. the day's puzzle or answer), so apps don't bundle every future answer into the client where it's trivially readable. Public (works for guests). The server only serves rounds whose publish time has passed — a future round resolves to `null`. Returns `{ roundKey, content }` where `content` is your app-specific shape; resolves `null` on an unsupported host or unavailable round so you can fall back to bundled content.
- **`OR.actions.share`** — system share sheet on mobile, Web Share API on web.
- **`OR.actions.haptic`** — `'light' | 'medium' | 'success' | 'error'`. No-op on web.
- **`OR.actions.requestSignIn`** — prompt the user to sign in at a natural friction moment.
- **`OR.lifecycle.on`** — `'pause' | 'resume' | 'terminating'` hooks for animations and state-flushing.

Full method signatures, manifest schema, scopes, and error codes live in the [developer guide](https://www.oddsrabbit.com/developer-games/).

## Building for mobile

Games render in a WebView on iOS / Android and in an iframe on the desktop web. Most things "just work" on both — except touch gestures, which have an Android-specific footgun that doesn't reproduce in desktop Chrome devtools.

> ⚠️ **If your game uses swipe, drag, or any custom touch gesture, both rules below are required for Android.** Missing either one produces swipes that "only work in specific areas" — JS sees the gesture start but the WebView's compositor claims the rest of it for scroll/zoom.

**Touch gesture checklist:**

- [ ] **CSS: `touch-action: none`** on the element that receives the gesture (your `<canvas>`, board container, or `html, body` if gestures cover the whole screen). The Android compositor checks this *before* your JS runs to decide whether to scroll.
- [ ] **JS: `{ passive: false }`** on every `touchstart` / `touchmove` listener attached to `window`, `document`, or `body`. These listeners are passive-by-default since Chrome 56, which means `preventDefault()` is silently ignored without this flag.
- [ ] **CSS: `overscroll-behavior: none`** on `html, body` so the parent WebView's pull-to-refresh / edge-bounce can't claim drag-from-edge gestures.

```css
html, body { touch-action: none; overscroll-behavior: none; }
/* Or, if only part of the screen handles gestures: */
.game-canvas { touch-action: none; }
```

```js
el.addEventListener('touchstart', handler, { passive: false });
el.addEventListener('touchmove',  handler, { passive: false });
```

iOS has neither issue, so a swipe game that works on iOS Safari and desktop Chrome can be completely broken on Android. Always test on a real Android device before shipping. See [`2048/`](./2048/), [`snake/`](./snake/), and [`match3/`](./match3/) for working reference implementations.

## Verifying users on your backend

If your app has its own server, verify `OR.sessionToken` rather than trusting client-supplied UUIDs:

```ts
// In your app:
fetch('/my-backend/play', {
  headers: { Authorization: `Bearer ${OddsRabbit.sessionToken}` },
});
```

On your backend, verify the JWT against our JWKS:

```
https://apps.oddsrabbit.com/.well-known/jwks.json
```

Standard RS256 verification — confirm `iss === 'https://oddsrabbit.com'`, `aud === your_app_uuid` (assigned at registration; not your manifest `id` slug), and `exp` is in the future. The `sub` claim is the OddsRabbit user UUID.

## What's in this repo

```
src/sdk/        The SDK loaded inside app iframes
src/host/       Sandbox host page that loads dev appUrls
src/schemas/    Zod schemas — single source of truth for the bridge
rabbit-words/   RabbitWords — reference game (Games surface, Phase 1)
rabbit-globe/   RabbitGlobe — daily photo-pin geo-guess (Leaflet map)
2048/           2048 port — reference game
snake/          Snake — Game Boy-styled reference game
match3/         Fruit Match — match-3 reference game
solitaire/      Solitaire — Klondike with daily deals + pixel rabbit court cards
liquid/         Liquid WebGL toy — reference app, no scopes
```

## Contributing

**Issues welcome** — bugs, questions, feature requests.

**PRs by invitation.** The bridge has security boundaries we'd like to keep tight, so please file an issue first; if it's a fit we'll invite a PR. (Same model Stripe and several similar SDKs use — public source for trust and debuggability, controlled contribution for review capacity.)

## License

MIT — see [`LICENSE`](./LICENSE).
