# Unified leaderboard system (global + friends)

Status: proposal. Covers `apps-sdk` (SDK, sandbox host, games), `oddsrabbit-app`
(RN host), and the OddsRabbit WordPress backend — the `oddsrabbit` WP site
(`rest-routes/`, `cron/`), reviewed against a local checkout on 2026‑07‑26.

## 1. Where things actually stand

### Layers a score call passes through

| Layer | Repo / file | Role |
| --- | --- | --- |
| Game | `rabbit-globe/src/main.ts`, `2048/js/leaderboard.js`, … | Calls `OR.scores.*` |
| SDK | `src/sdk/sdk.ts` | Validates + posts bridge messages |
| Sandbox host | `src/host/host.ts` (`apps.oddsrabbit.com`) | Pure relay, schema-gated |
| Outer host (mobile) | `oddsrabbit-app/src/components/app/AppHost.tsx` | Handles verbs natively |
| Outer host (web) | WP `games.js` | Handles verbs for web |
| REST | `/apps/{slug}/…` | Data |

Every score route is scoped per app slug — `GET /apps/{slug}/scores/friends?roundKey=`
(`oddsrabbit-app/src/api/services/app.service.ts:131`). Apps cannot see each
other's rows, so differing puzzle epochs between games are harmless.

### Verb support matrix

| Verb | SDK | Sandbox host | RN host | Web host |
| --- | --- | --- | --- | --- |
| `scores.submit` | ✅ | ✅ | ✅ (type missing `keepBest`) | ? |
| `scores.friends` | ✅ | ✅ | ✅ | ? |
| `scores.distribution` | ✅ | ✅ | ✅ | ? |
| `scores.top` | ✅ | ✅ | ❌ **missing** | ✅ |

Backend (all verified): `oddsrabbit_app_scores` keyed by `app_uuid`, with
`UNIQUE (app_uuid, round_key, user_id)` and
`KEY idx_leaderboard (app_uuid, round_key, score DESC, created_at ASC)`.
Routes live in `rest-routes/routes/apps-routes.php`, logic in
`rest-routes/services/AppScoresService.php`. `/scores/top` **already exists and
is already `public`** (`AppCommunityController::topScores`, with `order=top|first`
and `limit` clamped 1..100). `keepBest` is implemented as an
`ON DUPLICATE KEY … GREATEST(score, VALUES(score))` upsert. Tie-break is already
score DESC, `created_at` ASC everywhere.

### Per-app usage today

| App | roundKey shape | submit | friends | global | distribution |
| --- | --- | --- | --- | --- | --- |
| 2048 | `highscore` (keepBest), `win` | ✅ | ❌ | ✅ | ✅ |
| rabbit-words | `puzzle-N` (epoch 2026‑05‑08) | ✅ | ✅ | ❌ | ✅ |
| rabbit-globe | `puzzle-N` (epoch 2026‑06‑20) | ✅ | ✅ | ❌ | ✅ |
| solitaire | `daily-<id>` | ✅ | ✅ | ❌ | ❌ |
| snake | — | ❌ | ❌ | ❌ | ❌ |
| match3 | — | ❌ | ❌ | ❌ | ❌ |

Three different roundKey conventions, two different leaderboard UIs (globe's
`renderFriendsPanel` + `rowAvatar`, and 2048's `leaderboard.js`, whose comment
admits it "mirrors the RabbitGlobe leaderboard"), zero shared code.

## 2. Two bugs found while reviewing

### 2.1 2048's global leaderboard is broken in the mobile app

`2048/js/leaderboard.js:18` feature-detects with
`typeof OR.scores.top !== "function"`. That is always false — `scores.top` ships
in the SDK bundle. But `AppHost.tsx`'s switch has no `scores.top` case, so the
request falls to `default`, which responds `bridge/unknown-action`. The
`Promise.all` rejects and the modal shows "Couldn't load the leaderboard."

So on mobile the button renders and always fails. **The guard tests the wrong
layer: the SDK always has the method; the capability lives in the host.** This is
the single most important constraint on the design below.

### 2.2 The sandbox host silently drops unknown messages

`src/host/host.ts:214-218` validates every game→host message against
`BridgeRequestSchema` and `return`s without responding when it fails. The SDK
transport has no global timeout (only `content.daily`, 4s), so a message the
deployed host doesn't recognise makes the game's promise **hang forever** rather
than reject. Any new verb shipped to games before the host is redeployed hangs.

### 2.3 `uuid` can be null, and that used to empty the whole board

`AppScoresService::topForRound` and `getForUsersInRound` both `LEFT JOIN`
`wp_user_uuid`, and the controllers emit `'uuid' => $row['user_uuid'] ?? null`.
The SDK's `FriendScoreSchema.uuid` is `z.string().uuid()`, so a user with no
`user_uuid` row fails validation. Until `src/sdk/sdk.ts` was changed to per-row
parsing, one such user emptied the **entire** board (`Schema.array().safeParse`
is all-or-nothing). Now it drops just that row. Server side, either backfill
`user_uuid` or make the join `INNER` so uuid-less users never ship.

### 2.4 The globe friends panel is not broken

`AppScoresController::getFriendsScores` takes `get_following_ids($self)` ∪ self,
then filters to users holding a row for that exact `round_key`. If nobody you
follow submitted a **rabbit-globe** row for today, you get exactly one row —
yours — and `renderFriendsPanel` (`rabbit-globe/src/main.ts:802`) collapses to
"Follow other players on OddsRabbit to compare scores here." Globe is a month
old against rabbit-words' three; an empty panel is the expected output, not a
fault. The copy is what makes it read as broken.

## 3. Design

### 3.1 Host capability handshake (prerequisite)

Games must be able to ask the *host*, not the SDK, what it supports. Backends,
hosts, and the App Store release all move at different speeds; without this,
every new verb is a coin flip.

- Outer hosts add `capabilities: string[]` to the `init` message.
- SDK exposes `OR.capabilities.has('scores.top')`.
- Absent `capabilities` (older hosts) → SDK infers a conservative baseline set
  (`storage.*`, `scores.submit|friends|distribution`, `content.daily`, actions).
- Games hide UI when the capability is absent, instead of feature-detecting the
  SDK surface.
- Belt and braces: SDK treats a `bridge/unknown-action` rejection as
  "unsupported", caches that, and resolves such calls to empty rather than
  rejecting, so a stale host degrades to an empty board, never a hang or a crash.

**Known limit — the handshake is per-verb, not per-field.** Zod strips unknown
keys rather than rejecting them, and `src/host/host.ts` forwards the *parsed*
request (`forwardOutbound(parsed.data)`), so a payload field the deployed
sandbox host's `BridgeRequestSchema` doesn't model is silently dropped in
transit: the call succeeds, the field never arrives, and no capability or error
signals it. Same trap as the `initialState` note in `messages.ts`. This bites
`includeSelf` (§3.5) directly — adding an optional field to an existing verb
still requires a schema change plus a host redeploy *before* any game sends it,
and there is no runtime detection to fall back on. When a new field must be
detectable, make it a new verb instead.

### 3.2 Board taxonomy — the actual problem

A single "global leaderboard" doesn't fit all seven apps. There are three shapes:

| Shape | Fits | roundKey | Ordering |
| --- | --- | --- | --- |
| **All-time best** | 2048, snake, match3 | `alltime` (+ `keepBest: true`) | score DESC |
| **Today's round** | words, globe, solitaire | `puzzle-N` / `daily-<id>` | score DESC, `createdAt` ASC |
| **Season (new)** | words, globe, solitaire | aggregate over `season-YYYY-MM` | SUM(score) or streak DESC |

The season board is the missing piece, and for the daily games it is the one that
builds community. "Today's top 20" resets every night and, for rabbit-words,
collapses into tie-soup (score range 1–6 → hundreds of ties broken only by
submission time). A monthly cumulative board gives daily players something that
compounds — which is the whole point of a daily habit game.

No client can compute it: a game can only read its own storage plus aggregate
endpoints, never other users' round history. **Season boards require new backend
aggregation.**

### 3.3 Shared roundKey convention — **not needed, drop it**

The earlier draft proposed migrating daily keys to `daily-YYYY-MM-DD` so the
server could express "this month" as a key range. That turns out to be
unnecessary: `DailyGameRegistry` (`rest-routes/services/daily-content/DailyGameRegistry.php`)
is already the single server-side source of truth for each daily game's epoch
(`rabbit-words` → 2026‑05‑08, `rabbit-globe` → 2026‑06‑20) and
`epochBySlug()` is already used by `cron/process-game-end-of-day.php` to derive
`puzzle-N` keys. A season endpoint can convert `period=2026-07` into the exact
key list the same way.

So: **keep `puzzle-N` as-is.** No migration of live score rows, no dual-write
window. The one real cost of the current scheme — each game's `EPOCH_MS` being
duplicated in its own client bundle *and* in `DailyGameRegistry` — is a tidy-up
worth doing on its own merits, not a prerequisite for leaderboards.

Caveat: **solitaire is not in `DailyGameRegistry`** (it self-seeds client-side and
writes `daily-<id>`). It needs registering there before it can have a season
board.

### 3.4 Shared UI module

Extract one leaderboard renderer into `apps-sdk/src/ui/leaderboard.ts` plus a
shared `leaderboard.css` copied by `build.config.mjs`, exporting a tabbed panel:

```
[ Friends ] [ Global ] [ Season ]
```

- Rows built with `createElement` + `textContent` only — never `innerHTML`. A
  username is attacker-controlled; both current implementations already follow
  this and the shared one must keep it.
- Default tab: **Friends** when the viewer has ≥1 friend row, else **Global** —
  so a user who follows nobody sees a populated board instead of today's
  "Follow other players on OddsRabbit to compare scores here." dead end.
- Keep the percentile headline ("You did better than 78% of players"). It's
  kinder than a rank and it's already accurate (`truePercentileBelow`).
- Viewer's own row pinned and highlighted; when they're outside the top N, show
  a separated "…  #412 @you" row (needs `includeSelf`, §3.5).
- Source: merge `rabbit-globe/src/main.ts:742-877` (`renderFriendsPanel`,
  `rowAvatar`) with `2048/js/leaderboard.js` (modal, tabs, medals). The `lb-*`
  class names and avatar-hash logic are already identical in both.

### 3.5 Backend surface needed

Already done, no work needed:

- `GET /apps/{slug}/scores/top?roundKey=&order=&limit=` exists and is `public`.
- Tie-break is score DESC, `created_at` ASC, backed by `idx_leaderboard`.
- `keepBest` upsert semantics.

Still to build:

- `includeSelf=1` on `/scores/top` → append the viewer's own row with its true
  rank when it falls outside `limit`. Needs an auth-optional variant of a route
  that is currently fully public; simplest is a separate authenticated
  `/scores/rank` call the client fires alongside.
- `GET /apps/{slug}/scores/season?period=YYYY-MM&metric=sum|max` (public), built
  on `DailyGameRegistry::epochBySlug()` to expand `period` into the app's
  `puzzle-N` list, then
  `WHERE app_uuid = ? AND round_key IN (…31 keys…) GROUP BY user_id`.
- Add covering index `(app_uuid, round_key, user_id, score)`. `idx_leaderboard`
  covers the `(app_uuid, round_key)` range but not the `user_id`/`score`
  projection, so the aggregate currently needs a row lookup per matched row.
- Cache server-side, **not at the edge**: both public score routes deliberately
  call `nocache_headers()` (an edge cache freezes the board at its first read).
  A 5–15 min transient per `(app, period, metric)` is the right shape; if that
  proves insufficient, `cron/process-game-end-of-day.php` already runs
  post-midnight UTC per daily game and is the natural home for a nightly rollup.
- Fix `2048/js/application.js:80` — it claims `metadata.won === true` "sets the
  backend's `won_flag`". There is no `won_flag` column; the win board is just
  `round_key = 'win'` with `order=first`.
- **Decided: `scores.top` is a public read** — guests can fetch it without auth,
  same as `distribution` and `content.daily`. This makes boards usable as a
  marketing surface on the WP game pages. Two consequences: (a) usernames +
  scores become publicly crawlable, so the per-user opt-out below is required,
  not optional; (b) the RN/web hosts must not gate the verb behind a session,
  and the SDK must not gate it behind `OR.user` the way `friends` does.
- Per-user opt-out of *public* boards (friends boards are unaffected — those are
  shared only with people the user chose to connect with).

### 3.6 Follow-from-board (the community-building payoff)

A public board is worth more as a discovery surface than as a ranking. Tapping a
row should offer "Follow" — that converts a global board into friends-graph
growth, which is what makes every *other* social surface in the games work.
Needs a new verb (`actions.openProfile` or `social.follow`); no host implements
one today. Worth scoping as its own slice after Phase 2.

### 3.7 Season metrics — how 30 daily rows collapse into one number

Daily score ranges as they exist today:

| App | Daily score | Month ceiling |
| --- | --- | --- |
| rabbit-words | 0 (loss) or 1–6 (`ROW_COUNT + 1 - guessCount`) | 180 |
| rabbit-globe | 0–15,000 (3 rounds × 5,000, exponential decay) | ~450,000 |
| solitaire | 0 (no win) or 1–3,600 (faster solve = higher) | ~108,000 |

The metric choice is really the answer to "what do we reward — attendance,
skill, or both?" Each option has a specific failure mode:

| Metric | Rewards | Failure mode |
| --- | --- | --- |
| **Total points** (SUM, missed day = 0) | Showing up + playing well | Mostly an attendance chart; a player joining on the 20th is mathematically out, so the board goes stale mid-month for new users |
| **Average points** (mean over days played, min-days qualifier) | Skill; newcomers stay competitive | Playing one more day can *lower* your average — punishes the habit being built. Needs a qualifier rule to explain |
| **Best N of month** (e.g. sum of best 20 days) | Skill + consistency; forgives ~10 missed days; late joiners can still fill their slots | Once 20 good days are banked, late-month days stop mattering. Needs a sentence of explanation |
| **Wins / days played** | Nothing but participation | For words, hundreds tied at 28–30. No skill signal |
| **Longest streak** | Habit, most legible metric | As a *sort key* it's ties all the way down; zero skill component |

**Recommendation**

- **rabbit-globe → total points.** Continuous scores mean effectively no ties, no
  rules to explain, and the number gets satisfyingly large.
- **rabbit-words → total points, tie-broken by fewest total guesses.** The daily
  score already encodes efficiency (6 = solved in one guess), so SUM reads as
  "solved often *and* fast". Do not rank by wins (no skill signal) or by streak
  (tie-soup) — instead display the streak as a badge on the row, so the habit
  signal is visible in the UI without being the sort key.
- **solitaire → total points.** Its daily score is already speed-based.
- **2048 / snake / match3 → not a season but a *monthly best*** (MAX within the
  window) alongside the all-time board. Different aggregation, same board shape.
  This matters more than it sounds: **all-time boards ossify.** After a few
  months the top 20 is frozen and no new player can ever appear on it, which
  destroys exactly the discovery/follow value that justifies making boards
  public. A monthly-best board gives everyone a live target.

**Implementation**: one endpoint with a `metric` param — `sum`, `max`, `best_n`,
`wins`, `streak` — and each app declares which it uses. Ship `sum` and `max`
first; between them they cover all six scoring games. Add `best_n` later if
mid-month drop-off shows up in the data.

The one decision underneath all of this: **SUM treats a missed day as a zero.**
That is precisely what makes it an attendance metric, and it's why it beats
average for a habit game — just be aware it's the choice being made.

## 4. Plan

**Phase 0 — confirm the backend contract** ✅ **done 2026‑07‑26**
Schema, routes, `keepBest`, tie-break, follow graph (`oddsrabbit_user_following`
via `get_following_ids()`), and web-host verb coverage all verified. Net effect:
`/scores/top` and public reads need no backend work, and the roundKey migration
is cancelled (§3.3). Season aggregation is the only substantial new backend work.

Incidental finding: `oddsrabbit_app_user_aggregates` is orphaned — the
`aggregate.count` / `aggregate.read` verbs it backs exist in no route, no host,
and not in the SDK. Worth a cleanup ticket, unrelated to this work.

**Phase 1 — stop the bleeding** ✅ **implemented 2026‑07‑26** (not yet deployed)
1. ✅ RN: `scores.top` added to `AppBridgeRequest`, a case in `AppHost.tsx`, and
   `appService.getTopScores`; `keepBest` added to the submit payload type.
2. ✅ `src/host/host.ts` answers schema-rejected requests with
   `bridge/unsupported-request` when a `correlationId` is recoverable.
3. ✅ Capability handshake: `init.capabilities` in the schema,
   `OR.capabilities.has()/all()` in the SDK, `HOST_CAPABILITIES` declared by both
   the RN host and `games.js` (all three init sites).
4. ✅ `2048/js/leaderboard.js` gates on `capabilities.has('scores.top')` and
   retires the button if a call comes back unsupported.
5. ✅ README documents `scores.top`, `keepBest`, and `capabilities`.

Note the third host error code found while wiring this: the web host rejects
unknown verbs as `bridge/unknown-type`, the RN host as `bridge/unknown-action`,
the sandbox host as `bridge/unsupported-request`. The SDK treats all three as
"unsupported".

Also worth knowing, now that it's detectable: **`actions.requestSignIn` is web-only.**
The RN host has no case for it (auth gates entry to the app, so there's nothing
to prompt). Games calling it on mobile hit the switch default. Harmless today
because the signed-out CTA can't appear there, but it belongs in the capability
list rather than in tribal knowledge.

**Phase 2 — the shared system**
1. Build `src/ui/leaderboard.ts` + shared CSS; wire into `build.config.mjs`.
2. Adopt in rabbit-globe (Global + Friends tabs), then rabbit-words, then
   solitaire. Delete the per-app duplicates.
3. Add `alltime` boards to snake and match3 (they already bootstrap the SDK but
   submit nothing — cheapest new leaderboards on the board).
4. ~~roundKey convention migration~~ — cancelled (§3.3).

**Phase 3 — season boards**
1. Backend aggregation endpoint + covering index + transient cache (§3.5);
   register solitaire in `DailyGameRegistry` first.
2. SDK verb `scores.season` + schema.
3. Season tab in the shared UI; make it the default global board for
   rabbit-words, where a daily global board is meaningless.
4. Opt-out setting surfaced wherever account settings live.

**Phase 4 — deploy discipline**
Ship order is forced: **backend → SDK + sandbox host → games → RN app.** The RN
release trails by App Store review, so games must tolerate a host without the new
verbs for weeks — which is exactly what Phase 1.3 buys. Note `dist/` is untracked
and the local build predates rabbit-globe entirely (June 1 vs June 23), so a
`npm run build` + full upload is part of every step here, including
`dist/host/host.js`, not just the changed game.

Why `dist/host/host.js` specifically leads the games: the *currently deployed*
sandbox host predates `BridgeInitSchema.capabilities`, and Zod strips undeclared
keys, so it silently removes `capabilities` from every `init` it relays. Until
that upload lands, games see no declaration at all and fall back to
`LEGACY_CAPABILITIES` regardless of what the outer host sends. That degrades
correctly — 2048 shows the button, the first `scores.top` call is rejected, the
button retires — but the handshake is inert until the host is redeployed, so the
ordering above is a correctness requirement, not a preference.

## 5. Open questions

1. ~~Backend repo path~~ — reviewed; see header.
2. ~~Should guests read global boards?~~ **Decided: yes** — and already how
   `/scores/top` is registered, so no work (§3.5).
3. Season metric per game — recommendation in §3.7, pending sign-off.
4. Is `highscore` → `alltime` worth a data migration, or should `alltime` just be
   an alias the backend accepts?
