# Unified leaderboard system (global + friends)

Status: **accepted** — every open question closed 2026‑07‑27 (§5); Phase 1
implemented but **not yet deployed** (§4). Covers `apps-sdk` (SDK, sandbox host,
games), `oddsrabbit-app` (RN host), and the OddsRabbit WordPress backend — the
`oddsrabbit` WP site (`rest-routes/`, `cron/`), reviewed against a local
checkout on 2026‑07‑26.

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
is all-or-nothing). Now it drops just that row. **Decided: backfill `user_uuid`
server side.** Making the join `INNER` is the smaller change but it permanently
hides those users rather than fixing them — they would stay invisible on boards
they have earned a place on. No longer urgent now that per-row parsing contains
the blast radius to the affected row.

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
- Absent `capabilities` (older hosts) → SDK falls back to `LEGACY_CAPABILITIES`
  (`src/sdk/sdk.ts`), which currently lists **every** verb in
  `BRIDGE_REQUEST_TYPES`. **Decided: optimistic, not conservative.** A wrong
  entry costs one rejected call, which runtime detection then corrects for the
  rest of the session; a wrong omission is a feature that never appears on a
  host that does support it. Accepted cost: on a pre-handshake host — in
  practice the RN app during App Store review — 2048 shows the leaderboard
  button, the first `scores.top` call is rejected, and the button retires
  mid-session. Note the list is a **historical snapshot, not a mirror of the
  schema**: do not add new verbs to it, or every pre-handshake host will be
  assumed to implement them.
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
| **All-time best** | 2048 | `highscore` (+ `keepBest: true`) | score DESC |
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

- ~~`includeSelf=1` on `/scores/top`~~ — ✅ **shipped 2026‑07‑28** as two
  authenticated companion routes rather than a flag on the public ones. Client
  wiring landed the same day; see Phase 3.5 in §4.

  ```
  GET /apps/{slug}/scores/rank?roundKey=&order=top|first      (modern_auth)
    → { rank: null }                       — viewer hasn't played this round
    → { rank: { rank, total, entry } }     — entry is a scores/top row + isSelf

  GET /apps/{slug}/scores/season/rank?period=YYYY-MM&metric=  (modern_auth)
    → { seasonRank: { period, metric, puzzleDays, qualifyingDays,
                      rank, total, entry } }   — entry is a season row + isSelf
  ```

  Four things the implementation settled:

  - **Companion routes, not `includeSelf` on the board.** `/scores/top` and
    `/scores/season` are deliberately public and server-cached; a viewer-scoped
    field on them would make every response per-user and uncacheable, and would
    need an auth-*optional* variant of a route that is currently plainly public.
    Split, the board stays guest-readable and cached while only the pinned row
    costs a per-viewer query.
  - **`rank: null` with a 200, never a 404.** "You haven't played" is a normal
    answer to "where am I", and a 404 would reach the game as an error state on
    a board that is working perfectly.
  - **Rank is counted, and the ordering had to be made total first.**
    Both routes count the rows strictly ahead of the viewer under the board's
    own `ORDER BY` rather than using a window function. `topForRound` ended in
    `created_at ASC`, which is not a total order — two rows tied on score and
    timestamp ordered arbitrarily, so a counted rank could disagree with the
    position the viewer can see. Both board queries now end in `s.user_id ASC`
    and both comparisons mirror them exactly.
  - **Averages compare by cross-multiplication.** `qualified_avg` ranks on
    `AVG()`, a DECIMAL, and the viewer's average would arrive back as a bound
    PHP float — an exact tie could then compare either way depending on
    rounding. `SUM(them) × days(me) > SUM(me) × days(them)` is integer
    arithmetic and exact.

  Also folded in: `qualifyingDays` and the season metric whitelist moved to
  `DailyGameRegistry` (`qualifyingDaysFor()`, `SEASON_METRICS`), since the
  qualifier now has three callers and a viewer ranked above the line on the
  board and below it on their own pinned row would be worse than having neither.

  **Season is where this earns its keep.** On a daily board a viewer outside the
  top 20 has at least just played and knows their score. A season board ranks an
  aggregate the player cannot compute for themselves, so falling outside `limit`
  means the board says nothing whatsoever about them — and for rabbit-words that
  board is now the default tab and the game's first global board of any kind.

  Not cached, unlike the boards: the rank query is per-viewer, so a transient per
  user per period would trade a bounded index-covered read for unbounded
  `wp_options` growth. If it shows up in profiling, the nightly rollup in
  `cron/process-game-end-of-day.php` is the escape hatch (see the season bullet).
- ~~`GET /apps/{slug}/scores/season`, covering index, server-side cache~~ —
  ✅ **shipped 2026‑07‑27**, see Phase 3 item 2 in §4 for the delivered contract
  and the four decisions the implementation settled. Three details below were
  wrong as specified and are corrected there, not here: the metric set is
  `sum|max|qualified_avg` (not `sum|max`); round keys are derived per app from
  `dailySchedules()` with an explicit `roundKeyPrefix`, so the `puzzle-N`
  assumption baked into this bullet is exactly what had to be removed
  (solitaire is `daily-N` off a 2026‑01‑01 epoch); and the transient is 10 min
  for the live month, 12 h once the month is closed, rather than a flat 5–15
  min. The rest still holds — the aggregate is
  `WHERE app_uuid = ? AND round_key IN (…) GROUP BY user_id` over covering
  index `idx_season_aggregate (app_uuid, round_key, user_id, score)`, because
  `idx_leaderboard` covers the `(app_uuid, round_key)` range but not the
  `user_id`/`score` projection; and the cache is server-side **not** at the
  edge, since both public score routes deliberately call `nocache_headers()`
  (an edge cache freezes the board at its first read). If the transient proves
  insufficient, `cron/process-game-end-of-day.php` already runs post-midnight
  UTC per daily game and is the natural home for a nightly rollup.
- ~~Fix `2048/js/application.js:80` — there is no `won_flag` column~~ —
  **retracted 2026‑07‑27, the original comment was right.** `won_flag` does
  exist — **in the `oddsrabbit` WP repo, not this one**, which is why grepping
  here finds nothing but the 2048 comment and this line.
  `migrations/20260522_004_index_app_scores_for_achievements.sql` adds it
  as a STORED generated column over `metadata.won`, indexed by
  `idx_app_scores_user` and read by `AppAchievementEvaluator`. So
  `metadata.won === true` really does set it. Nothing to fix in 2048 — and had
  this been actioned, a correct comment would have been replaced with a wrong
  one. (Separately, the win *board* is indeed just `round_key = 'win'` with
  `order=first`; that part was accurate, it simply doesn't bear on `won_flag`.)
- **Decided: `scores.top` is a public read** — guests can fetch it without auth,
  same as `distribution` and `content.daily`. This makes boards usable as a
  marketing surface on the WP game pages. Two consequences: (a) usernames +
  scores become publicly crawlable, hence the opt-out below; (b) the RN/web
  hosts must not gate the verb behind a session, and the SDK must not gate it
  behind `OR.user` the way `friends` does.
- ~~Per-user opt-out of *public* boards~~ — **removed from scope 2026‑07‑27.**
  First deferred behind Phase 2, then dropped from Phase 3 entirely; it is not
  scheduled against any phase.

  Recorded rather than deleted, because the consequence is standing rather than
  temporary: a signed-in player's username and score are publicly readable with
  no way to decline, and the WP game pages carrying those boards are indexable.
  Friends boards are unaffected — those are shared only with people the user
  chose to connect with.

  If it is ever picked up, the design note that mattered still holds: it has to
  suppress **existing** rows, not just future submissions, or a player who opts
  out stays visible for everything already recorded.

### 3.6 Follow-from-board (the community-building payoff)

A public board is worth more as a discovery surface than as a ranking. Tapping a
row should offer "Follow" — that converts a global board into friends-graph
growth, which is what makes every *other* social surface in the games work.
Needs a new verb (`actions.openProfile` or `social.follow`); no host implements
one today. Worth scoping as its own slice after Phase 2.

### 3.7 Season metrics — how a month of daily rows collapses into one number

A season is a **calendar month**, not a rolling 30-day window, so its length
varies (28–31) and a game's launch month is partial. Anything derived from the
window length — notably `Q` below — must come from the keys
`DailyGameRegistry` expands for that `period`, never from an assumed 30.

Daily score ranges as they exist today:

| App | Daily score | Month ceiling (~30 days) |
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
| **Qualified average** (days played capped at `Q`, tie-broken by mean) | Attendance to qualify, then skill; playing more never hurts you | Below `Q` your average stops counting for anything, so it reads as a wall to casual players. Needs the qualifier stated on the board |

**Recommendation**

- **rabbit-globe → total points.** Continuous scores mean effectively no ties, no
  rules to explain, and the number gets satisfyingly large.
- **rabbit-words → qualified average.** Rank by `min(days_played, Q)` descending,
  tie-broken by mean score across days played. Words is the one game where SUM
  is indefensible: with only seven possible daily values, a monthly total is
  dominated by how many days you showed up rather than how well you played.

  Reads on the board as one line — *"play 2 days in 3 to qualify, then your
  average ranks you."* The cap is what makes it work; without it the sort is
  lexicographic and 31 days at average 2.0 beats 30 days at average 6.0, so a
  single missed day outranks any amount of skill and the board is unwinnable for
  most players by the 8th. Capping means missing up to a third of the month
  costs nothing, everyone committed lands in the same tier, and the average
  becomes the real sort rather than a rare tie-break.

  It also closes the farming hole: a loss still records a row at score 0, so
  bare days-played is maximised by opening the puzzle and typing anything. Above
  `Q` that stops paying, and below `Q` it actively hurts — the zero drags the
  average that decides your rank.

  Do not rank by wins (no skill signal) or by streak (tie-soup). Show days played
  and streak as row badges instead, so the habit signal is visible without being
  the sort key.

  **`Q` gates the ranking, not the board.** `seasonForPeriod` orders by
  `LEAST(COUNT(*), Q) DESC, avg_score DESC` with no `HAVING`, so a player below
  `Q` is still returned — ranked under everyone who met it, however good their
  average. That is the right call (a wall you can see past is kinder than one
  you vanish behind), but it means the board deliberately shows rows whose
  average did *not* place them, so the UI has to mark them or the ordering
  reads as a bug. `src/ui/season.ts` badges those rows with progress toward the
  cap — "14/21 days" rather than "14 days" — and the board's caption states
  what happens below the line. Do not "fix" this by adding a `HAVING`: that
  brings back the empty-board-until-two-thirds-of-the-month problem the
  `puzzleDays` cap was introduced to solve.

  **Known rough edge: the first few days of every month.** `puzzleDays` capped
  at today means `Q` is 1 on the 1st and 2 on the 3rd, so a board meant to rank
  a month of play ranks an average over one to three values drawn from
  `{0, 1…6}` — the same tie-soup a daily global board would have been, and for
  rabbit-words it is the tab that opens by default. It resolves itself within
  about a week and the alternative (a fixed floor on `Q`) just moves the empty
  board back to the start of the month, so this is accepted rather than fixed —
  but it recurs monthly and is worth knowing before reading the first week's
  numbers as signal.

  **`Q` is derived from the period, not hardcoded.** `Q = ceil(puzzle_days × 2/3)`
  where `puzzle_days` is the number of keys `DailyGameRegistry` actually expands
  for that `period` — not calendar days. Seasons are calendar months, so length
  varies (Feb 28 → `Q` 19, Jul 31 → `Q` 21), and a game's launch month is
  partial: rabbit-globe's epoch is 2026‑06‑20, so June 2026 holds 11 puzzle days,
  not 30. A fixed "miss up to 10 days" rule collapses to `Q = 1` there;
  proportional degrades to 8 and stays meaningful.
- **solitaire → total points.** Its daily score is already speed-based.
- **2048 → out of scope for seasons.** ~~Monthly best (MAX within the window)
  alongside the all-time board.~~ **Cut 2026‑07‑27, before shipping.**

  The motivation was and remains real: **all-time boards ossify.** After a few
  months 2048's top 20 is frozen, no new player can ever appear on it, and that
  destroys exactly the discovery/follow value that justifies making boards
  public. A monthly window would give everyone a live target.

  It cannot be delivered by this endpoint, because 2048 has **no daily rows to
  aggregate**. Its only round keys are the constants `highscore` — submitted
  with `keepBest`, so the server holds exactly one row per player, updated in
  place — and `win`, once per player ever. `period` expands through
  `DailyGameRegistry`, which 2048 is not in and cannot join. Aggregating the
  `highscore` row by its timestamp instead wouldn't rescue it: one row per
  player means the board would rank players by their **all-time** best filtered
  to whoever improved it this month, which is a subset of the all-time board
  next to it, still dominated by the same veterans, and ossified in exactly the
  way the tab was meant to fix.

  What it actually needs is a game-side change, not an aggregation: track the
  month's best in 2048's own storage and submit it under a per-month round key
  (`highscore-YYYY-MM`, `keepBest: true`), then read the board with the existing
  `scores.top`. No season endpoint, no registry entry, no new verb. Worth doing
  — but it is 2048 feature work, not Phase 3.

**Implementation**: one endpoint with a `metric` param — `sum`,
`qualified_avg`, `max`, `best_n`, `wins`, `streak` — and each app declares which
it uses. Ship `sum` (globe, solitaire) and `qualified_avg` (words); between them
they cover every game that gets a season board. `max` is specified but has no
caller now that 2048 is out, so it need not ship in the first cut. `best_n`
stays unbuilt until mid-month drop-off shows up in the data.

**Adding a metric later is a server-only change, by construction.** The response's
`metric` field is an open string in `SeasonBoardSchema`, not an enum — a bundle
that meets a metric it predates captions the board generically and renders the
rows normally, because the server did the ranking. Had it been closed, shipping
`best_n` would have silently blanked the boards of every deployed globe and
solitaire bundle, since neither sends a `metric` and both take the app's
server-side default. The *request* enum stays closed: a client should only ask
for what it understands.

Note `qualified_avg` needs `puzzle_days` for the period to compute `Q`, which the
endpoint already derives when it expands `period` into the key list — so the cap
costs no extra query, just the count it already has.

The decision underneath the daily games: **SUM treats a missed day as a zero.**
That is precisely what makes it an attendance metric, and for globe and solitaire
that's the right trade — their scores are continuous enough that skill still
separates players inside it. Words is where it breaks down, which is why it gets
a metric that qualifies on attendance and then ranks on skill instead of blending
the two into one number.

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

**Phase 2 — the shared system** ✅ **implemented 2026‑07‑27** (not yet deployed)
1. ✅ `src/ui/leaderboard.ts` + `src/ui/leaderboard.css`, built by
   `build.config.mjs` to `dist/leaderboard-v1.{js,esm.js,css}` with a
   `__UI_VERSION__` content-hash cache-bust hashed over the JS and CSS together.
   Deliberately NOT folded into `sdk-v1.js`: every game loads the SDK, only four
   have boards, and a transport library shouldn't carry DOM rendering.
2. ✅ Adopted in rabbit-globe (Friends + Global), 2048 (High Scores + Hall of
   Fame, via `openLeaderboardModal`), solitaire (Friends + Global), rabbit-words
   (Friends). Every per-app copy of the row/avatar/medal/CTA rendering is gone;
   each game keeps only which rounds it reads and how a value formats.
3. ✅ rabbit-words takes the shared UI but **no Global tab** — its daily global
   board is tie-soup (§3.7), so Friends only until the season board lands in
   Phase 3.
4. ~~Add `alltime` boards to snake and match3~~ — cancelled (§5.3).
5. ~~roundKey convention migration~~ — cancelled (§3.3).

Two things the shared module changed on the way through, both worth knowing:

- **The sign-in prompt is per-tab, not per-panel.** `scores.top` is a public
  read, so a signed-out viewer now gets the Global board with a sign-in prompt
  on Friends alone. Previously globe and words replaced the *whole* panel with a
  CTA for guests — which threw away the public board that §3.5 exists to
  provide.
- **Both vanilla games load a second script tag.** 2048 and solitaire are copied
  verbatim by the build with no bundler, so they reach the module through
  `window.OddsRabbitUI`; globe and words import it and esbuild bundles it. That
  makes `dist/leaderboard-v1.js` a new deploy artifact — see Phase 4, it ships
  with the games, not with the SDK.

**Phase 3 — season boards** ✅ **implemented 2026‑07‑27** (not yet deployed) —
backend, SDK, shared UI, and all three adopting games. Reviewed 2026‑07‑28, see
below. §3.5's `includeSelf` / `/scores/rank` followed in Phase 3.5.
1. ~~Opt-out setting~~ — removed from scope (§3.5).
2. ✅ **Backend** — implemented 2026‑07‑27 in the `oddsrabbit` WP repo.
   `GET /apps/{slug}/scores/season?period=YYYY-MM&metric=sum|max|qualified_avg&limit=`
   → `{ season: { period, metric, puzzleDays, qualifyingDays, entries[] } }`,
   public, `nocache_headers()` plus a server-side transient — 10 min for the
   current month, 12 h once the month is complete and can no longer change.
   `AppCommunityController::seasonScores` → `AppScoresService::seasonForPeriod`,
   covering index `idx_season_aggregate (app_uuid, round_key, user_id, score)`,
   and the `user_uuid` backfill (§2.3). `period` is a **UTC** month, matching
   the boundary every daily app already rolls its puzzle on.

   ✅ **Both outer hosts relay it**: `inc/js/pages/games.js` (web) and
   `AppHost.tsx` + `appService.getSeasonScores` + the `AppBridgeRequest` union
   (mobile), each declaring `scores.season` in `HOST_CAPABILITIES`. So unlike
   `scores.top` in Phase 1, this verb ships to mobile and web together and there
   is no App Store gap for games to degrade across.

   Four things the implementation settled that the design hadn't:

   - **`puzzleDays` is capped at today, not the whole month.** Counting all 31
     days on the 15th puts the qualifier at 21 and leaves the board empty until
     the 21st. Capped, the standard rises with the month — 10 of 15 on the 15th,
     21 of 31 at month end — so the board is live from day one, and a player who
     stops playing drops back out of qualification.
   - **Solitaire is registered in a new `dailySchedules()`, not `games()`.** The
     latter drives content provisioning *and* the end-of-day push cron;
     solitaire seeds its own deals client-side and has no notification copy, so
     adding it there would have silently enrolled it in both. Splitting
     round-key derivation out also forced `roundKeyPrefix` to become explicit —
     solitaire uses `daily-N` off a 2026‑01‑01 epoch, not `puzzle-N`, an
     assumption previously hardcoded in every consumer.
   - **Streak is a second bounded query, not a `GROUP_CONCAT`.** Concatenating
     per-user key lists would build them for every player who touched the month
     before `LIMIT` discards almost all of it, and would silently truncate at
     `group_concat_max_len` — corrupting streaks rather than failing loudly.
   - **`null` means one thing, and the hosts must not widen it.** In the SDK
     `null` is strictly "this host doesn't implement the verb" (an
     unsupported-verb rejection); a malformed board rejects instead. Both hosts
     initially resolved `null` when `season` was missing from a 200, which would
     have turned a server-side regression into a board reading "nobody played
     this month" with nothing logged. Both now error on that case. An app with
     no daily rounds (2048) 404s with `scores/no-season` and also reaches the
     game as an error — games gate the tab on `capabilities.has()` long before
     they would hit it.
3. ✅ `scores.season` verb in `BridgeRequestSchema`, `SeasonEntry`/`SeasonBoard`
   result schemas, and `OR.scores.season()` in the SDK. Resolves `null` (not
   `[]`) on a host without the verb, so a game can hide the tab rather than show
   an empty board; a **malformed** board rejects instead, so a server break
   reaches the player as an error state and not as a month nobody played.
   Correctly **absent from `LEGACY_CAPABILITIES`** — that list is a historical
   snapshot (§3.1), and a pre-handshake host has no season board.
4. ✅ Season presentation shared in `src/ui/season.ts` (`createSeasonTab`), so
   the three call sites carry only their metric. Days played and streak render as
   row badges via the panel's `badges` hook — visible, never sort keys (§3.7).
   Ranks share on `sum` (a plain `value` order, so equal values are real ties)
   and stay positional on `qualified_avg` (ordered by capped attendance first, so
   equal values are not).
5. ✅ Adopted: rabbit-words (`qualified_avg`, **default tab** — this is words'
   first global board of any kind), rabbit-globe (`sum`), solitaire (`sum`).
   2048 is **not** adopted — it has no daily rows to aggregate, see §3.7.

**Review pass 2026‑07‑28** — read back against the shipped backend. Four fixes,
none of them structural; the ranking, the caching, and the `null`/reject
trichotomy all held up.

1. **The board shows unqualified players and didn't say so.** `qualifyingDays`
   was documented as the minimum to *appear*; the SQL has no `HAVING`, so it is
   really the minimum to be ranked on skill. Sub-`Q` rows were rendering with a
   plain day count, under rows with a worse average and nothing to explain why.
   They now badge as "14/21 days" and the caption states what happens below the
   line (§3.7). `rankTies: false` on `qualified_avg` was already correct and is
   now justified against the actual `ORDER BY` rather than against the design.
2. **A `null` season board claimed nobody had played.** `createSeasonTab` folded
   "this host has no season board" into its empty state, which is the exact lie
   `sdk.ts` rejects a malformed envelope to avoid — reintroduced one layer up.
   It now has its own copy. Only reachable when a host declares the verb and
   then rejects it, which is precisely the case nobody would debug.
3. **`defaultTab` is a preference, not a pin.** It suppressed the panel's
   "open on the first tab with rows" rule outright, so words opened on an empty
   Season board on the 1st of a month while Friends had content. It now yields
   to a populated tab if the named one settles empty — and never after the
   viewer has picked a tab themselves.
4. **`SeasonEntry.average` was parsed, carried, and never rendered.** It now
   badges on `sum`/`max` boards, where it is the one figure separating skill
   from attendance — the documented weakness of a monthly total (§3.7). Not on
   `qualified_avg`, where it *is* the ranked value.

Also added: `npm test` (`test.config.mjs` — esbuild + `node --test`, no new
dependency) covering ranking, UTC period arithmetic, metric formatting, and the
season tab's copy and badges. The repo had no tests, and `src/ui/` is now one
artifact shipping shared ranking logic to four games at once.

Backend fix in the same pass: a live month's season transient was keyed on
`(app, period, metric, limit)` with a 10-minute TTL, but `puzzleDays` and the
`qualifyingDays` derived from it step at UTC midnight — so for up to ten minutes
past the rollover the board served yesterday's qualifier while claiming today's.
The UTC day is now part of the key for a live month; a finished month can't move
and still keys on the period alone.

**Phase 3.5 — the viewer's own rank** ✅ **implemented 2026‑07‑28** (not yet
deployed). Backend in §3.5; client across all four layers.

1. ✅ `scores.rank` / `scores.seasonRank` verbs in `BridgeRequestSchema`, with
   `RoundRankSchema` / `SeasonRankSchema` results and `OR.scores.rank()` /
   `OR.scores.seasonRank()` in the SDK. Both resolve `null` when there is
   nothing to pin — no session, no verb on this host, or (for `rank`) the viewer
   hasn't played that round — since a caller does the same thing with all three.
   Both **gate on `OR.user` client-side**: these are the only authenticated
   reads a signed-out viewer could otherwise fire, and the round-trip could only
   ever 401.
2. ✅ Both outer hosts relay them and declare them in `HOST_CAPABILITIES`, so
   like `scores.season` this ships to web and mobile together.
3. ✅ `LeaderboardTab.loadPinned` in the shared panel, plus `PinnedRank`,
   `pinnedFromRank()` and `createSeasonTab({ loadRank })`.
4. ✅ Adopted: rabbit-globe (Global + Season), solitaire (Global + Season),
   rabbit-words (Season), 2048 (High Scores + Hall of Fame, the latter with
   `order: 'first'` to match its board).

Three things the implementation settled:

- **The pinned row loads in its own chain, never alongside the board.** Racing
  it in a `Promise.all` with `load()` turns a rank failure into a dead board —
  which is the exact shape of the 2048 bug in §2.1. The panel fires
  `loadPinned` only after rows land, and swallows its rejection: the board is
  already on screen and correct, the viewer just isn't told where they placed.
- **It isn't fetched at all when the viewer is already on the board.** Their row
  is there and highlighted; a second copy pinned underneath would be worse than
  none. That also makes the common case for a friends board cost no request.
- **Gated on `scores.rank` separately from `scores.top`.** The rank verb ships
  after the board it annotates, so a host can serve one and not the other — and
  on mobile that gap is an App Store review wide. The vanilla games additionally
  check `typeof UI.pinnedFromRank === 'function'`, since they reach the shared
  UI through a script tag that can be an older bundle than the SDK beside it.

Note `2048` is where the pinned row does the most work: its board is all-time
and ossifies (§3.7), so for a newer player it is the only number on the screen
that is theirs to move.

**Review pass 2026‑08‑03 — rabbit-words.** The boards themselves were right
(Friends + Season, no `scores.top`, both rank verbs gated separately). Three
fixes around them:

1. **The past-round modal showed the wrong month's season board.** Both the
   board and the pinned rank were fetched for `currentPeriod()` regardless of
   which day the modal was on. The modal scrubs back seven days, so in the first
   week of any month it captioned *this* month over last month's puzzle and
   ranked the viewer in a month that didn't contain the day on screen. The period
   is now derived from the puzzle index (`periodForPuzzle`), which is a UTC day
   offset from the epoch and therefore already the right calendar unit. The empty
   copy names the month for the same reason.
2. **The modal opened on Season.** `defaultTab: 'season'` was passed from both
   call sites, so tapping 🏆 for "Puzzle #N results" landed on a month board.
   Which board leads is now the caller's (`lead`) — Season on the end-game
   screen, Friends in the modal, still a preference the panel can override when
   the named tab settles empty.
3. **Words never destroyed a panel.** It was the only adopting game with no
   `PanelSlot`, so every prev/next in the modal left the previous board's season
   and rank fetches resolving into detached nodes. It now holds one slot per
   mount point — end-game and modal, which are on screen together — mirroring
   rabbit-globe.

Also fixed alongside: `npm test` had been dead since it was added. Node 20 walked
a directory passed to `--test`; Node 22 resolves it as a module instead, so
`node --test .test-build` failed with MODULE_NOT_FOUND before any assertion ran
— and reported it as one failing test, which reads like a broken suite rather
than a broken runner. `test.config.mjs` now names the built files. 21/21 pass.

**Phase 4 — deploy discipline**
Ship order is forced: **backend → SDK + sandbox host → games → RN app.** Two
artifacts joined the list in Phase 2: `dist/leaderboard-v1.js` and
`dist/leaderboard-v1.css`. 2048 and solitaire load them as script/link tags (no
bundler), so those two games hide their boards entirely if the pair doesn't ship
with them. They travel with the games, not with the SDK. The RN
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

## 5. Open questions — all closed 2026‑07‑27

1. ~~Backend repo path~~ — reviewed; see header.
2. ~~Should guests read global boards?~~ **Decided: yes** — and already how
   `/scores/top` is registered, so no work (§3.5).
3. ~~Which games get a global board?~~ **Decided: four — 2048, rabbit-globe,
   solitaire, rabbit-words.**
   - 2048 (all-time, exists) and rabbit-globe (0–15,000, effectively no ties)
     are the clear cases.
   - solitaire is in: its 0–3,600 speed score is the same continuous shape as
     globe's, and a *daily* global board needs no backend work at all —
     `scores.top` on `daily-<id>` works today. The `DailyGameRegistry` gap
     blocks only its season board.
   - rabbit-words is in but **season-only** — a daily global board there is
     hundreds of ties on a 1–6 range broken by timestamp (§3.7). Friends tab in
     Phase 2, Global tab in Phase 3. **Reversed 2026‑08‑03 — see §5.4.**
   - **snake and match3 are out entirely**, not deferred. They submit nothing
     today, so a board launches empty and the submit path is real work rather
     than "cheapest on the board". Note this also rules out adding *silent*
     submission ahead of a board: `scores.top` is a public read and the opt-out
     ships after Phase 2 (§3.5), so that would publish usernames and scores for
     a game with no board and no user-facing benefit.
   Season metric (§3.7) — signed off for the three daily games: rabbit-words →
   `qualified_avg` (cap derived from the month's actual puzzle days),
   rabbit-globe → `sum`, solitaire → `sum`. Both `sum` games have wide
   continuous ranges, which is precisely the property words lacks.
   ~~2048 → `max`~~ — **withdrawn**: seasons aggregate a month of *daily* rows
   and 2048 has none, only the constants `highscore` and `keepBest`-updated
   `win`. Its monthly board needs a per-month round key submitted game-side, not
   a season aggregation (§3.7).
4. ~~`highscore` → `alltime`?~~ **Decided: neither — cancelled.** The alias was
   only ever for snake/match3's new all-time boards; with those out (§5.3)
   nothing would ever write under `alltime`, so 2048 keeps `highscore` and the
   backend gains no synonym. Revisit only if a new all-time board appears.

## 5.4 Reversal — rabbit-words gets a daily public board (2026‑08‑03)

§3.7 and §5.3 ruled out a `scores.top` tab for rabbit-words: seven possible
daily values across hundreds of players is a clock, not a ranking. That argument
is about **scale**, and the scale isn't there. Production, read the morning of
2026‑08‑03:

| Puzzle | Players that day | Scores |
| --- | --- | --- |
| #86 (Aug 1) | 4 | all four tied on "solved in 5" |
| #87 (Aug 2) | 7 | spread across five distinct results |
| #88 (Aug 3) | 3 by 08:00 UTC | — |

At that volume the board is not a top-20 cut of a tied field; it **is** the
field. The observed cost of holding the line was concrete: a player who follows
nobody got an invite prompt while the day's four other players sat one tab away,
unreachable — on a platform whose whole pitch is community. Belonging was the
goal; the ranking was only ever the mechanism.

So words now renders **Everyone → Season → Friends**, with Everyone leading on
both the end-game screen and the past-round modal. No backend work: the route is
public and already answers for this app, and both outer hosts already relay
`scores.top` and `scores.rank`.

Two things this does not change:

- **The clock is still real.** Equal scores are tie-broken by `created_at ASC`,
  so an early solver outranks a later one with the same guess count. At a
  handful of players a day nobody can see it. **Revisit trigger: when a single
  day's field stops fitting on one screen (~50+), the daily board should stop
  claiming to rank and the season board carries the standing** — that is what
  `qualified_avg` was designed for and why it stays the second tab, not the
  first.
- **The season board keeps its job.** Daily = who else is here today; season =
  where you stand. Two boards, two questions.

Fixed alongside, in the shared UI and therefore in all four games: **a medal now
needs a place nobody else reached.** Competition ranking shares a rank on equal
scores — correct for the number, wrong for the medal, as the four-way tie on
puzzle #86 rendered four gold medals down a column and read as a bug. `medalsFor`
awards 🥇🥈🥉 only where the place is uniquely held; a shared place shows its
number. Boards with `rankTies: false` are unaffected, since every rank there is
unique by construction.

## 5.5 Board depth — 20 → 100 (2026‑08‑09)

Every board shipped fetching 20 rows. That was a placeholder carried from the
first 2048 modal, never a decision, and by August it was hiding real players:

| Board | Field | Visible at 20 |
| --- | --- | --- |
| 2048 High Scores (all-time) | 51 | 20 — 61% of the field cut |
| rabbit-words Season (Aug) | 32 | 20 — 12 cut |
| rabbit-globe Season (Aug) | 10 | all |
| 2048 Hall of Fame | 1 | all |

All four games now request `100`, the ceiling the REST route and
`BridgeRequestSchema` already enforce, via a named `BOARD_LIMIT` rather than a
literal at each call site. No backend change — `limit` was always clamped to
1..100, and the season transient simply keys on the new value.

The pinned row (§3.5) is what made 20 defensible: a player outside the page
still saw where they placed. It stays, and it is still the only thing that works
at any field size — but "see your rank" and "see the field" are different needs,
and the second one is the community half of the feature.

**A height cap was tried and reverted the same day.** The worry was real — 100
unbounded rows push lifetime stats and share buttons a couple of thousand pixels
down an inline board — so `.lb-panel .lb-list` got `max-height: 60vh`, its own
scroll and `overscroll-behavior: contain`, exempting `.lb-modal` on the grounds
that the shared modal already scrolls.

That exemption was the bug. **The shared modal is not the only scroll container a
panel is mounted in.** rabbit-words' past-round modal is the game's own element
(`.leaderboard-modal-body`, `overflow-y: auto`), and inside it the capped list
became a second scroller: the last rows of a 31-row season board could not be
reached on either tab, because a flick that landed on the inner list stopped
there instead of scrolling the modal holding the rest of it.

**Rule, learned the hard way: a panel does not know what it has been mounted
inside, so it must not claim the scroll.** Every surface that renders one already
scrolls, and the outermost scroller is the only one usable on touch. A board that
needs to take less room should collapse behind a "Show all" control, which adds
no second scroll region.

The one deliberate exception is solitaire, and it proves the rule: its panel
lives in `.game-message`, an absolutely positioned overlay with a fixed height
and no scroll of its own, so the list scrolling is what makes the board reachable
at all — and there is no parent scroller to chain to. Its cap moved 160px → 38vh,
since 160px was set for 20-row boards and shows three and a half.

Two pre-existing overflow bugs surfaced while auditing the other games for the
same shape:

- **rabbit-globe's modal never scrolled.** `.modal-backdrop` is `position: fixed`,
  so the page behind it can't scroll either, and `.modal` had no `max-height` —
  a board taller than the viewport ran off the bottom of the screen unreachable.
  Latent since the leaderboard modal shipped (20 rows already overflowed a short
  screen), fatal at 100. Now `max-height: calc(100vh - 40px); overflow-y: auto`.
- **2048 was fine** and always has been: its board is in the shared `.lb-modal`,
  which is a single 85vh scroll area with nothing nested inside it.
