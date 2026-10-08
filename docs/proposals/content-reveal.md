# Withheld answers: `content.reveal`

Status: implemented 2026-10-08 (SDK, rabbit-globe, WordPress, web host, mobile
host). Off until the cutover option is set; see *Rollout*.

## Why

RabbitGlobe's `content.daily` shipped each round's `lat`/`lng`/`place`, because
the game scored locally to draw the reveal. Anyone with devtools could read the
day's answers and pin them exactly. `AppScoreVerifier` already recomputed the
score from the submitted pins, which stopped invented totals but not copied
answers: perfect pins earn a genuinely perfect score.

## What changes

- **`content.daily`** sends the clue fields only (`image`, `images`,
  `attribution`) for a withheld round.
- **`content.reveal`** `{ roundKey, index, guess }` → `{ roundKey, index,
  guess, reveal }`. The server returns item `index`'s answer for a guess at it.
  For a signed-in caller it first records the guess in
  `oddsrabbit_app_round_guesses`. The first guess per (round, user, item) wins
  and is what every later call returns as `guess`, so fetching an answer and
  then "guessing" it doesn't work, and neither does clearing storage to replay.
  It's public like `content.daily`: a guest gets the answer and nothing is
  recorded.
- **`scores.submit`** for a withheld round is scored from the recorded guesses
  (`AppScoreVerifier::verify(..., $recordedGuesses)`). The client's
  `metadata.guesses` and claimed score are ignored. A round missing a recorded
  guess (played as a guest, or begun on an old client) can't post.

`guess` and `reveal` are app-specific objects, as `content` is. Only
rabbit-globe has a reveal today (`AppContentReveal::supports()`); another game
gets `content/no-reveal`.

Error codes (`CONTENT_ERROR_CODES`): `content/not-available` (round not open),
`content/invalid-guess` (bad shape or index), `content/no-reveal`. The SDK's
`content.reveal()` rejects on any failure, because a game can't score without
it. None of these codes retire the verb.

## Not covered

Guessing as a guest or on a second account, then playing the real account. The
answers have to reach a guest to make the game playable, so this is the floor
for any daily game. Pins copied that way sit within metres of the answers; the
`kmTotal` kept in the score metadata shows that.

## Rollout

Nothing is withheld until the WordPress option
`oddsrabbit_rabbit_globe_reveal_from` holds a puzzle index. Rounds before it
keep the old model end to end, so a day in progress is never stranded.

1. **Backend**: deploy, then run the migration
   (`migrations/20261008_002_create_app_round_guesses.sql`).
2. **apps-sdk**: deploy the build, which includes the rabbit-globe bundle *and*
   the relay host (`src/host/host.ts`). The relay narrows `init.capabilities`
   to verbs in its own copy of the schema, so an old relay hides
   `content.reveal` from every game.
3. **Web host** (`games.js`) and **mobile host** (`AppHost.tsx`, an OTA
   update): both advertise and handle `content.reveal`.
4. Once the mobile update has had time to land, set the option to
   **tomorrow's** puzzle index, so the switch happens at midnight UTC:

   ```bash
   wp option update oddsrabbit_rabbit_globe_reveal_from <tomorrow's index>
   ```

   The index is the `N` in the `puzzle-N` round key (puzzle #1 is index 0, on
   2026-06-20). `wp option delete` turns it off again for future rounds.

A client without the verb shows an "update to play" screen for a withheld day
rather than a round it can't score.
