# Per-game notification mute

Status: implemented 2026-10-06 (SDK, WordPress, web host, mobile host, Rabbit Pets).

## Why

Until now a player could only silence games all at once, with the
account-wide **Game Notifications** and **Game Reminders** settings. Someone
tired of Rabbit Words' daily results had to give up Word Battle's "your move"
too. Rabbit Pets added its own Settings sheet, but an in-game switch only
reaches what the game schedules itself (`notifications.schedule`); every other
game push is sent by the server:

| Source | Games | Sent by |
|---|---|---|
| End-of-day results / nudges | rabbit-words, word-warren, rabbit-globe, solitaire | `cron/process-game-end-of-day.php` |
| Match pushes (invited, started, your move, nudged, over) | word-battle | `MatchNotificationService` |
| Friends' gifts and visits | rabbit-pets | `AppSocialNotifier` |
| Scheduled reminders | rabbit-pets | `AppScheduledNotificationService::processDue` |

So the mute lives on the platform, once, and every game gets it.

## What a mute does

One row per (user, game) in `oddsrabbit_app_push_mutes`. While it exists,
nothing from that game reaches the user's phone. Each send path drops a muted
user exactly where it already drops one with `games_notifications_push` off,
so a mute behaves like that setting does, for one game:

- end-of-day and match pushes: no push and no bell row (as with the opt-out);
- gifts, visits and reminders: bell only (skip reason `muted` on reminders).

Not covered: match chat (a Chat conversation, muted in Chat) and season
honors (a reward, under the social settings).

Every read degrades to "nobody is muted" if it fails, so a bug can let a push
through but can never silence a game for everyone.

## Surfaces

- **Bridge verbs** `notifications.muted` → `{ muted }` and
  `notifications.setMuted({ muted })` → `{ muted }`. No scope needed: a game
  can only read or change its own mute, for the signed-in user.
  `notifications.status` also returns `muted`, and `push` is false while muted.
  A game that sees `push: false` should check `muted` before pointing the
  player at their account settings: the switch they need may be this game's.
- **SDK** `OR.notifications.muted(): Promise<boolean | null>` (null = unknown)
  and `OR.notifications.setMuted(muted): Promise<boolean>` (rejects on
  failure). Call `setMuted` only from the viewer's own tap: a game that
  unmutes itself undoes the very choice the mute exists for. If third-party
  games arrive, this verb should become mute-only or host-confirmed.
- **REST** `GET|PUT /apps/{slug}/notification-mute`, and
  `GET /apps/notification-mutes.json` for the list of games that can notify
  the viewer (bridge:notifications or bridge:social scope, an end-of-day push,
  or any match ever hosted, plus anything already muted).
- **Mobile app** one switch per game under Notification Settings → Game
  Notifications (the game screen has no menu to put it in).
- **Web** a "Phone notifications" switch in the game page's sidebar, kept in
  sync when the game changes the mute over the bridge.
- **Rabbit Pets** a Notifications switch at the top of its Settings sheet,
  above its per-kind reminder switches, which remain the game's own filter.

## Not every game gets an in-game switch

Games that never notify (2048, Flappy Rabbits, Liquid, Match3, Snake) show no
switch anywhere. Word Battle's turn pushes are its core loop, so it relies on
the platform switch rather than adding one of its own. Daily games can add an
in-game switch with the SDK verbs if a settings screen ever makes sense for
them.
