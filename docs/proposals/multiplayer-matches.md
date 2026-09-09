# Multiplayer matches (async, turn-based, 2–4 players)

Status: **accepted, Phase 1 + most of Phase 2 implemented 2026‑09‑06** (not
yet deployed; RN host verbs still to do). Covers `apps-sdk` (SDK, sandbox
host, games), `oddsrabbit-app` (RN host), and the OddsRabbit WordPress backend
(`rest-routes/`, `cron/`), reviewed against the local checkout at
`app/public/` on 2026‑09‑06.

**What landed, and where** (2026‑09‑06):

- apps-sdk: `matches.*` in `src/schemas/messages.ts` (seven verbs — the six
  below plus `matches.invitable`, added when the client turned out to have no
  way to list who it may invite), `OR.matches.{create,join,list,get,move,
  resign,invitable,watch}` in `src/sdk/sdk.ts` with tests in
  `src/sdk/matches.test.ts` and `src/schemas/matches.test.ts`; README; the
  `rabbit-word-battle/` client (rules mirror, canvas board with pan/pinch,
  list/new/match
  screens) registered in `build.config.mjs`.
- WordPress: `migrations/20260906_001_create_app_matches.sql` and
  `…_002_create_tiles_words.sql`; `rest-routes/services/matches/`
  (`MatchRules`, `MatchService`, `MatchNotificationService`,
  `ConnectFourRules`, `TilesRules`, `TilesDictionaryService`);
  `AppMatchesController` + seven routes in `apps-routes.php`;
  `cron/process-match-deadlines.php`; `tools/load-tiles-dictionary.php`
  (ENABLE list in `data/dictionaries/enable1.txt`); `tools/test-match-rules.php`
  (70 pure-PHP assertions). `games.js` gained the seven verb cases, the
  capabilities, and `target=match|join` deep links.
- Verified end to end against the local DB: migrations, a 168,551-word
  dictionary load, and a scripted word match + connect4 match through create,
  per-viewer reads, moves, version conflicts, resign, join codes, and the
  deadline cron.

**Decisions taken while implementing** that refine the text below:

- **Invitees are seated immediately** as `joined`; there is no accept step.
  A match with a full invite list is `active` from the create call, and the
  invitees learn about it from the push. `invited` stays in the enum for a
  future accept flow.
- **Connect Four is a server-side test fixture, not a shipped game.** Its
  rules class exists because it is the cheapest way to exercise MatchService;
  no `connect4/` client is planned. The word game is the product.
- **The word game's scores are owned by its rules class.** `applyMove` may
  return every seat's running total (the endgame adjusts all of them) and the
  service mirrors those into the players table; games where only the mover
  scores return a delta.
- **RN host done the same day**: the seven verbs in `AppHost.tsx` and
  `app.service.ts`, `HOST_CAPABILITIES`, the bridge types, and
  `target: 'match'` routing from both the push handler (`AppNavigator.tsx`)
  and the in-app notification list. The host's catch block now forwards the
  server's own error code and message when the REST body carries one, so
  `match/version-conflict` and `match/illegal-move` reach the SDK on mobile
  exactly as on web instead of collapsing to `bridge/error`. Ships with the
  next App Store release; until then the game hides itself on mobile via the
  capability gate.
- **Not done:** the forfeit-warning push, rate limits on the routes,
  registering `rabbit-word-battle` as an app in the registry, and a real-device pass of
  the client.

Companion to [`unified-leaderboard.md`](./unified-leaderboard.md), which this
document assumes: capability handshake (§3.1 there), the three "unsupported"
error codes, the rule that a new *field* on an existing verb is undetectable so
new behaviour ships as a new *verb*, and the per-row parsing pattern in
`src/sdk/sdk.ts`.

## 0. Goal and shape

Let a signed-in player start a game against one to three specific people (or an
open table), take turns over hours or days, and be told when it is their move.
Two games target the surface:

| Game | Players | Hidden information | Rules engine | Purpose |
| --- | --- | --- | --- | --- |
| **Connect Four** | 2 | none | ~30 lines | week-one proof of the whole pipeline |
| **Rabbit Word Battle** (Scrabble-like) | 2–4 | racks + bag | ~400 lines + dictionary | the actual product |

The surface is designed for the word game and Connect Four merely runs on it.
The one decision that cannot be retrofitted is **per-viewer state** (§2.1): a
match read has to be able to return a different view to each participant. If the
first cut returns one public match record to everyone, the word game forces a
rework of every verb, both hosts, and the SDK.

Explicitly **not** in scope: realtime (sockets), spectating, ranked matchmaking,
chat. Each is listed in §7 with what it would need.

## 1. What exists today, and what is missing

### 1.1 Reusable as-is

- **Identity and auth.** `modern_auth` on every user-scoped route in
  `rest-routes/routes/apps-routes.php`; apps resolve to `app_uuid` via
  `AppRegistryService`. Matches are scoped per app exactly like scores and
  storage.
- **Follow graph.** `get_following_ids()` (`rest-routes/helpers/follow-helpers.php:354`)
  is the invite list. It is what `scores.friends` already filters on.
- **Push + deep link, end to end.** `AppGameNotificationService::buildPayload`
  emits `data.{type, appSlug, roundKey, target}` for mobile and a web `link` of
  the form `/games/{slug}/?target=…&round=…`. `inc/js/pages/games.js:225-236`
  translates that query string into `init.initialState`, and rabbit-words'
  `parseLeaderboardIntent` consumes it. A "your move" notification is the same
  pipeline with a new `target` (§4).
- **Bridge plumbing.** `BridgeRequestSchema` (discriminated union),
  `BRIDGE_REQUEST_TYPES`, `capabilities.has()`, `UNSUPPORTED_CODES`, and the
  sandbox host's `bridge/unsupported-request` answer. Adding verbs is mechanical.
- **Shared UI.** `src/ui/leaderboard.ts` rows (avatar hash, `textContent`-only
  rendering) are reusable for the player strip and the match list.

### 1.2 Missing, and why nothing existing substitutes

- **Shared mutable state between users.** `OR.storage` is per-user and
  16 KB per value. There is no verb that reads *another* user's anything. The
  only cross-user reads are the aggregate score boards, which are append-only
  integers. A match needs a record two to four people write to in turn, with
  the server refereeing who may write.
- **Hidden per-participant data.** Nothing in the platform models "this row has
  a field only user X may see". Score metadata is public on `scores.top`.
- **Turn notifications to a specific user.** `AppGameNotificationService`
  fans out to *every* eligible player of a daily game at end of day. A match
  needs a single-recipient send at move time. The sender itself
  (`bulkInsertInAppNotifications` + the push helper it wraps) is reusable; only
  the trigger and recipient selection are new.
- **Reading a client-supplied URL param as a match id.** `games.js` accepts
  `target` of `leaderboard|play` only (line 235). One more value and one more
  param.

## 2. Design

### 2.1 Data model

One table, one JSON state column, one integer version. Rules live in one PHP
class per game (§2.4); the table and verbs are game-agnostic.

```sql
CREATE TABLE oddsrabbit_app_matches (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  match_uuid    CHAR(36)     NOT NULL,          -- what clients see; never `id`
  app_uuid      CHAR(36)     NOT NULL,
  game          VARCHAR(32)  NOT NULL,          -- 'connect4' | 'tiles'; selects the rules class
  status        ENUM('lobby','active','finished','abandoned') NOT NULL,
  join_code     CHAR(6)      NULL,              -- lobby only; NULL once active
  max_players   TINYINT      NOT NULL,          -- 2..4
  turn_seat     TINYINT      NULL,              -- whose move; NULL unless active
  turn_deadline TIMESTAMP    NULL,              -- forfeit/skip after this
  version       INT UNSIGNED NOT NULL DEFAULT 0,-- bumps on every state write
  state         JSON         NOT NULL,          -- game-specific, server-owned (bag, racks, board)
  winner_seat   TINYINT      NULL,
  created_by    BIGINT UNSIGNED NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_match_uuid (match_uuid),
  UNIQUE KEY uq_join_code  (app_uuid, join_code),
  KEY idx_app_status (app_uuid, status, updated_at)
);

CREATE TABLE oddsrabbit_app_match_players (
  match_id   BIGINT UNSIGNED NOT NULL,
  seat       TINYINT         NOT NULL,          -- 0..3, turn order
  user_id    BIGINT UNSIGNED NOT NULL,
  status     ENUM('invited','joined','resigned','forfeited') NOT NULL,
  score      INT NOT NULL DEFAULT 0,
  joined_at  TIMESTAMP NULL,
  PRIMARY KEY (match_id, seat),
  UNIQUE KEY uq_match_user (match_id, user_id),
  KEY idx_user_matches (user_id, match_id)      -- "my matches" list
);

CREATE TABLE oddsrabbit_app_match_moves (
  match_id   BIGINT UNSIGNED NOT NULL,
  ply        INT UNSIGNED    NOT NULL,          -- 0-based move number
  seat       TINYINT         NOT NULL,
  move       JSON            NOT NULL,          -- game-specific, as validated
  score_delta INT            NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (match_id, ply)
);
```

Why three tables and not a JSON blob: the players table is what makes "list my
matches" an index hit rather than a JSON scan, and the moves table is the audit
log that makes a disputed word or a crash recoverable. `state` is the *current*
position for fast reads; it must always be reproducible by replaying `moves`.

**Identity**: `match_uuid` at the API boundary, `id` internally, same as
`user_uuid`/`user_id` for scores. Players are returned by `uuid`/`username`/
`avatar` in the `FriendScoreSchema` shape so the shared UI renders them.

**Sizes**: a Connect Four match is under 1 KB of state. A four-player word game
with a 15×15 board, four racks, a 100-tile bag, and scores is ~3 KB. Neither is
near any limit; the `state` column is JSON, not TEXT, so MySQL validates it.

### 2.2 Per-viewer views — the non-negotiable

`matches.get` is **authenticated and viewer-specific**. The controller calls
`Rules::viewFor(state, seat)` before serialising, which for the word game
strips every rack but the viewer's and replaces the bag with its count. For
Connect Four `viewFor` is the identity function. The verb still goes through it,
so the contract is the same for both.

Consequences that follow and must not be undone later:

- **No public match reads, no server-side cache keyed on match alone.** If a
  cache is ever added it keys on `(match_uuid, version, viewer_seat)`.
- **The SDK exposes no "raw state" escape hatch.** Games read `view`, not
  `state`; the word `state` does not appear on the wire.
- **Moves are validated against server state, never client state.** The client
  sends only the *move* (columns dropped, tiles placed); the server applies it
  to its own copy and returns the new view. A client that sends a board is a
  client that can send a winning board.

This is also what makes cheating structurally impossible rather than merely
detected: a player never holds information they are not entitled to, so there is
nothing to leak by inspecting the WebView.

### 2.3 Bridge verbs

Six verbs, all authenticated (a guest cannot be in a match), all new — no new
fields on existing verbs (see the §3.1 caveat in the leaderboard proposal on
why fields are undetectable).

```
matches.create   { game, maxPlayers, invitees?: uuid[], open?: boolean }
                 → MatchView                       (status 'lobby', or 'active' when
                                                    invitees fill the table and the
                                                    game has no accept step)
matches.join     { matchUuid } | { joinCode }       → MatchView
matches.list     { status?: 'active'|'finished'|'all', limit? }
                 → MatchSummary[]                  (viewer's matches, newest activity first)
matches.get      { matchUuid }                      → MatchView   (per-viewer, §2.2)
matches.move     { matchUuid, version, move }       → MatchView
                                                    (409 `match/version-conflict` if
                                                     `version` is stale; 403
                                                     `match/not-your-turn`;
                                                     422 `match/illegal-move`
                                                     with a `reason` string)
matches.resign   { matchUuid }                      → MatchView
```

`MatchView`:

```ts
{
  matchUuid: string,
  game: string,
  status: 'lobby' | 'active' | 'finished' | 'abandoned',
  version: number,
  maxPlayers: number,
  joinCode: string | null,          // only while 'lobby', only to participants
  players: Array<{                  // FriendScoreSchema shape + seat/status
    seat: number, uuid: string, username: string, avatar: string | null,
    status: 'invited' | 'joined' | 'resigned' | 'forfeited',
    score: number, isSelf: boolean
  }>,
  turnSeat: number | null,
  turnDeadline: string | null,      // ISO
  winnerSeat: number | null,
  mySeat: number,
  view: Record<string, unknown>,    // game-specific, ALREADY filtered for this viewer
  lastMove: { ply: number, seat: number, move: unknown, scoreDelta: number } | null
}
```

`MatchSummary` is `MatchView` minus `view`, `lastMove`, and `joinCode`, plus
`updatedAt` and `isMyTurn` — the list screen needs a badge, not a board.

Design notes:

- **Optimistic concurrency via `version`.** Two tabs, or a stale WebView
  resumed after `lifecycle.resume`, both submit; the second gets
  `match/version-conflict` and the SDK resolves it by fetching the fresh view.
  Cheaper than row locks and it doubles as the "has anything changed" poll
  test.
- **`move` is opaque to the bridge.** Like `scores.metadata` and
  `content.daily`, Zod models it as `z.unknown()` capped at 2 KB and the game's
  rules class validates it. The bridge stays game-agnostic.
- **Errors are typed, not stringly.** Three new codes above join the existing
  `bridge/*` family. The SDK must **not** classify any `match/*` code as
  "unsupported" — a rejected move is a per-call outcome, not a missing verb.
  This is the same trap §2.2 of the leaderboard proposal warns about for
  `bridge/invalid-request`.
- **No `matches.invite` verb.** Invitees are set at create time. Adding people
  to a live lobby is a lobby-owner feature that can come later as its own
  verb; it is not needed for either target game.
- **Polling, not push, while the app is open.** The SDK offers
  `OR.matches.watch(matchUuid, cb)` as sugar over `matches.get` every 5 s
  while `document.visibilityState === 'visible'` and the match is `active`,
  suspended on `lifecycle.pause`. Turn-based games do not need anything
  better, and it needs no host work. Section 7 covers what realtime would cost.

### 2.4 Rules classes (server, PHP)

```
rest-routes/services/matches/
  MatchRules.php            interface: initialState(seats), validateMove(state, seat, move)
                                       → [newState, scoreDelta, reason?],
                                       viewFor(state, seat), isFinished(state) → winnerSeat|null|'draw'
  ConnectFourRules.php      7×6, move = { col }, gravity, four-in-line, draw on full board
  TilesRules.php            §3
  MatchService.php          create/join/list/get/move/resign; owns the transaction,
                            version bump, deadline, and the notification trigger
```

`MatchService::move` is one transaction: `SELECT … FOR UPDATE` on the match
row, check `version`, check `turn_seat === viewer seat`, call
`validateMove`, insert the move row, write new `state`, bump `version`, advance
`turn_seat` (skipping resigned/forfeited seats), set `turn_deadline`, detect
finish, commit, then notify the next player *after* commit.

**The same rules run on the client for instant feedback** (a JS mirror in the
game bundle), but the server verdict is the only one that changes the match.
Divergence between the two copies shows up as a `match/illegal-move` the client
did not predict — log it, it is a bug in one of them.

### 2.5 Lifecycle, deadlines, and abandonment

Four-player games die when one person stops. The rules below are what keep a
table alive without anybody having to be the bad guy.

- **Lobby expiry.** A `lobby` match with unfilled seats is `abandoned` after
  **48 h**. Invited players who never joined are simply not in it.
- **Turn deadline: 72 h**, stamped on every turn advance. On expiry, the
  next `matches.get`/`matches.list` from *any* participant (or the hourly
  cron below) applies the rule: in a **2-player** game the absent player
  **forfeits** and the other wins; in a **3–4 player** game the absent player
  is **skipped** (a pass is recorded as a move), and a player skipped **twice
  running** is forfeited and their seat removed from rotation. Their tiles
  return to the bag in the word game.
- **Resign** is explicit and immediate. In a 2-player game it ends the match;
  otherwise the game continues without them.
- **Finished matches are kept**, and `matches.list` shows them for 30 days.
  Nothing is deleted while a participant can still open it.
- **Cron**: `cron/process-match-deadlines.php`, hourly, applies expired
  deadlines and lobby expiry for matches nobody has opened. It exists so a
  forfeit fires even when everyone has stopped looking — otherwise the winner
  is never told they won.

Lazy application on read *plus* a cron is deliberate: reads make the common
case instant, the cron makes the abandoned case eventually correct.

### 2.6 Invites and lobbies

- **From the follow graph**: the create screen lists `get_following_ids()`
  with avatars (reusing the leaderboard row renderer). Picking people sets
  `invitees`; they see the match under `matches.list` as `invited` and get a
  push (§4). Nobody can be added to a match by a stranger: `invitees` must be
  a subset of people the creator follows **or** who follow the creator, and
  the server enforces it.
- **Join code**: `open: true` mints a 6-character code (unambiguous alphabet,
  no `0/O/1/I`). Anyone signed in can `matches.join` with it until the table
  fills. This is how three friends fill a four-seat table when the fourth is
  someone's cousin who does not follow anyone yet. The code is also what
  `actions.share` puts in the share text. Codes are single-app
  (`uq_join_code` is per `app_uuid`) and are cleared when the match starts.
- **Share → open** needs one small host change: `games.js` accepts
  `?target=match&match=<uuid>` (and `?join=<code>`) and forwards
  `{ target: 'match', matchUuid }` / `{ target: 'join', joinCode }` as
  `initialState`. The mobile `AppHost.tsx` needs the same two shapes. Until
  that lands, codes are typed by hand, which works everywhere today.

### 2.7 Scores and boards — what this does *not* touch

Match results do **not** write to `oddsrabbit_app_scores`. The score table's
identity is `(app, round, user)` with one integer, and a match has no round.
Wins/losses/rating are a later concern; if they come, they come as a new
aggregate (`matches.record { wins, losses, streak }`) rather than by
overloading `roundKey`. The one exception worth considering early is a
per-month **season** on the word game by *total points scored in finished
matches*, which the existing `scores.season` machinery cannot serve (it expands
`period` through `DailyGameRegistry`, and a match is not a daily row). Park it.

## 3. The word game specifically

### 3.1 Naming and IP

Do not ship under **Words With Friends** or **Scrabble**; both are trademarks.
Mechanics (tile bag, racks, crosswords, premium squares) are not protectable
and every clone uses them. The **exact premium-square layout** of either game
is best avoided: generate our own symmetric layout and keep it in
`TilesRules.php` as data. Named **Rabbit Word Battle**; the rules class and the
wire id keep the `tiles` name, which is what `game` holds on every match row.

### 3.2 Dictionary

- **ENABLE** (Enhanced North American Benchmark Lexicon) — ~173 k words,
  public domain, the list most open clones use. **Not** Collins/SOWPODS and
  **not** the official tournament lists; both are copyrighted.
- Server: one table `oddsrabbit_tiles_words (word VARCHAR(15) PRIMARY KEY)`,
  loaded once by a migration from a file checked into the WP repo. Validation
  of a move is one `SELECT word FROM … WHERE word IN (…)` over every word the
  placement formed; compare the count.
- Client: the rabbit-words list (`rabbit-words/src/words.ts`) is 5-letter only
  and useless here. Ship **no** dictionary in the client for the first cut; an
  invalid word is rejected by the server with `reason: 'not-a-word: QZX'` and
  the tiles bounce back. A client-side check for instant red-underlining can
  come later as a Bloom filter (~200 KB) if the round trip feels slow. It is a
  polish item, not a correctness one.

### 3.3 Rules (`TilesRules.php`, mirrored in `rabbit-word-battle/js/rules.js`)

- 15×15 board; 100 tiles with standard English letter distribution and values
  (public domain facts); 7-tile racks; 2 blanks.
- `initialState(seats)`: shuffle bag with a server-side CSPRNG (not a
  reproducible seed — there is nothing to reproduce and a predictable bag is
  an exploit), deal 7 to each seat, empty board, `turnSeat` = random.
- Move types: `{ type: 'place', tiles: [{ row, col, letter, blankAs? }] }`,
  `{ type: 'exchange', letters }`, `{ type: 'pass' }`.
- Placement validity: all tiles in one row or column, contiguous once existing
  tiles are counted, at least one tile adjacent to an existing tile (or covers
  the centre on ply 0), every tile drawn from the mover's rack, every formed
  word (main + crosses) in the dictionary.
- Scoring: letter values × letter multipliers, then word multipliers, summed
  over every word formed; premium squares count only when newly covered; +50
  for using all 7 tiles.
- Endgame: bag empty **and** a player empties their rack → finished; each other
  player's remaining tile values are subtracted from them and added to the
  finisher. Or **two full rounds of passes** → finished (prevents stalling);
  or everyone but one has resigned/forfeited.
- `viewFor(state, seat)`: `board`, `scores`, `bagCount`, `myRack`,
  `rackCounts[]` (how many tiles each opponent holds — public in the physical
  game), `lastMove` with the words formed and their scores. Never other racks,
  never the bag.

### 3.4 Client (`rabbit-word-battle/`)

Same vanilla drop-in pattern as `flappy-rabbits/` (files copied by
`build.config.mjs`; `index.html` carries `__BUILD_ID__`). The board is a
`<canvas>` at a fixed internal resolution with **pan + pinch** because 15×15
does not fit a phone at a tappable size, and the rack is DOM so tiles can be
dragged with the pointer API. Both the README's Android rules apply
(`touch-action: none`, `{ passive: false }`, `overscroll-behavior: none`).

Budget honestly: the board interaction is as much work as the entire backend.

## 4. Notifications

Add a `MatchNotificationService` alongside `AppGameNotificationService`,
reusing its payload conventions and `bulkInsertInAppNotifications`:

| Event | Recipient | `target` | Body |
| --- | --- | --- | --- |
| Invited to a match | each invitee | `match` | "{creator} challenged you to Rabbit Word Battle" |
| Your turn | next seat, after commit | `match` | "Your move against {opponents}" |
| Match finished | every participant except the mover | `match` | "You won 312–288" / "{winner} won" |
| Forfeit warning | seat on turn, 12 h before deadline | `match` | "Move in Rabbit Word Battle or forfeit in 12h" |

Payload adds `data.matchUuid`; web `link` is `/games/{slug}/?target=match&match=<uuid>`.
`collapse_id` is `match:{matchUuid}` so a rapid four-player round replaces
rather than stacks. The forfeit warning is sent by the hourly cron (§2.5), the
rest by `MatchService` after commit.

Older mobile builds that do not know `target: 'match'` land on the game's play
screen, which shows the match list, so the fallback is a usable screen, not a
dead end. This mirrors the reasoning in `buildPayload`'s comment.

## 5. Bridge, SDK, and host changes (this repo + hosts)

1. `src/schemas/messages.ts`: six request variants, `MatchViewSchema`,
   `MatchSummarySchema`, `MatchPlayerSchema` (extends `FriendScoreSchema`
   with `seat`/`status`). `view` and `move` are `z.record(z.unknown())` with
   the 2 KB refine used for `metadata`.
2. `src/sdk/sdk.ts`: `OR.matches.{create,join,list,get,move,resign,watch}`.
   Per-row parsing on `list` (one malformed match must not blank the list —
   same lesson as §2.3 of the leaderboard proposal). `match/*` codes are
   **excluded** from `UNSUPPORTED_CODES`. Do **not** add the verbs to
   `LEGACY_CAPABILITIES` — that list is a historical snapshot (§3.1 there),
   and a pre-handshake host will not have these.
3. `src/host/host.ts`: nothing but the schema import; it is a relay.
4. `games.js`: six cases in the verb switch → six REST calls; `HOST_CAPABILITIES`
   gains the six names; `initialState` accepts `target=match|join`.
5. `AppHost.tsx` + `app.service.ts`: same six, same capability names, same two
   `initialState` shapes. **Ships behind App Store review**, so games must gate
   the entire multiplayer entry point on `capabilities.has('matches.get')` and
   render nothing (not a broken button) without it.
6. README: document the verbs and the per-viewer contract in one paragraph.

REST (WP), all `modern_auth`:

```
POST   /apps/{slug}/matches                         create
POST   /apps/{slug}/matches/join                    { matchUuid } | { joinCode }
GET    /apps/{slug}/matches?status=&limit=          list (viewer's)
GET    /apps/{slug}/matches/{matchUuid}             get (per-viewer)
POST   /apps/{slug}/matches/{matchUuid}/moves       { version, move }
POST   /apps/{slug}/matches/{matchUuid}/resign
```

Rate limits: `moves` at 60/min/user (a move is a human action; anything faster
is a script), `create` at 10/h/user (lobby spam), `get` at 120/min/user (the
5 s poll across a few open tabs).

## 6. Plan

**Phase 0 — contract** (this document). Settle §2.2 and §2.5; everything else
can move.

**Phase 1 — pipeline proof with Connect Four** (~1 week)
1. Migration: the three tables (§2.1).
2. `MatchRules`, `ConnectFourRules`, `MatchService`, six routes, deadline cron.
3. Schema + SDK verbs + `watch`; sandbox host schema bump.
4. `games.js` verbs, capabilities, `initialState` shapes.
5. `connect4/` game: match list, invite from follow graph, join code, board,
   polling, resign. Reuses `src/ui` rows. Gated on `capabilities.has`.
6. `MatchNotificationService` with "invited" and "your turn" only.
7. RN host verbs (ship when the store allows; web works before then).

Exit criterion: two accounts on web finish a game with the app closed between
turns, both receive the pushes, and a stale `version` is rejected.

**Phase 2 — word game** (~4–6 weeks, board UI dominates)
1. ENABLE import migration + `oddsrabbit_tiles_words`.
2. `TilesRules.php` with a unit test per rule (placement, scoring, endgame,
   blank handling). This is the one component where tests pay for themselves
   immediately: scoring bugs are invisible in play and permanent in the log.
3. `rabbit-word-battle/` client: rules mirror, board canvas with pan/pinch, DOM rack with
   drag, exchange/pass UI, per-viewer state handling.
4. 3–4 player lobby, skip/forfeit rules, forfeit-warning cron, "finished"
   notification.
5. Real name, icon, manifest, Android device pass.

**Phase 3 — after data** (unscheduled)
- Client-side dictionary filter if rejected-word round trips feel slow.
- Per-month points season (§2.7) once there are enough finished matches to
  rank.
- Wins/losses on the profile, rematch button, "add to lobby" verb.

## 7. Deliberately out of scope, with what each would cost

- **Realtime (snake arena, Flappy Rabbits race).** Needs a socket server the
  WP stack cannot provide; the README already sanctions a developer backend
  verified against `/.well-known/jwks.json`, so the *auth* is solved, but
  hosting, matchmaking, reconnect, and the WebView's background suspension on
  mobile are not. Reconsider only once turn-based play shows demand.
- **Spectating / public matches.** Would require a second, viewer-less
  `viewFor` and a public read, which is exactly the shape §2.2 forbids for the
  first cut. Possible later as `matches.spectate` returning the *finished*
  match only.
- **Rated matchmaking.** Needs a rating table and a queue; the follow graph and
  join codes cover the social case, which is the case oddsrabbit is for.
- **In-match chat.** The platform has chat (`chat-routes.php`); linking a match
  to a group thread is a product question about where conversations live, not
  a matches question.

## 8. Open questions

1. **Turn deadline: 72 h or 48 h?** 72 h is forgiving for a four-player table
   across time zones; 48 h keeps two-player games brisk. Could be per game
   (Connect Four 24 h, Rabbit Word Battle 72 h) — the column supports it, the rules class
   would set it.
2. **Does a declined/ignored invite count against the inviter?** Today: no,
   the lobby just expires. If lobby spam appears, revisit.
3. **Blank tile designation.** Once placed as a letter the blank is fixed for
   the rest of the game (standard). Confirm we do not want the "steal the
   blank" variant.
4. **Name for the word game**, and whether Connect Four ships publicly or stays
   an internal proof. Its entire cost is in the shared surface, so publishing
   it is nearly free and gives the matches system a second game on day one.
