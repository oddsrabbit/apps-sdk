# OddsRabbit Apps SDK

The SDK for building games and apps on [OddsRabbit](https://www.oddsrabbit.com).

> 🚧 **Alpha.** APIs subject to change.

- **Full developer guide:** [oddsrabbit.com/developers/games](https://www.oddsrabbit.com/developers/games/)
- **Reference games:** [`rabbit-words/`](./rabbit-words/), [`rabbit-globe/`](./rabbit-globe/), [`2048/`](./2048/), [`snake/`](./snake/), [`match3/`](./match3/), [`solitaire/`](./solitaire/), [`flappy-rabbits/`](./flappy-rabbits/), [`liquid/`](./liquid/)

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
  - `supporter` — `true` when the user holds the platform Supporter tier, so a game can thank them. `false` on hosts that predate the field.
- **`OR.sessionToken`** — short-lived JWT for verifying the user on your backend.
- **`OR.colorScheme`** — the host's `'light'` or `'dark'` theme.
- **`OR.storage.get/set/delete`** — per-user key/value store. Syncs across the user's mobile and web sessions; falls back to local browser storage for guests.
- **`OR.scores.submit` / `OR.scores.friends` / `OR.scores.distribution` / `OR.scores.top`** — per-round leaderboards. `submit` records `{ score, metadata }` once per `(round, user)`, or pass `keepBest: true` under a constant round key for a rising all-time best; `friends` returns the people you follow for a round; `distribution` returns the community score histogram (`[{ score, count }]`) for a round, derived from the scores themselves so it always matches the recorded results; `top` returns the global top-N for a round (`order: 'top'` by score, `'first'` by earliest submission) and is public, so guests see the board. The three read methods resolve to `[]` rather than rejecting when the host doesn't support them.
- **`OR.scores.season`** — the monthly board: every player's daily rows across one calendar month, aggregated server-side into one ranked number. Public. Takes `{ period: 'YYYY-MM', metric?, limit? }` — no `roundKey`, since a season spans a month of them and only the server can expand `period` into the app's actual key list. `period` is a **UTC** month; use `OddsRabbitUI.currentPeriod()` rather than building it from local date parts, or players east of UTC jump to next month's empty board hours early. `metric` is `'sum'` (total points), `'max'` (best single score), or `'qualified_avg'` (play `qualifyingDays` of `puzzleDays` to qualify, then rank by mean); omit it to take the app's server-side default. Resolves to a `{ period, metric, puzzleDays, qualifyingDays, entries }` envelope — the extra fields exist so the UI can state the rule it's ranking by — or **`null`** (not `[]`) on a host without the verb, so a game can tell "no season board here" from "the season board is empty" and hide the tab rather than show an empty one. A malformed board **rejects** rather than resolving `null`: a broken response should reach the player as an error, not as a month nobody played. Treat the returned `metric` as an open string — the platform can add aggregations without a client release, and a board captioned generically still ranks correctly.
- **`OR.scores.rank` / `OR.scores.seasonRank`** — where the *viewer* placed, for the pinned `…  #412 @you` row under a board they didn't make. `rank` takes `{ roundKey, order? }` and `seasonRank` takes `{ period, metric? }`; pass the same `order`/`metric` as the board, or the rank describes a different ordering than the rows above it. Both are **authenticated** companions to the public boards rather than flags on them, so `scores.top` and `scores.season` stay guest-readable and server-cached. Both resolve **`null`** when there is nothing to pin — no session, no rank verb on this host, or (for `rank`) the viewer hasn't played that round; a caller does the same thing with all of those. `seasonRank` still resolves an envelope when the viewer played no day this month (`rank`/`entry` null, but `puzzleDays`/`qualifyingDays` populated), because the qualifier is exactly what such a player needs to be told. Prefer wiring these through the shared panel's `loadPinned` / `createSeasonTab({ loadRank })` hooks rather than `Promise.all`-ing them with the board: the panel loads the pinned row in its own chain, so a rank failure costs one row instead of the whole board.
- **`OR.capabilities.has(verb)` / `OR.capabilities.all()`** — which bridge verbs *this host* implements, e.g. `OR.capabilities.has('scores.top')`. Gate optional UI on this, **not** on `typeof OR.scores.top === 'function'`: every SDK bundle exposes every method, while hosts differ (the mobile app has no `actions.requestSignIn`, and a native host can trail the SDK by an App Store review). **Read it only after `await OR.whenReady()`** — the host's answer arrives with `init`, so a call before that quietly returns the pre-handshake baseline instead of this host's real answer. Hosts that predate the handshake don't declare capabilities; the SDK then assumes that baseline and narrows it as verbs are actually rejected, so a `has()` call after a failed attempt still tells the truth.
- **`OR.content.daily`** — fetch server-authored, date-gated content for a round (e.g. the day's puzzle or answer), so apps don't bundle every future answer into the client where it's trivially readable. Public (works for guests). The server only serves rounds whose publish time has passed — a future round resolves to `null`. Returns `{ roundKey, content }` where `content` is your app-specific shape; resolves `null` on an unsupported host or unavailable round so you can fall back to bundled content.
- **`OR.matches.create` / `join` / `list` / `get` / `move` / `resign` / `nudge` / `claim` / `watch`** — async turn-based multiplayer for 2–4 players (see [`docs/proposals/multiplayer-matches.md`](./docs/proposals/multiplayer-matches.md)). All authenticated. Every read is **per-viewer**: the server's rules class for the match's `game` filters `view` to what the requesting seat may see, so a client never holds an opponent's hidden information and there is no raw-state verb. A `move` is an *action* (`{ col: 3 }`), never a board — the server applies it to its own state and answers with the new view, or rejects with a `match/*` code (`MATCH_ERROR_CODES`): `version-conflict` when the `version` you sent is behind (refetch and let the player decide again), `not-your-turn`, or `illegal-move` with the reason in `message`. Those codes describe one call, not the host, and never retire a capability. For a stalled turn, a waiting player can `nudge({ matchUuid })` (a push to the seat on turn, resolving `{ nudgedAt }`; allowed once the turn is a day old and once a day per sender) and, after 14 days without a move, `claim({ matchUuid })`, which resolves the resulting view: with two players left the match finishes scored as it stands (a tie is a draw), with three or four the idle seat is forfeited and the rest play on. Either rejects `match/too-soon` earlier, with a `message` saying when; every summary carries `turnStartedAt` so a game can show those buttons only when they'd be accepted. Gate each on `OR.capabilities.has('matches.nudge')` / `('matches.claim')`. `list` resolves `[]` when signed out or on a host without the verb; everything else rejects. `watch(matchUuid, onChange)` polls `get` every 5 s while the page is visible and the match is unfinished, pauses on `lifecycle` pause and hidden tabs, and stops itself after delivering a `finished` view. Gate the whole multiplayer entry point on `OR.capabilities.has('matches.get')` — the mobile host ships these behind App Store review.
- **`OR.time.now()`** — the server's clock as epoch ms. Use it instead of `Date.now()` for anything that measures real elapsed time, since the device clock is the player's to change. The first call makes one round trip and corrects for its latency; later calls answer from a cached offset, refreshed every 10 minutes and whenever the page returns from the background. Public (works for guests). Never rejects: on a host without the verb or when the request fails it resolves `Date.now()`, so still clamp elapsed times that come out negative or huge.
- **`OR.notifications.schedule` / `cancel` / `list` / `status`** — reminders delivered later as a push on mobile and a bell notification everywhere, e.g. "Clover is awake" when a nap timer ends. `schedule({ key, fireAt, title, body })` creates or **replaces** the reminder under `key` (a lowercase slug such as `'nap-done'`), so you can move one forward on every visit without piling them up; the SDK adds the device time zone. **The platform decides what goes out, not the game:** pushes only for users with game notifications on, at most 5 pending per app, `fireAt` between a minute and 14 days out. There is **no daily cap** while every game is first-party, so keep reminders rare yourself: every game shares the OddsRabbit app's one notification permission. There are **no quiet hours**: a reminder goes out at `fireAt` whatever the local time, so don't schedule for the small hours unless the player set that time in motion (a timer they started). The result's `deliverAt` is kept for compatibility and always equals `fireAt`. Needs the `bridge:notifications` scope and a signed-in user. `schedule`/`cancel` reject with a `notifications/*` code (`NOTIFICATION_ERROR_CODES`), which never retires a capability; `list` resolves `[]` when signed out or unsupported. `status()` resolves `{ push }`: whether a reminder push would reach the viewer right now (their Games and Game reminders settings are on and they have a phone); when it's false the reminder still lands in the bell, and it resolves `null` when it can't say. Players can mute reminders on their own with the Game reminders setting, separately from daily results. A tapped reminder opens the game with `initialState.target === 'play'` (web also passes `reminderKey`). Gate the UI on `OR.capabilities.has('notifications.schedule')` — the mobile host ships these behind App Store review.
- **`OR.showcase.publish` / `friends` / `get`** — a small JSON snapshot of the game that the viewer's friends can look at (a pet's name, coat and burrow, say). "Friends" means people the viewer follows or who follow them, with no block between them. `publish(data)` creates or **replaces** the viewer's snapshot: an object of at most 8 KB of JSON, rate-limited to 30 a minute, so publish on meaningful changes. `friends({ limit? })` resolves friends' snapshots, most recently updated first (default 50, max 100); only people who have published appear. `get(userUuid)` resolves one person's snapshot or `null` if they haven't published, and rejects `social/not-connected` for someone the viewer isn't connected to. The platform never reads `data`; validate your own shape. Needs the `bridge:social` scope and a signed-in user. `publish` rejects with a `social/*` code (`SOCIAL_ERROR_CODES`); `friends` resolves `[]` when signed out or unsupported, and `get` resolves `null`. Rows are parsed one at a time, so a bad row drops itself.
- **`OR.gifts.send` / `inbox` / `claim` / `sentToday`** — small gifts between friends (same follow-graph rule as showcases). The platform only carries them: `kind` is your word (`[a-z0-9-]{1,32}`, e.g. `'clover'`) and you pay out on claim. `send({ toUserUuid, kind, message? })` (message: one line, up to 80 characters) allows **one gift per friend per UTC day and 10 a day in all**; the recipient gets a bell notification (and a push if their game reminders are on) that opens the game with `initialState.target === 'play'`. `inbox()` resolves unclaimed gifts from the last 7 days, newest first (at most 50); older ones vanish. Each row's `counts` says whether the sender's email is verified: the server's say on whether it may earn the recipient anything (`true` from hosts that predate the field). `claim(giftUuid)` resolves `{ giftUuid, kind, claimedAt }` once and rejects `gifts/claimed` after that, so pay out on the resolve. `sentToday()` resolves the uuids the viewer has already gifted today, to grey out the button. Needs the `bridge:social` scope and a signed-in user. `send`/`claim` reject with a `gifts/*` code (`GIFT_ERROR_CODES`), which never retires a capability; `inbox` and `sentToday` resolve `[]` when signed out or unsupported. Gate the UI on `OR.capabilities.has('gifts.send')`.
- **`OR.visits.record` / `inbox` / `seen` / `sentToday`** — visits to friends' homes (same follow-graph rule as showcases). A sibling of gifts with its **own** slot: **one visit per friend per UTC day and 10 a day in all**, whatever gifts were sent. `record({ toUserUuid, kind })` resolves `{ visitUuid, visitedAt }`; `kind` is your word (`[a-z0-9-]{1,32}`, e.g. `'snack'`). The friend gets a bell notification (and a push if their game reminders are on) whose line comes from your manifest's `social.visitLines`, a map from `kind` to one line with a single `{username}` placeholder (at most 16 kinds, 80 characters each), e.g. `{ "snack": "{username} came by and left a snack." }`; an unknown kind or no map gets "{username} came to visit.". Nothing the game sends at runtime reaches the push. `inbox()` resolves visits from the last 7 days, **seen and unseen**, newest first (at most 50): `{ visitUuid, kind, visitedAt, seenAt, from, showcase, counts }`, where `showcase` is the visitor's current snapshot for your game (or `null`; validate it like any `showcase.get` data) and `counts` is whether the visitor's email is verified. `seen(visitUuids)` (at most 50) resolves `{ seen, seenAt }` where `seen` lists only the uuids **this call** moved from unseen to seen, so pay out for exactly those and two devices can't both pay. An empty list resolves `{ seen: [] }` without a host call. `sentToday()` resolves the uuids the viewer has visited today. Needs the `bridge:social` scope and a signed-in user. `record`/`seen` reject with a `visits/*` code (`VISIT_ERROR_CODES`), which never retires a capability; `inbox` and `sentToday` resolve `[]` when signed out or unsupported. Gate the UI on `OR.capabilities.has('visits.record')`.
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

**Header and safe areas.** The mobile app runs games full-screen with a floating back button in the top-left. Games never use `env(safe-area-inset-*)`. Declare `<meta name="oddsrabbit-chrome" content="edge">` (before the SDK script) to draw edge to edge — under the status bar and home indicator, so screens and overlays reach every edge — padding your content by the `--oddsrabbit-safe-*` variables the host hands you, with your header row laid out beside the back button. Without it the host insets the game itself. See [`docs/game-header-guidelines.md`](./docs/game-header-guidelines.md) for the modes, the variables, the row size and the lane to keep clear.

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
solitaire/      Solitaire — Klondike with daily deals, full-bleed elastic board
flappy-rabbits/ Flappy Rabbits — one-button side-scroller, full-bleed scene
liquid/         Liquid WebGL toy — reference app, no scopes
```

## Contributing

**Issues welcome** — bugs, questions, feature requests.

**PRs by invitation.** The bridge has security boundaries we'd like to keep tight, so please file an issue first; if it's a fit we'll invite a PR. (Same model Stripe and several similar SDKs use — public source for trust and debuggability, controlled contribution for review capacity.)

## License

MIT — see [`LICENSE`](./LICENSE).
