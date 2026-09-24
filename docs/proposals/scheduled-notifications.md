# Game-scheduled notifications and a server clock

Status: **accepted, Phase 1 and the mobile host implemented 2026‑09‑24** (not
yet deployed, migration not yet run, crontab line not yet added). Covers
`apps-sdk` (schema, SDK), the web host (`inc/js/pages/games.js`), the mobile
host (`AppHost.tsx`, `app.service.ts`) and the WordPress backend
(`rest-routes/`, `cron/`, `migrations/`). Motivated by
[`rabbit-pets.md`](./rabbit-pets.md), but nothing here is specific to that
game.

**What landed, and where** (2026‑09‑24):

- apps-sdk:
  - `time.now` and `notifications.{schedule,cancel,list}` in
    `src/schemas/messages.ts`, with `NOTIFICATION_ERROR_CODES` and the
    result schemas.
  - `bridge:notifications` in `src/schemas/manifest.ts`.
  - `OR.time.now()` and `OR.notifications.*` in `src/sdk/sdk.ts`.
  - Tests in `src/sdk/notifications.test.ts` and
    `src/schemas/notifications.test.ts`.
  - README entries.
- WordPress:
  - `migrations/20260924_001_create_app_scheduled_notifications.sql`.
  - `inc/php/classes/Services/AppNotificationPolicy.php`, which is pure and
    tested in `tests/php/Services/AppNotificationPolicyTest.php`.
  - `rest-routes/services/AppScheduledNotificationService.php`.
  - `AppNotificationsController` and `AppTimeController`, with routes in
    `apps-routes.php`.
  - `cron/process-app-scheduled-notifications.php` and its `CronMonitor`
    threshold.
  - The table in `docs/references/SQL_TABLE_SCHEMA.md`, and its `user_id`
    classified DELETE in `AccountErasureManifest`, so a deleted account's
    pending reminders don't still send.
  - `games.js`: the four verbs, `HOST_CAPABILITIES`, and `?reminder=`
    forwarded as `initialState.reminderKey`.
- oddsrabbit-app: the four verbs in `AppHost.tsx` and `app.service.ts`,
  `HOST_CAPABILITIES`, and the bridge types in `src/types/app.ts`.
- Verified:
  - `npm test` in apps-sdk (59 pass) and the full PHPUnit suite (1,842 pass).
  - `tsc` in both TypeScript repos.
  - The migration and `AppScheduledNotificationService` against a throwaway
    MySQL 8.0 in strict mode, with a wpdb shim and stubbed push and bell
    services (54 checks).
  - **Not verified end to end.** Nothing ran against the Local site or a
    real device. The controllers, routes, rate limits and cron bootstrap were
    only linted.

**Decisions taken while implementing** that refine the text below:

- **`user_id`, not `user_uuid`**, in the table. This matches `app_scores`
  and the settings table the opt-in join reads.
- **No `data` field on `schedule`.** Current mobile builds forward only
  `target` and `roundKey` from a tapped `game_result` push, so game data
  would reach the game on web and never on mobile. A tapped reminder opens
  the game with `initialState.target === 'play'`. Web adds
  `initialState.reminderKey`, which is a hint only.
- **The time route is `/apps/time.json`**, like `/apps/jwks.json`. A plain
  `/apps/time` would also match the `/apps/{slug}` manifest route.
- **A second daily cap, on deliveries of any kind (6 a day).** Without it, a
  game rescheduling one key every minute could fill the bell even though
  pushes stop at 2. Past it, nothing is written.
- **Old zone names are mapped to current ones.** Chrome reports
  `Asia/Calcutta`, and a PHP build without tzdata's "backward" file rejects
  it. Unknown zones fall back to UTC.
- **To do before a game can use this:**
  - Run the migration.
  - Add the crontab line.
  - Give the app `bridge:notifications` in `tools/setup-apps-platform.php`
    and approve that version.
  - Ship the mobile host in the next App Store release. Until then games
    gate on the capability.

Assumes the conventions in
[`unified-leaderboard.md`](./unified-leaderboard.md) §3.1 and
[`multiplayer-matches.md`](./multiplayer-matches.md) §5:

- New behaviour ships as a new verb, never as a new field on an existing one.
- Games gate UI on `capabilities.has(verb)`.
- New verbs are not added to `LEGACY_CAPABILITIES`.

## 0. Goal and shape

Two small things games can't do today:

1. **Ask for a reminder later.** "Your nap is over" at 14:32, delivered as a
   push on mobile and a bell notification everywhere, **within platform
   limits the game can't override.**
2. **Know the real time.** `Date.now()` is the device clock, which the player
   controls. Any game that measures real elapsed time needs a clock the
   player can't wind forward.

## 1. What exists today, and what is missing

### 1.1 Reusable as-is

- `PushNotificationService` (`inc/php/classes/Services/`):
  - `sendBatch()` sends through Expo in chunks of 100 and deactivates dead
    tokens.
  - The master switch `push_notifications_enabled` is applied on
    `sendToUser`.
  - Sends are logged to `oddsrabbit_push_sends`.
- `AppGameNotificationService::bulkInsertInAppNotifications()` writes the bell
  row and broadcasts it over Pusher, so web tabs that are open update live.
- The `game_result` push payload (`buildPayload`) plus the mobile tap routing
  in `AppNavigator.tsx`. Tapping one opens `GamePlay` for `appSlug` with
  `initialState.target`.
- The per-user opt-in `games_notifications_push`
  (`InAppNotificationService::isUserOptedInForPush`).
- The "due-time queue swept by a per-minute cron" pattern:
  - `in_app_notifications.push_due_at` (migration `20260914_006`)
  - `cron/process-vote-push-flush.php`: `GET_LOCK` and `CronMonitor`

### 1.2 Missing

- A way for a **game** to ask for a notification. Every game push today is
  written by first-party server code: `process-game-end-of-day.php` and
  `MatchNotificationService`.
- Any server time available to the game. `AppStorageService` records
  `updated_at` but doesn't return it, and `init` has no time field.
- A manifest scope for notifications. `BRIDGE_SCOPES` is
  `['bridge:storage', 'bridge:share']`.
- `sendBatch` does **not** check per-type opt-ins (noted when creator-post
  notifications were added), so the new sender has to filter on
  `games_notifications_push` itself.

## 2. Server clock: `time.now`

### 2.1 Verb

```ts
OR.time.now(): Promise<number>   // server epoch ms, round-trip corrected
```

The SDK sends `time.now` and records `t0`/`t1` around it. It takes
`serverMs + (t1 − t0) / 2` as the server time at `t1` and caches
`offset = that − t1`. Later calls return `Date.now() + offset` without
another round trip, and refresh the offset after 10 minutes or on
`visibilitychange → visible`. This last case matters because a phone that
sleeps for hours can come back with its clock changed.

### 2.2 Why a verb and not a field on `init`

`init` is sent once, when the game frame starts. The web page that
produces it may have been rendered minutes earlier, and a game can stay open
for hours. A field there would be stale by an unknown amount, and fixing
that means round trips anyway. A verb is also detectable through
`capabilities.has('time.now')`, which a field isn't (house rule above).

### 2.3 REST

```
GET /apps/time.json   →  { "status": "success", "serverTime": "2026-09-24T14:32:05.123Z" }
```

- Public, with no auth. It reveals nothing.
- Must be served **`Cache-Control: no-store`**, and excluded from any edge
  cache rule in [`../deploy-cache-policy.md`](../deploy-cache-policy.md). A
  cached clock is worse than none.
- Rate limit: 60/min per IP. Normal use is a handful of calls a session.

### 2.4 What it does not do

It stops a player fast-forwarding by changing the device clock. It doesn't
make client-written state trustworthy: a player can still write anything to
`OR.storage`. Games where one player's state affects another's need
server-side validation. That is beyond what this verb is for.

## 3. Notifications: data model

Migration `20260924_001_create_app_scheduled_notifications.sql`. The table
is documented in `docs/references/SQL_TABLE_SCHEMA.md`. Its columns:

- `app_uuid`, `user_id` and `notif_key`, which together are unique.
- `title` and `body`.
- `fire_at` (what the game asked for) and `deliver_at` (after quiet hours),
  plus `user_tz`.
- `status`: `pending`, `sending`, `sent`, `cancelled` or `skipped`.
- `skip_reason`.
- `pushed`: whether a device push went out, which the daily push cap counts.
- `claim_id`: the cron run that is sending the row.
- `sent_at`, `created_at` and `updated_at`.

**One row per `(app, user, key)`.** A reschedule under the same key is an
upsert that overwrites the pending row and resets `status` to `pending`. This
is the property games rely on: the pet game moves `misses-you` forward on
every visit without piling up reminders.

## 4. Platform policy (enforced by the server, not the game)

| Rule | Default | Where |
| --- | --- | --- |
| App must hold the `bridge:notifications` scope | required | `AppRegistryService::hasScope()` on schedule |
| Pending keys per (app, user) | ≤ 5 | Schedule, `notifications/too-many` |
| `fireAt` window | now + 60 s … now + 14 days | Schedule, `notifications/bad-time` |
| Title / body length | 64 / 160 chars | Schema and server |
| Quiet hours | 22:00–08:00 in `user_tz`. A delivery due then is **deferred** to 08:00, not dropped. | `deliver_at` computed on schedule |
| Daily push cap | ≤ 2 **pushes** per (app, user) per local day | Cron at send time. Over it, the row is still sent to the bell with `skip_reason: daily_cap`. |
| Daily delivery cap | ≤ 6 deliveries of any kind per (app, user) per local day | Cron at send time. Over it, the row is `skipped: daily_cap` and nothing is written. |
| Games opt-in | `games_notifications_push` on | Cron at send time. Off means bell only, with `skip_reason: opted_out`. |
| Schedule rate | 30/min per user | Route |

Notes:

- **The cap applies to pushes, not bell rows.** When the daily cap or opt-out
  skips the push, the bell row is still written, because a bell entry is
  passive. Open question 2 revisits this.
- **Deferral changes the text, not just the time.** "Your nap is over" at 08:00 is
  still true. Games should write copy that stays true after a delay. Put
  this in the README.
- A game **cannot target another user**. `user_id` always comes from the
  session.

## 5. Bridge verbs

| Verb | Payload | Result |
| --- | --- | --- |
| `notifications.schedule` | `{ key, fireAt, title, body }` where `fireAt` is an ISO datetime and `key` matches `[a-z0-9-]{1,64}`. The SDK adds `tz` from `Intl.DateTimeFormat().resolvedOptions().timeZone`. | `{ key, fireAt, deliverAt, serverTime }` |
| `notifications.cancel` | `{ key }` | `{ key, cancelled: boolean }` |
| `notifications.list` | `{}` | `{ pending: [{ key, fireAt, deliverAt }], serverTime }` |

- `schedule` returns `serverTime` so a game that schedules often can refresh
  its clock offset for free.
- `list` lets a game reconcile after being opened on another device.
- Errors `notifications/too-many`, `notifications/bad-time` and
  `notifications/forbidden` (missing scope) are per-call results. They must
  **not** be added to `UNSUPPORTED_CODES`, the same reasoning as `match/*`.

**Not in this proposal:** `notifications.status` and
`notifications.requestPermission`. On mobile these would expose the OS
permission and the Games setting to the game, so it could avoid asking
"want a nudge?" when pushes are off. They're useful, but they are
mobile-host-only and can follow later without changing anything above
(open question 3).

## 6. Sending

`cron/process-app-scheduled-notifications.php`, **every minute**, following
the pattern of `process-vote-push-flush.php`:

1. `GET_LOCK('app_scheduled_notifications')`, then `CronMonitor::start()`.
2. Claim up to 500 due rows with a fresh `claim_id`:
   `UPDATE … SET status='sending', claim_id=? WHERE status='pending' AND deliver_at <= UTC_TIMESTAMP() ORDER BY deliver_at LIMIT 500`.
   Then `SELECT … WHERE claim_id=?`. MySQL's `UPDATE` can't return the rows
   it touched, so the claim id is how this run finds exactly its own rows.
3. Per row:
   - Opt-in check.
   - Daily-cap check: count `sent` rows for (app, user) since local
     midnight in `user_tz`.
   - Build the payload:
     - `type: 'game_result'`, `appSlug`, `target: 'play'`
     - `reminderKey`, `appName`, `appIcon`
     - `collapse_id: app_reminder:{slug}:{key}`
     - `link: /games/{slug}/?target=play&reminder={key}`

     Reusing `game_result` means **existing mobile builds already route the tap
     into the game** (open question 1).
4. Send through `PushNotificationService::sendBatch()`. Write bell rows
   through `bulkInsertInAppNotifications()`.
5. Mark rows `sent` or `skipped` with a reason. A row stuck in `sending` for
   more than 10 minutes (the cron crashed) goes back to `pending` on the next
   run.
6. `CronMonitor::success()`, and an entry in `overdueThresholds()` with
   `* * * * *`.

**The crontab line has to be added by hand on Cloudways.** List it in the
deploy notes, or the feature silently does nothing.

## 7. Bridge, SDK, and host changes

1. `src/schemas/messages.ts`:
   - Request variants for `time.now`, `notifications.schedule`,
     `notifications.cancel` and `notifications.list`, plus their result
     schemas.
   - Add `'bridge:notifications'` to `BRIDGE_SCOPES` in
     `src/schemas/manifest.ts`.
2. `src/sdk/sdk.ts`:
   - `OR.time.now()` with the offset cache (§2.1).
   - `OR.notifications.{schedule, cancel, list}`, with `tz` filled in
     automatically.
   - Tests for the offset maths and the payload refines.
3. `src/host/host.ts`: the schema import only. It's a relay.
4. `games.js`: four cases calling REST, and four entries in
   `HOST_CAPABILITIES`.
5. `AppHost.tsx` + `app.service.ts` + `AppBridgeVerb`: the same four. **These
   ship behind App Store review**, so games must gate on
   `capabilities.has('notifications.schedule')` / `has('time.now')`.
6. README: both namespaces, the policy table in §4, and the
   "copy must survive deferral" note.

REST (WP). Everything except `/apps/time` uses `modern_auth`:

```
GET    /apps/time.json                              time.now (public, no-store)
PUT    /apps/{slug}/notifications/{key}             schedule (upsert)
DELETE /apps/{slug}/notifications/{key}             cancel
GET    /apps/{slug}/notifications                   list (viewer's, this app)
```

Also: `AppNotificationsController` and routes in `apps-routes.php`, plus
`AppScheduledNotificationService` for the policy in §4.

## 8. Plan

**Phase 1 — web** (~1 week)

1. Migration and service, with pure-PHP tests for quiet-hour shifts across
   DST and the daily cap at local midnight. Model these on
   `tools/test-match-rules.php`.
2. Routes, the controller and `/apps/time`.
3. The cron script, `CronMonitor` threshold and crontab line.
4. Schema, SDK verbs and tests. Sandbox host schema bump.
5. `games.js` verbs and capabilities.

Exit criterion: on web, a game schedules `test` for now + 2 min and a bell
row appears. Rescheduling the same key replaces it. A reminder due at 23:00
local is delivered at 08:00. A third push in one local day is skipped with
`daily_cap`.

**Phase 2 — mobile**

1. `AppHost.tsx` verbs and capabilities.
2. A real-device check that tapping the push opens the game with
   `initialState`.

**Phase 3 — later**

`notifications.status` / `requestPermission` (§5), and per-app policy
overrides in app meta if a game needs something other than the defaults.

## 9. Deliberately out of scope, with what each would cost

- **Recurring schedules** ("every day at 9"). Games reschedule on each visit
  instead, which also stops reminders for players who have left. A recurring
  rule would keep pinging people who quit, which is exactly the spam this
  policy exists to prevent.
- **Notifying other users** (friend gifts, "your friend fed your rabbit").
  That needs a social-permission model: who may notify whom, and blocking.
  It is not a small addition to this table.
- **Web push.** There are no VAPID keys or service worker today. The bell
  row and Pusher cover open tabs, and the phone covers everything else.
- **On-device scheduling through `expo-notifications`.** It works on one
  device only, does nothing on web, and would duplicate the server's policy
  in the app.
- **Email.** `oddsrabbit_email_queue` could carry reminders later. Email
  would need its own, much lower cap.

## 10. Open questions

1. **Reuse `game_result` or add an `app_reminder` type?** Reusing it gets tap
   routing on every existing build. A new type gets its own settings row and
   bell filter, but needs an app release first. Recommendation: reuse for
   Phase 1 and split later if players want to mute reminders without muting
   results.
2. **Bell rows for capped or opted-out pushes.** Write them (current text), or
   skip them too, so opting out means silence?
3. **Should the game see the push permission state** (`notifications.status`)
   at launch? Without it the pet game may offer reminders to someone whose
   pushes are off. They'd still get bell rows, so it's harmless but a little
   misleading.
4. **Default quiet hours** 22:00–08:00. Should they be per-user
   (a new settings column) rather than platform-wide?
