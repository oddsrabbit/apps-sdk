# Rabbit Pets (cozy real-time virtual pet)

Status: **proposed 2026‑09‑24**, not started. Covers a new `rabbit-pets/`
game in this repo, plus two platform additions it depends on, which are
specified separately in
[`scheduled-notifications.md`](./scheduled-notifications.md): the
`notifications.*` verbs and a trustworthy server clock (`time.now`).

Feature selection was done on a toggleable checklist
(<https://claude.ai/artifact/AP4iaMcY6qMiEBTpVNLrbR>). The IDs in brackets
below (`[A1]`, `[H4]`, …) refer to it; §7 maps every picked item to a phase.

**Decisions already taken** (2026‑09‑24):

- **Real time, not session-based.** The rabbit lives on the real clock while
  the game is closed. Retention comes from coming back often, not from long
  sessions.
- **Cozy. She cannot die**, get sick or run away. Neglect produces moods only.
- **No leaderboard.** This is not a score game; nothing here calls
  `OR.scores.*`.
- **Signed-in only.** No guest mode. The pet lives in `OR.storage` against the
  account.
- **Slow needs.** About 24h from full to "grumpy", so one visit a day is
  enough. Timers and the daily gift give reasons for extra visits.
- **Both loops.** Timers bring players back; decorating is what they work
  toward and spend on.
- **Name: Rabbit Pets.** The burrow is still the name of her room in the game.
- **One rabbit per account**, forever.
- **Server-scheduled reminders** (`notifications.schedule`), not on-device
  ones. On-device scheduling [H2] is dropped (§8).

## 0. Goal and shape

A 30-second visit, several times a day. Open the game and see what happened
while you were away. Do one or two small things (feed, pet, collect a
finished nap, place a new rug). Leave with something to come back for (a
timer, tomorrow's gift) and, if the player opted in, a reminder already
scheduled for it.

The thing that cannot be retrofitted is **the time model** (§2). Where "now"
comes from, how elapsed time is replayed, and how two devices agree on the
result shape every feature above it. Everything else can change after launch.

## 1. What exists today, and what is missing

### 1.1 Reusable as-is

- **`OR.storage`** for the pet. It syncs across mobile and web and is
  server-backed for signed-in users. Values are capped at **16 KB per key**
  (`STORAGE_VALUE_MAX_BYTES`), so state is split across keys (§3).
- **`OR.content.daily`** for the daily visitor [C6]. It is server-authored and
  date-gated, so tomorrow's visitor isn't readable in the bundle.
- **`OR.actions.share`** for the pet card [F3]. It is **text only** (`title`,
  `text`); there is no image share (§8).
- **`OR.actions.requestSignIn`** for the sign-in screen on web. The mobile
  host doesn't implement it (see README).
- **Push, bell and opt-in plumbing on the backend.** Expo push through
  `PushNotificationService`, bell rows through
  `AppGameNotificationService::bulkInsertInAppNotifications`, and the
  `games_notifications_push` setting. Only the game-facing verb is missing.
- **Pixel-art pipeline**: the `SCALE`-blit approach from `solitaire/` and
  `flappy-rabbits/`.
- **Test runner**: `npm test` compiles `*.test.ts` with esbuild. This is why
  the simulation is written in TypeScript (§6).

### 1.2 Missing

| Need | Why nothing existing covers it | Where it's specified |
| --- | --- | --- |
| Server time | `Date.now()` is the device clock, which players can change. The storage service records `updated_at` but never returns it to the game. | `scheduled-notifications.md` §2 |
| Game-requested reminders | Every game push today is written by first-party server code (end-of-day results, match turns). A game cannot ask for one. | `scheduled-notifications.md` §3–5 |
| Reading another user's pet [F1] / gifting [F2] | `OR.storage` is per-user only. | Out of scope for launch (§8) |

## 2. Time model

### 2.1 Two clocks, two jobs

| Question | Source | Why |
| --- | --- | --- |
| How much time has passed? | **Server clock** via `OR.time.now()` | Changing the phone's clock can't fast-forward her. It also removes clock differences between a player's phone and laptop, which share one pet. |
| What time of day is it for the player? | **Device time zone** (`Intl…timeZone`) | Drives day/night [A5], her bedtime, the daily reset and quiet hours. Faking the time zone only moves her bedtime, which is harmless. |

If `time.now` is unavailable (a mobile build that predates it), fall back to
`Date.now()` and rely on the guards in §2.3. The game must not refuse to run.

### 2.2 Catch-up simulation

One pure function drives both the offline catch-up and the live game:

```ts
advance(state: PetState, toMs: number, tz: string): { state: PetState; events: PetEvent[] }
```

- It moves time forward from `state.lastSimMs` to `toMs` in fixed
  **10-minute steps**. On each step it applies need decay, finishes any
  timers that are due, and checks sleep. It stops at `toMs` and stores the
  leftover partial step.
- **It is deterministic.** Anything random during catch-up (she found a
  pebble) uses a seeded RNG keyed on `(petId, stepIndex)`. So the same gap
  replayed on a phone and on a laptop produces the same events, and a
  duplicate replay can't give a double reward.
- `events` feed the "while you were away" summary [C3]. Those events are
  shown and then dropped. Milestones go to the journal [B4] in update 1.
- While the game is open, `advance` runs on a 1-minute UI tick using the
  server-corrected clock, so no second code path is needed.

### 2.3 Guards [G3]

- `elapsed = clamp(now − lastSimMs, 0, 7 days)`. A clock that goes backwards
  produces zero elapsed time, never negative. Absences longer than 7 days are
  capped, since with no death there is nothing to lose after the first day.
- `lastSimMs` only ever moves forward.
- This stops the realistic cheat, changing the device clock. It does not stop
  someone writing fake state straight into storage. That is acceptable while
  nothing a player does affects other players. It stops being acceptable with
  gifting [F2] (§8).

### 2.4 Two devices at once

`OR.storage` is last-writer-wins with no compare-and-set. To keep a phone and
a laptop from overwriting each other:

- The game re-reads `pet` on `visibilitychange → visible` before simulating.
- Every write carries a `rev` counter. If a read finds a higher `rev`, the
  game adopts that copy and replays forward instead of writing over it.
- The simulation is deterministic (§2.2), so adopting and replaying can't
  change what already happened. The worst case is losing one tap-level action
  made on both devices within the same few seconds.

## 3. State and storage keys

Stored as JSON strings in `OR.storage` with a `v1:` prefix so a future schema
change can migrate by key. Each value is well under the 16 KB cap.

| Key | Holds | Written when |
| --- | --- | --- |
| `v1:pet` | `petId`, name, coat colour, `bornAtMs`, `lastSimMs`, `rev`, needs, bond, stage, days visited, active timers, daily gift state, streak | Every action, and after catch-up |
| `v1:burrow` | Placed decor `[{ itemId, x, y, rot }]` | When decorating |
| `v1:inventory` | Clover, food counts, owned decor | When buying or collecting |
| `v1:settings` | Reminder opt-in and which reminder kinds, last known time zone | When settings change |
| `v1:journal` | Milestones, capped at 200 entries (oldest dropped) | Update 1 [B4] |

## 4. Systems (launch scope)

### 4.1 Needs and moods [A2, A4]

These four needs run from 0 to 100. The starting numbers live in one
`tuning.ts` file:

| Need | Awake decay | Asleep | Restored by |
| --- | --- | --- | --- |
| Hunger | −3/h | −1.5/h | Feed: +25 to +60 by food |
| Happiness | −3/h | 0 | Pet/tickle: +8, capped per hour; toys in update 1 |
| Energy | −4/h | **+12/h** | Sleep; nap timer [C1] |
| Cleanliness | −2/h | 0 | Clean: to 100 |

About 23h from 100 to the grumpy threshold (30), matching the "slow" pace.
Mood is **derived, never stored**. It's the lowest need mapped to a mood
(peckish, lonely, sleepy, dusty), or grumpy when two or more needs are under
30, or content otherwise. There is no floor state beyond grumpy: at zero she
just stays grumpy and sleepy until someone visits. Any single care action
visibly improves her mood straight away.

### 4.2 Day and night [A5]

She sleeps 22:00–07:00 in the player's local time (adjustable later). While
asleep the burrow is dim, tapping her gets a sleepy reaction, and needs decay
at the "asleep" rates above. The server doesn't need to know about sleep:
the simulation handles it, and quiet hours for pushes are enforced separately
(`scheduled-notifications.md` §4).

### 4.3 Bond and growth [B1, B2]

- **Bond** rises with care actions, with a daily cap so it can't be farmed.
  **It never goes down.** Neglect only pauses it. Bond levels unlock decor
  and her reactions.
- **Growth** goes kit → young → adult. It is gated on **days visited**, not
  calendar days, so a player who returns after a month doesn't find she grew
  up without them. Starting values: young at 3 days visited, adult at 10.

### 4.4 Timers [C1]

A timer is a `{ kind, startedAtMs, endsAtMs }` entry in `pet.timers`. The
simulation completes it and the player collects the result on their next
visit. At launch:

| Timer | Length | Result | Reminder key |
| --- | --- | --- | --- |
| Nap | 2h | Energy to 100, small bond gain | `nap-done` |
| Bake a treat | 1h | One treat (a better food) | `treat-ready` |

Only one of each can run at a time. The garden [C5] in update 1 reuses this
structure.

### 4.5 Daily gift and streak [C2]

It resets at **05:00 local time**, so a late-night visit still counts as
"today". Claiming it gives clover and sometimes food. The streak counts
consecutive days claimed. **A missed day pauses the streak; nothing ever
resets it.** The streak only ever affects the gift's contents.

### 4.6 Daily visitor [C6]

`OR.content.daily({ roundKey: 'YYYY-MM-DD' })` returns the day's visitor as a
UTC-day round. The shape is
`{ visitor: 'hedgehog', line: '…', gift: { itemId, qty } }`. It is written
server-side under `services/daily-content/`, the same place the other games'
daily content lives. If it returns `null`, there's no visitor that day and
the burrow still looks complete. The gift can be claimed once per round key.

### 4.7 Clover, food and decor [E1, E4]

- **Clover** comes from care actions (capped per day), the daily gift and the
  visitor. It's spent on food and decor. It is never sold for money.
- **The burrow** is a fixed-size room with a small grid. Decor items have a
  size and snap to the grid. About 30 decor items at launch, some unlocked by
  bond level.

### 4.8 Coat colour [A7]

Chosen at adoption from about 6 colours. They are done as **palette swaps of
one sprite sheet**, so each colour costs nothing extra to draw. Breeds with
different ear or body shapes are out of scope for launch.

### 4.9 Sign-in screen [G2]

If `OR.user` is null, the game shows a sleeping-rabbit illustration and
"Sign in to adopt your rabbit". On web it calls
`OR.actions.requestSignIn()`, checked with `capabilities.has`. Where that's
unsupported (mobile), it shows the text only. Nothing is saved before
sign-in.

### 4.10 Reminders [H1, H3–H6]

These use `OR.notifications.schedule/cancel` from
[`scheduled-notifications.md`](./scheduled-notifications.md). All reminder
UI is **hidden unless `capabilities.has('notifications.schedule')`**.

- **Opt-in [H6]**: the first time a timer starts, the game asks
  "Want a nudge when her nap's over?" The answer is saved in `v1:settings`.
  The platform's Games push setting still applies on the server regardless.
- **Kinds [H4]**, one key each, so rescheduling replaces the old one:

  | Key | Scheduled at | Copy (draft) |
  | --- | --- | --- |
  | `nap-done` | Nap `endsAtMs` | "{name} is awake and wants to play." |
  | `treat-ready` | Bake `endsAtMs` | "Something smells good in the burrow." |
  | `daily-gift` | Next local 05:00, only if today's gift was claimed | "{name} found you a gift." |
  | `misses-you` | `lastVisit + 24h`, moved later on every visit | "{name} keeps looking at the door." |

- Every visit reconciles: cancel what no longer applies, schedule what does.
- Limits [H5] (at most 2 a day, quiet hours, opt-in) are **enforced by the
  server**, not trusted from the game. The game just schedules what it
  would like to send.

### 4.11 Pet card [F3]

`OR.actions.share({ title, text })` with a line like
"Clover is 12 days old and loves dandelions 🥕" plus the game link. There is
no image (§8).

## 5. Art

This is the biggest non-engineering cost. The rule that keeps it manageable
is **one body, many layers**:

- One body sprite sheet per growth stage (3 at launch), with coat colours as
  palette swaps.
- Animations per stage: idle, blink, hop, eat, sleep, groom, happy, grumpy.
- Outfits [E2, update 1] are overlay layers anchored to each stage's head and
  neck points. They are drawn once per stage, not once per colour.
- Upbringing looks [B3, update 1] change details only (ear tuft, fluff,
  markings), again as overlays.
- Decor: about 30 static items at launch.

## 6. Code layout

This follows `rabbit-words/`: TypeScript source, built by
`build.config.mjs`.

```
rabbit-pets/
  index.html  styles.css  README.md  tsconfig.json
  src/
    main.ts          boot, sign-in screen, whenReady, visibility handling
    clock.ts         server-offset clock over OR.time.now(), Date.now() fallback
    sim.ts           advance(), pure — no DOM, no SDK
    sim.test.ts      decay, sleep windows, timers, clamp, determinism
    tuning.ts        every number in §4
    rng.ts           seeded RNG keyed on (petId, stepIndex)
    store.ts         OR.storage keys, rev handling, migrations
    reminders.ts     reconcile desired vs scheduled notifications
    render/          canvas renderer, sprites, burrow grid
    ui/              HUD, action bar, away summary, decor mode
```

`sim.ts` is pure so `npm test` covers the logic that matters most: a replay
across a 30-hour gap, a device clock that jumps backwards, and a gap replayed
on two devices with the same result.

## 7. Plan

**Phase 0 — contracts** (this document and `scheduled-notifications.md`).
Settle §2 and the verb shapes. Everything else can move.

**Phase 1 — launch**
Picked items: A1, A2, A4, A5, A7 (colours only), B1, B2, C1, C2, C3, C6, D1,
E1, E4, F3, G1, G2 (as the sign-in screen), G3, H1, H3, H4, H5, H6.

1. `sim.ts`, `tuning.ts` and tests. The simulation, with no rendering.
2. Store and clock, running first on `Date.now()` behind `clock.ts`.
3. Renderer, rabbit, burrow, the four care actions, the away summary.
4. Timers, daily gift, clover, decor shop and placement.
5. Daily visitor content and the `content.daily` wiring.
6. Platform work from `scheduled-notifications.md` (can run in parallel).
7. Reminders on web first. Mobile follows its App Store release, gated on the
   capability.

Exit criterion: a signed-in player on web and phone sees the same rabbit, in
the same state, after a 30-hour gap. Changing either device's clock moves
nothing forward. A nap reminder arrives on the phone, lands in the bell on
web, and never arrives during quiet hours.

**Phase 2 — update 1 (depth)**
A6 personality, B3 upbringing looks, B4 journal, C5 garden, C7 seasonal
events, C8 weather by date, E2 outfits, E3 collectibles shelf, G4 vacation
mode. Also D3 as a **single** mini-game that earns clover, limited to about 3
plays a day, so it can't turn into the whole game.

**Phase 3 — update 2 (platform)**
F1 visiting friends' burrows, F2 daily gifts to friends, H7 home-screen
widget. Each needs its own proposal (§8).

## 8. Deliberately out of scope, with what each would cost

- **On-device reminders [H2].** Duplicates H1, works on one device only,
  and does nothing on web. Dropped.
- **Visiting friends' burrows [F1].** Needs a cross-user read. The smallest
  version is a public "burrow snapshot" the owner publishes (a new verb, a
  table, a friend-scoped read route) instead of opening `OR.storage` to other
  users.
- **Gifts to friends [F2].** Needs a server-side inbox. It also means one
  player's actions can affect another's inventory, so pet state must become
  **server-validated**, not client-written (§2.3). That is the expensive part.
- **Home-screen widget [H7].** A native project in
  `oddsrabbit-app/targets/widgets`. It builds on `daily-game-widget.md`
  there, and needs a server-side summary of her mood, since a widget can't
  run the game.
- **Image pet card.** `actions.share` is text only. An image needs a new
  share payload on both hosts.
- **Email nudges [H8].** Not picked. The email queue could do it later.
- **More than one pet.** Decided against.

## 9. Open questions

1. **Growth gating.** Is it right to use days visited over calendar days
   (§4.3)? It's cozier, but a player who visits rarely keeps a kit for weeks.
2. **Bedtime.** Is a fixed 22:00–07:00 fine for launch, or should players set
   it from day one?
3. **Mobile sign-in.** Can a signed-out user reach the game on mobile at
   all? If not, the mobile branch of §4.9 is dead code.
4. **Tuning.** The numbers in §4.1 are a starting point. Plan a week of
   internal play before launch.
