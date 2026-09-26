import { z } from 'zod';

export const STORAGE_KEY_MAX_LENGTH = 256;
export const STORAGE_VALUE_MAX_BYTES = 16 * 1024;

export const HAPTIC_TYPES = ['light', 'medium', 'success', 'error'] as const;
export const AppHapticTypeSchema = z.enum(HAPTIC_TYPES);
export type AppHapticType = z.infer<typeof AppHapticTypeSchema>;

export const LIFECYCLE_EVENTS = ['pause', 'resume', 'terminating'] as const;
export const AppLifecycleEventSchema = z.enum(LIFECYCLE_EVENTS);
export type AppLifecycleEvent = z.infer<typeof AppLifecycleEventSchema>;

export const COLOR_SCHEMES = ['light', 'dark'] as const;
export const AppColorSchemeSchema = z.enum(COLOR_SCHEMES);
export type AppColorScheme = z.infer<typeof AppColorSchemeSchema>;

/**
 * Season aggregations a game may ASK for. Closed on purpose: a client should
 * only ever send a metric it was built to understand, and an unknown value here
 * is a caller bug worth rejecting.
 *
 * Note this is the request side only — `SeasonBoardSchema.metric`, what the
 * server sends back, is deliberately open. `best_n` is designed (§3.7) but
 * unbuilt; adding it means a host redeploy before any game can send it.
 */
export const SEASON_METRICS = ['sum', 'max', 'qualified_avg'] as const;
export const SeasonMetricSchema = z.enum(SEASON_METRICS);
export type SeasonMetric = z.infer<typeof SeasonMetricSchema>;

/** Calendar month, `YYYY-MM`. */
const SeasonPeriod = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const StorageKey = z.string().min(1).max(STORAGE_KEY_MAX_LENGTH);
const StorageValue = z.string().max(STORAGE_VALUE_MAX_BYTES);
const CorrelationId = z.string().min(1).max(128);
const RoundKey = z.string().min(1).max(128);

export const SCORE_METADATA_MAX_BYTES = 2 * 1024;

// ---- Matches (async turn-based multiplayer) ----
// See docs/proposals/multiplayer-matches.md. The bridge is game-agnostic: a
// `move` and a `view` are opaque objects that the server-side rules class for
// `game` validates and filters. Nothing here knows what Connect Four is.

/** A move is a human action, never a board: 2 KB is generous for any game. */
export const MATCH_MOVE_MAX_BYTES = 2 * 1024;

export const MATCH_MIN_PLAYERS = 2;
export const MATCH_MAX_PLAYERS = 4;

export const MATCH_STATUSES = ['lobby', 'active', 'finished', 'abandoned'] as const;
export const MatchStatusSchema = z.enum(MATCH_STATUSES);
export type MatchStatus = z.infer<typeof MatchStatusSchema>;

export const MATCH_PLAYER_STATUSES = ['invited', 'joined', 'resigned', 'forfeited'] as const;
export const MatchPlayerStatusSchema = z.enum(MATCH_PLAYER_STATUSES);
export type MatchPlayerStatus = z.infer<typeof MatchPlayerStatusSchema>;

/** `matches.list` filter. `all` includes finished and abandoned matches. */
export const MATCH_LIST_FILTERS = ['active', 'finished', 'all'] as const;
export const MatchListFilterSchema = z.enum(MATCH_LIST_FILTERS);
export type MatchListFilter = z.infer<typeof MatchListFilterSchema>;

/**
 * Per-call outcomes a move can have. These describe ONE request, not the host,
 * so the SDK must never treat them as "unsupported" — a rejected move is a
 * normal part of play and the next call can succeed.
 */
export const MATCH_ERROR_CODES = {
  /** The `version` sent is behind the server's: refetch and retry on the new view. */
  versionConflict: 'match/version-conflict',
  /** It is another seat's turn (or the match is not active). */
  notYourTurn: 'match/not-your-turn',
  /** The rules class rejected the move; `message` carries the reason. */
  illegalMove: 'match/illegal-move',
  /** No such match, or the viewer is not a participant in it. */
  notFound: 'match/not-found',
  /** The join code's table is already full or the lobby has closed. */
  full: 'match/full',
  /** An invitee is not connected to the creator on the follow graph. */
  notConnected: 'match/not-connected',
  /**
   * `matches.nudge` or `matches.claim` came before it is allowed: the turn is
   * too young, or this player already nudged in the last day. `message` says
   * when, in words a player can read ("You can nudge again in 5 hours.").
   */
  tooSoon: 'match/too-soon',
} as const;

/** How long the seat on turn must have been idle before `matches.nudge`, and the gap between one sender's nudges. */
export const MATCH_NUDGE_AFTER_SECONDS = 24 * 3600;
/** How long the seat on turn must have been idle before `matches.claim`. */
export const MATCH_CLAIM_AFTER_SECONDS = 14 * 24 * 3600;

const MatchUuid = z.string().uuid();
/** Six characters from an unambiguous alphabet (no 0/O/1/I). */
export const JOIN_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
const JoinCode = z.string().regex(JOIN_CODE_PATTERN);
/** Rules-class id, e.g. `connect4`. */
const MatchGame = z.string().min(1).max(32);
const MatchSeat = z.number().int().min(0).max(MATCH_MAX_PLAYERS - 1);

const MatchMove = z
  .record(z.unknown())
  .refine((m) => JSON.stringify(m).length <= MATCH_MOVE_MAX_BYTES, {
    message: `move exceeds ${MATCH_MOVE_MAX_BYTES}-byte cap`,
  });

/**
 * A reminder's key: the game's own name for it, e.g. `nap-done`. Scheduling the
 * same key again replaces the pending reminder rather than adding one, so a game
 * can move a reminder forward on every visit without piling them up.
 */
export const NOTIFICATION_KEY_PATTERN = /^[a-z0-9-]{1,64}$/;
export const NOTIFICATION_TITLE_MAX = 64;
export const NOTIFICATION_BODY_MAX = 160;

/**
 * Per-call outcomes of `notifications.*`. Like `MATCH_ERROR_CODES` these
 * describe one request, never the host, so the SDK must not treat them as
 * "unsupported": a reminder rejected for being too far out says nothing about
 * whether the next one will land.
 */
export const NOTIFICATION_ERROR_CODES = {
  /** A key, title, body or time the server rejected; `message` says which. */
  invalid: 'notifications/invalid',
  /** `fireAt` is less than a minute away, or more than 14 days. */
  badTime: 'notifications/bad-time',
  /** Five reminders are already pending for this app. Cancel one first. */
  tooMany: 'notifications/too-many',
  /** The app's manifest does not declare `bridge:notifications`. */
  forbidden: 'notifications/forbidden',
  /** Too many schedules or cancels in the last minute. */
  rateLimited: 'notifications/rate-limited',
} as const;

const NotificationKey = z.string().regex(NOTIFICATION_KEY_PATTERN);

/** Largest serialised `showcase.publish` snapshot, in bytes of JSON. */
export const SHOWCASE_MAX_BYTES = 8192;
export const SHOWCASE_FRIENDS_MAX = 100;
/** A gift's `kind`: the game's own word for it, e.g. `clover`. */
export const GIFT_KIND_PATTERN = /^[a-z0-9-]{1,32}$/;
export const GIFT_MESSAGE_MAX = 80;

/**
 * Per-call outcomes of `showcase.*`. Like the notification codes these describe
 * one request, never the host, so the SDK does not treat them as "unsupported".
 */
export const SOCIAL_ERROR_CODES = {
  /** `data` was not an object, or a uuid was malformed. */
  invalid: 'social/invalid',
  /** The snapshot is over `SHOWCASE_MAX_BYTES` once serialised. */
  tooLarge: 'social/too-large',
  /** Too many publishes in the last minute. */
  rateLimited: 'social/rate-limited',
  /** `showcase.get` for someone the viewer doesn't follow and isn't followed by. */
  notConnected: 'social/not-connected',
  /** The app's manifest does not declare `bridge:social`. */
  forbidden: 'social/forbidden',
} as const;

/** Per-call outcomes of `gifts.*`. None of them retire the verb. */
export const GIFT_ERROR_CODES = {
  /** A bad kind or message, or a gift to yourself. */
  invalid: 'gifts/invalid',
  /** The recipient isn't connected to the sender on the follow graph. */
  notConnected: 'gifts/not-connected',
  /** The sender already gave this recipient a gift today (UTC). */
  alreadySentToday: 'gifts/already-sent-today',
  /** The sender has used today's gifts for this app (10, UTC day). */
  tooMany: 'gifts/too-many',
  /** No such gift for this viewer (someone else's, or older than 7 days). */
  notFound: 'gifts/not-found',
  /** The gift was already claimed. */
  claimed: 'gifts/claimed',
  /** Too many sends or claims in the last minute. */
  rateLimited: 'gifts/rate-limited',
} as const;

/** Most uuids one `visits.seen` call may name. */
export const VISITS_SEEN_MAX = 50;

/** Per-call outcomes of `visits.*`. None of them retire the verb. */
export const VISIT_ERROR_CODES = {
  /** A bad kind, a visit to yourself, or a malformed `visits.seen` list. */
  invalid: 'visits/invalid',
  /** The friend isn't connected to the visitor on the follow graph. */
  notConnected: 'visits/not-connected',
  /** The visitor already visited this friend today (UTC). */
  alreadyVisitedToday: 'visits/already-visited-today',
  /** The visitor has used today's visits for this app (10, UTC day). */
  tooMany: 'visits/too-many',
  /** Too many records or seen calls in the last minute. */
  rateLimited: 'visits/rate-limited',
} as const;

const Uuid = z.string().uuid();

export const BridgeRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('storage.get'),
    correlationId: CorrelationId,
    payload: z.object({ key: StorageKey }),
  }),
  z.object({
    type: z.literal('storage.set'),
    correlationId: CorrelationId,
    payload: z.object({ key: StorageKey, value: StorageValue }),
  }),
  z.object({
    type: z.literal('storage.delete'),
    correlationId: CorrelationId,
    payload: z.object({ key: StorageKey }),
  }),
  z.object({
    type: z.literal('scores.submit'),
    correlationId: CorrelationId,
    payload: z.object({
      roundKey: RoundKey,
      // Integer only — bridge contract matches the server's signed INT
      // column. Per-app min/max belongs to app logic; the platform stays
      // generic (golf-style negative scores work too).
      score: z.number().int().min(-2147483648).max(2147483647),
      // App-specific shape (e.g. { won, guessCount } for rabbit-words).
      // Server enforces the same cap, but failing here avoids a wasted
      // bridge round-trip.
      metadata: z
        .record(z.unknown())
        .refine(
          (m) => JSON.stringify(m).length <= SCORE_METADATA_MAX_BYTES,
          { message: `metadata exceeds ${SCORE_METADATA_MAX_BYTES}-byte cap` }
        )
        .optional(),
      // Opt-in "keep the highest score": a resubmit under a CONSTANT roundKey
      // updates the row only when the new score beats the stored one, and never
      // rejects as already-submitted. For all-time high-score boards (2048).
      // Omitted/false keeps the default one-submission-per-round behaviour that
      // the daily games rely on.
      keepBest: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('scores.friends'),
    correlationId: CorrelationId,
    payload: z.object({
      roundKey: RoundKey,
    }),
  }),
  // Community score histogram for a round, derived server-side from the scores
  // table (the source of truth) rather than a parallel aggregate table that
  // can drift. Public read — guests can fetch it without auth.
  z.object({
    type: z.literal('scores.distribution'),
    correlationId: CorrelationId,
    payload: z.object({
      roundKey: RoundKey,
    }),
  }),
  // Global top-N leaderboard for a round — all players, not follow-graph
  // restricted. Public read (guests see the board). `order`: 'top' (default, by
  // score) or 'first' (earliest submitters / hall-of-fame). `limit` clamped
  // server-side to 1..100.
  z.object({
    type: z.literal('scores.top'),
    correlationId: CorrelationId,
    payload: z.object({
      roundKey: RoundKey,
      limit: z.number().int().min(1).max(100).optional(),
      order: z.enum(['top', 'first']).optional(),
    }),
  }),
  // Monthly season board for the app — every player's daily rows across one
  // calendar month, aggregated server-side into a single ranked number. Public
  // read, like `scores.top`.
  //
  // No `roundKey`: a season spans a month of them, and only the server can
  // expand `period` into the app's actual key list (DailyGameRegistry holds each
  // daily game's epoch). No client can compute this board either way — a game
  // can read its own storage and aggregate endpoints, never other users' round
  // history.
  z.object({
    type: z.literal('scores.season'),
    correlationId: CorrelationId,
    payload: z.object({
      // Calendar month, `YYYY-MM`. Deliberately not a rolling 30-day window:
      // seasons reset on month boundaries, and month length varies. UTC, like
      // every other day boundary in these games (each daily app derives its
      // puzzle index from a `Date.UTC` epoch).
      period: SeasonPeriod,
      // How the month's rows collapse into one number. Omit to take the app's
      // own server-side default.
      metric: SeasonMetricSchema.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  }),
  // The viewer's own row and true rank in a round, however far down they are.
  //
  // A companion to `scores.top`, not a flag on it: that board is a public read
  // and is cached server-side, while this answer exists only for a signed-in
  // viewer. Split, the board stays guest-readable and cacheable and only the
  // pinned row costs a per-viewer query.
  //
  // `order` must match the board being annotated — a rank computed under
  // `order: 'top'` describes a different ordering than a hall-of-fame board.
  z.object({
    type: z.literal('scores.rank'),
    correlationId: CorrelationId,
    payload: z.object({
      roundKey: RoundKey,
      order: z.enum(['top', 'first']).optional(),
    }),
  }),
  // The same for a season board. This is the one that carries its weight: a
  // daily board's viewer has just played and knows their score, but nobody can
  // work out their own monthly standing — days played, capped attendance, a
  // mean across the month — so a season board with no self row tells a player
  // outside the top N nothing at all about themselves.
  z.object({
    type: z.literal('scores.seasonRank'),
    correlationId: CorrelationId,
    payload: z.object({
      period: SeasonPeriod,
      metric: SeasonMetricSchema.optional(),
    }),
  }),
  // Server-authored daily content for a round (e.g. today's puzzle / answer).
  // Public read — guests can fetch it without auth. The server date-gates by
  // round, so a host can only ever serve the current or past rounds, never a
  // future one. The `content` shape is app-specific; the SDK forwards it as an
  // opaque object and each app validates its own fields.
  z.object({
    type: z.literal('content.daily'),
    correlationId: CorrelationId,
    payload: z.object({
      roundKey: RoundKey,
    }),
  }),
  // ---- Matches. All authenticated: a guest cannot be in a match. Every read
  // is PER-VIEWER (the server filters `view` to what this seat may see — other
  // players' racks are never on the wire), so none of these are public or
  // cacheable the way `scores.top` is. Six verbs rather than fields on
  // existing ones: a new field is undetectable through the capability
  // handshake, a new verb is not.
  z.object({
    type: z.literal('matches.create'),
    correlationId: CorrelationId,
    payload: z.object({
      game: MatchGame,
      maxPlayers: z.number().int().min(MATCH_MIN_PLAYERS).max(MATCH_MAX_PLAYERS),
      // Seats to fill by invitation. The server requires each to be connected
      // to the creator on the follow graph (either direction), so nobody can
      // be pulled into a match by a stranger. The creator's own seat is
      // implicit, hence at most maxPlayers - 1.
      invitees: z.array(z.string().uuid()).max(MATCH_MAX_PLAYERS - 1).optional(),
      // Mint a join code so seats left after invitees can be filled by anyone
      // who has it. A table with neither invitees nor `open` is a lobby nobody
      // can enter, which the server rejects.
      open: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('matches.join'),
    correlationId: CorrelationId,
    payload: z.union([
      z.object({ matchUuid: MatchUuid }),
      z.object({ joinCode: JoinCode }),
    ]),
  }),
  z.object({
    type: z.literal('matches.list'),
    correlationId: CorrelationId,
    payload: z.object({
      status: MatchListFilterSchema.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  }),
  z.object({
    type: z.literal('matches.get'),
    correlationId: CorrelationId,
    payload: z.object({ matchUuid: MatchUuid }),
  }),
  z.object({
    type: z.literal('matches.move'),
    correlationId: CorrelationId,
    payload: z.object({
      matchUuid: MatchUuid,
      // The `version` of the view this move was made against. A stale value
      // rejects with `match/version-conflict` rather than applying a move to a
      // position the player never saw (two tabs; a WebView resumed hours
      // later). Optimistic concurrency, no row locks held across a round trip.
      version: z.number().int().nonnegative(),
      // Opaque to the bridge: the rules class for the match's `game` decides
      // what a move is. Always an ACTION (column dropped, tiles placed) and
      // never a board — the server applies it to its own state.
      move: MatchMove,
    }),
  }),
  z.object({
    type: z.literal('matches.resign'),
    correlationId: CorrelationId,
    payload: z.object({ matchUuid: MatchUuid }),
  }),
  // Remind the seat on turn that it is their move (a push). Only from a
  // waiting player, once the turn is a day old, and at most once a day per
  // sender; otherwise `match/too-soon`. Changes nothing about the match.
  z.object({
    type: z.literal('matches.nudge'),
    correlationId: CorrelationId,
    payload: z.object({ matchUuid: MatchUuid }),
  }),
  // End a stalled turn: once the seat on turn has been idle for 14 days, a
  // waiting player may claim it. With two players left the match finishes
  // scored as it stands (higher score wins, a tie is a draw, nobody forfeits);
  // with three or four the idle seat is forfeited and the rest play on.
  // Before 14 days, `match/too-soon`.
  z.object({
    type: z.literal('matches.claim'),
    correlationId: CorrelationId,
    payload: z.object({ matchUuid: MatchUuid }),
  }),
  // People the viewer may invite: connected on the follow graph in either
  // direction. Scoped to matches rather than a general social read, so it
  // exposes exactly the set `matches.create` will accept and nothing more.
  z.object({
    type: z.literal('matches.invitable'),
    correlationId: CorrelationId,
    payload: z.object({
      limit: z.number().int().min(1).max(200).optional(),
      // Skip this many rows, so a client can page past `limit` and hold the
      // whole set. Without it a follow graph larger than 200 is invisible past
      // the first page, and a picker that searches only what it fetched tells
      // the player someone is not there when they are.
      //
      // Deliberately an offset rather than a cursor: the response stays a bare
      // `InvitablePlayer[]`, so this is additive and every existing host keeps
      // answering it. A host that ignores the field returns page 1 again, which
      // a caller detects as "no new rows" and stops on — the same result as
      // today, never a loop.
      offset: z.number().int().min(0).max(10000).optional(),
    }),
  }),
  // The server's clock, for games that measure real elapsed time. Public: it
  // reveals nothing, and a game asks before it knows who the user is. The SDK
  // corrects for round-trip time and caches the offset, so hosts see a few
  // calls a session, not one per frame.
  z.object({
    type: z.literal('time.now'),
    correlationId: CorrelationId,
  }),
  // ---- Scheduled notifications. All authenticated, and always the signed-in
  // user's own reminders for this app: there is no way to name another user.
  // The SERVER enforces the limits (the user's opt-in, 5
  // pending; daily caps exist but are off for first-party games), so these
  // payloads say what the game would like, not what will happen. The limits
  // live in AppNotificationPolicy on the server.
  z.object({
    type: z.literal('notifications.schedule'),
    correlationId: CorrelationId,
    payload: z.object({
      key: NotificationKey,
      // When the game would like it delivered. It goes out then; there are no
      // quiet hours.
      fireAt: z.string().datetime({ offset: true }),
      title: z.string().min(1).max(NOTIFICATION_TITLE_MAX),
      body: z.string().min(1).max(NOTIFICATION_BODY_MAX),
      // IANA zone from the device, filled in by the SDK. Only used to pick the
      // local day the per-day cap counts against, so a wrong one costs little.
      tz: z.string().min(1).max(64).optional(),
    }),
  }),
  z.object({
    type: z.literal('notifications.cancel'),
    correlationId: CorrelationId,
    payload: z.object({ key: NotificationKey }),
  }),
  z.object({
    type: z.literal('notifications.list'),
    correlationId: CorrelationId,
  }),
  // Whether a reminder push would reach the viewer right now: their Games and
  // Game reminders settings are on and they have a device to send to. Lets a
  // game offer "we'll leave a note in your bell" instead of a push that will
  // never arrive. The bell entry is written either way.
  z.object({
    type: z.literal('notifications.status'),
    correlationId: CorrelationId,
  }),
  // ---- Friends: showcases and gifts (`bridge:social`). All authenticated.
  // "Friends" is the follow graph, either direction, with no block between
  // them. The server enforces the size cap, rate limits and gift limits.
  z.object({
    type: z.literal('showcase.publish'),
    correlationId: CorrelationId,
    // The game's snapshot of itself for friends to look at. The platform
    // stores it as-is; at most SHOWCASE_MAX_BYTES of JSON.
    payload: z.object({ data: z.record(z.unknown()) }),
  }),
  z.object({
    type: z.literal('showcase.friends'),
    correlationId: CorrelationId,
    payload: z
      .object({ limit: z.number().int().min(1).max(SHOWCASE_FRIENDS_MAX).optional() })
      .optional(),
  }),
  z.object({
    type: z.literal('showcase.get'),
    correlationId: CorrelationId,
    payload: z.object({ userUuid: Uuid }),
  }),
  z.object({
    type: z.literal('gifts.send'),
    correlationId: CorrelationId,
    payload: z.object({
      toUserUuid: Uuid,
      kind: z.string().regex(GIFT_KIND_PATTERN),
      message: z.string().max(GIFT_MESSAGE_MAX).optional(),
    }),
  }),
  z.object({
    type: z.literal('gifts.inbox'),
    correlationId: CorrelationId,
  }),
  z.object({
    type: z.literal('gifts.claim'),
    correlationId: CorrelationId,
    payload: z.object({ giftUuid: Uuid }),
  }),
  z.object({
    type: z.literal('gifts.sentToday'),
    correlationId: CorrelationId,
  }),
  // Visits: a sibling of gifts with its own one-per-friend-per-day slot. The
  // push line comes from the app manifest's `social.visitLines`, never from
  // the game at runtime.
  z.object({
    type: z.literal('visits.record'),
    correlationId: CorrelationId,
    payload: z.object({
      toUserUuid: Uuid,
      kind: z.string().regex(GIFT_KIND_PATTERN),
    }),
  }),
  z.object({
    type: z.literal('visits.inbox'),
    correlationId: CorrelationId,
  }),
  z.object({
    type: z.literal('visits.seen'),
    correlationId: CorrelationId,
    payload: z.object({ visitUuids: z.array(Uuid).min(1).max(VISITS_SEEN_MAX) }),
  }),
  z.object({
    type: z.literal('visits.sentToday'),
    correlationId: CorrelationId,
  }),
  z.object({
    type: z.literal('actions.share'),
    correlationId: CorrelationId,
    payload: z.object({
      title: z.string().max(140).optional(),
      text: z.string().max(2000).optional(),
    }),
  }),
  z.object({
    type: z.literal('actions.haptic'),
    correlationId: CorrelationId,
    payload: z.object({ type: AppHapticTypeSchema }),
  }),
  z.object({
    type: z.literal('actions.requestSignIn'),
    correlationId: CorrelationId,
    payload: z
      .object({
        reason: z.string().min(1).max(200).optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal('session.refresh'),
    correlationId: CorrelationId,
  }),
  z.object({
    type: z.literal('ready'),
    correlationId: CorrelationId,
  }),
]);

export type BridgeRequest = z.infer<typeof BridgeRequestSchema>;
export type BridgeRequestType = BridgeRequest['type'];

/**
 * Every verb the schema above models, as runtime values, derived from the union
 * so it can't drift out of sync with it.
 *
 * A host needs this to tell the two schema failures apart: a request whose
 * `type` isn't in this list is a verb the host doesn't implement (permanent —
 * the SDK caches it and `capabilities.has()` goes false), while a request whose
 * `type` IS here only failed payload validation (a per-call bug in the caller
 * that must not retire the verb). Both look identical to `safeParse`.
 */
export const BRIDGE_REQUEST_TYPES: readonly BridgeRequestType[] =
  BridgeRequestSchema.options.map((option) => option.shape.type.value);

/** Whether `value` names a verb `BridgeRequestSchema` knows about. */
export function isBridgeRequestType(
  value: unknown
): value is BridgeRequestType {
  return (
    typeof value === 'string' &&
    (BRIDGE_REQUEST_TYPES as readonly string[]).includes(value)
  );
}

export const BridgeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export type BridgeError = z.infer<typeof BridgeErrorSchema>;

export const BridgeResponseSchema = z.object({
  type: z.literal('response'),
  correlationId: CorrelationId,
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: BridgeErrorSchema.optional(),
});

export type BridgeResponse = z.infer<typeof BridgeResponseSchema>;

export const BridgeLifecycleMessageSchema = z.object({
  type: z.literal('lifecycle'),
  event: AppLifecycleEventSchema,
});

export type BridgeLifecycleMessage = z.infer<
  typeof BridgeLifecycleMessageSchema
>;

export const BridgeUserSchema = z.object({
  uuid: z.string().uuid(),
  username: z.string().min(1).max(64),
  // Avatar URL. `.nullable()` covers users with no avatar set (mini-apps fall
  // back to initials), and `.default(null)` makes the field optional on the
  // wire (older outer hosts that predate this addition simply don't send it →
  // parses to null). The combined output type is `string | null` — no
  // `undefined` to handle on the consumer side.
  avatar: z.string().url().nullable().default(null),
  // ISO datetime the account was created. Same nullable + default-null pattern
  // as `avatar`: nullable so an outer host can explicitly disclaim the value,
  // default-null so older outer hosts that don't populate it still parse.
  createdAt: z.string().datetime().nullable().default(null),
  // Whether the user holds the platform Supporter tier. `.default(false)` so
  // older outer hosts that predate the field still parse (and read as "not a
  // supporter", which is the safe side for anything that thanks them).
  // Display-only: it reaches the mini-app through the user's device and can
  // be edited there. A backend granting anything must read the `supporter`
  // claim from the verified session token instead.
  supporter: z.boolean().default(false),
});

export type BridgeUser = z.infer<typeof BridgeUserSchema>;

export const FriendScoreSchema = z.object({
  uuid: z.string().uuid(),
  username: z.string().min(1).max(64),
  score: z.number().int(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  // Photo avatar URL, or null when the user has none. `.default(null)` keeps
  // older outer hosts that predate this field parsing cleanly (→ null).
  avatar: z.string().url().nullable().default(null),
  // True when this row is the viewer themselves. Older outer hosts predate
  // this field; `.default(false)` keeps SDK consumers' types simple while
  // still parsing pre-isSelf responses.
  isSelf: z.boolean().default(false),
});

export type FriendScore = z.infer<typeof FriendScoreSchema>;

// One row of a global top-N leaderboard (`scores.top`). Same shape as a friend
// score minus `isSelf` — a public board has no single viewer, so the app
// highlights its own row by matching `uuid` against `OddsRabbit.user`.
export const TopScoreEntrySchema = FriendScoreSchema.omit({ isSelf: true });

export type TopScoreEntry = z.infer<typeof TopScoreEntrySchema>;

// One bucket of a round's community score distribution. `score` is the raw
// integer the app submitted; the app maps it back to its own buckets (e.g.
// rabbit-words inverts `ROW_COUNT + 1 - guessCount`). `count` is the number of
// distinct submissions with that score.
export const ScoreDistributionEntrySchema = z.object({
  score: z.number().int(),
  count: z.number().int().nonnegative(),
});

export type ScoreDistributionEntry = z.infer<typeof ScoreDistributionEntrySchema>;

// One player's row on a season board.
export const SeasonEntrySchema = z.object({
  uuid: z.string().uuid(),
  username: z.string().min(1).max(64),
  avatar: z.string().url().nullable().default(null),
  // The ranked number, whichever metric produced it. Generic because the metric
  // varies per app: a points total for rabbit-globe, a mean for rabbit-words, a
  // single best score for 2048.
  value: z.number(),
  // Days in the period with a recorded score. Both the qualifier input for
  // `qualified_avg` and a row badge in its own right.
  daysPlayed: z.number().int().nonnegative(),
  // Mean score across days played. The tie-break under `qualified_avg`, and a
  // secondary figure elsewhere. Null when the server didn't compute one.
  average: z.number().nullable().default(null),
  // Longest run of consecutive played days. Displayed as a badge and NEVER a
  // sort key — as a ranking it is ties all the way down with no skill component
  // (§3.7).
  streak: z.number().int().nonnegative().default(0),
  isSelf: z.boolean().default(false),
});

export type SeasonEntry = z.infer<typeof SeasonEntrySchema>;

// A season board plus the context needed to explain it on screen.
//
// Richer than the other reads (which return a bare array) because a season
// ranking isn't self-evident the way "top 20 by score" is: the UI has to be able
// to say what the number means and what it took to qualify.
export const SeasonBoardSchema = z.object({
  period: SeasonPeriod,
  // Open, unlike the request's `SeasonMetricSchema`. This field is descriptive:
  // it tells the UI what it is looking at so it can caption the board. Pinning
  // it to an enum makes every metric the platform adds later a BREAKING change
  // for bundles already in the wild — and a silent one, because a rejected
  // envelope renders as an empty month, not an error. rabbit-globe and solitaire
  // send no `metric` at all and take the app's server-side default, so a config
  // change alone would be enough to blank their boards. `best_n` is already
  // designed (§3.7). A metric the bundle doesn't recognise still has a correctly
  // ranked board behind it; the UI just captions it generically.
  metric: z.string().min(1),
  // Puzzle days the server actually expanded for this period — NOT calendar
  // days. A game's launch month is partial (rabbit-globe's epoch is 2026-06-20,
  // so June 2026 holds 11), and anything derived from window length has to use
  // this or it misreports that month.
  //
  // Two adjustments, not one: the count is ALSO capped at today, so the live
  // month grows day by day rather than reporting its final total from the 1st.
  // June 2026 for rabbit-globe reads 11 only once June is over; on the 25th it
  // is 6. This is what keeps a `qualified_avg` board populated mid-month
  // instead of empty until two-thirds of the month has elapsed — but it means
  // `puzzleDays` is not stable within a period, and neither is the
  // `qualifyingDays` derived from it. Don't cache either across a day boundary.
  // (The server's own transient for a live month is 10 minutes and its key has
  // no day component, so for up to 10 minutes past UTC midnight both figures
  // can still describe yesterday. Bounded and self-correcting — but it means a
  // client that caches on top of it compounds the skew rather than starting
  // fresh from it.)
  puzzleDays: z.number().int().nonnegative(),
  // Days played needed to be ranked on skill on a `qualified_avg` board,
  // computed server-side as `ceil(puzzleDays * 2/3)` and sent so the client can
  // state the rule without re-deriving it — two implementations of one formula
  // will drift. Null for metrics that have no qualifier.
  //
  // NOT a visibility filter. `AppScoresService::seasonForPeriod` orders by
  // `LEAST(COUNT(*), qualifyingDays) DESC, avg_score DESC` with no `HAVING`, so
  // a player below the threshold is still returned — ranked under everyone who
  // met it, however good their average. A UI that reads this as "minimum days
  // to appear" will render those rows as though their average placed them,
  // which looks like the board is mis-sorted. Mark them instead (see
  // `src/ui/season.ts`).
  qualifyingDays: z.number().int().nonnegative().nullable().default(null),
  entries: z.array(SeasonEntrySchema),
});

export type SeasonBoard = z.infer<typeof SeasonBoardSchema>;

/**
 * Wire-tolerant twin of `SeasonBoardSchema`, used by the SDK to parse an
 * inbound board.
 *
 * `entries` is left unvalidated here on purpose so the SDK can check rows one
 * at a time and drop only the bad ones. Validating the array inside the
 * envelope makes it all-or-nothing: a single user with a null `uuid` — which
 * the backend's LEFT JOIN can still produce (§2.3) — would empty the entire
 * season board. That is the exact failure per-row parsing was introduced to
 * fix, and nesting the array quietly reintroduces it.
 *
 * `SeasonBoardSchema` stays strict: it is the contract the server writes to.
 */
export const SeasonBoardEnvelopeSchema = SeasonBoardSchema.extend({
  entries: z.array(z.unknown()),
});

// The viewer's placement on a round board (`scores.rank`).
//
// `entry` is a full row rather than just a number so the pinned line can go
// through the same renderer as the board above it — it carries the avatar and
// metadata a row needs, and `isSelf` is true by construction (unlike on the
// public board, this endpoint has a viewer).
export const RoundRankSchema = z.object({
  rank: z.number().int().positive(),
  // Players with a row in this round, so the UI can say "#12 of 340" rather
  // than a bare ordinal — a rank means very little without the field size.
  //
  // `.default(0)` to match `SeasonRankSchema.total`, and for the usual reason:
  // a host that predates the field would otherwise fail the whole parse, and a
  // rank with no field size is still worth pinning. The UI drops the "of N"
  // line at 0 rather than printing "of 0 players".
  total: z.number().int().nonnegative().default(0),
  entry: FriendScoreSchema,
});

export type RoundRank = z.infer<typeof RoundRankSchema>;

// The viewer's placement on a season board (`scores.seasonRank`).
//
// Carries `period`/`metric`/`puzzleDays`/`qualifyingDays` of its own rather
// than borrowing the board's. The two are separate calls and the server caches
// them differently, so they can straddle a UTC midnight — after which
// `puzzleDays` has stepped and the `qualifyingDays` derived from it with it.
// Captioning the pinned row from the board's copy would then state a qualifier
// the viewer's own rank was not computed against.
//
// `rank`/`entry` are null together when the viewer played no day in the period.
// Not having played is a normal answer to "where am I", so it is a 200 with
// nulls rather than an error.
export const SeasonRankSchema = z.object({
  period: SeasonPeriod,
  metric: z.string().min(1),
  puzzleDays: z.number().int().nonnegative(),
  qualifyingDays: z.number().int().nonnegative().nullable().default(null),
  rank: z.number().int().positive().nullable().default(null),
  total: z.number().int().nonnegative().default(0),
  entry: SeasonEntrySchema.nullable().default(null),
});

export type SeasonRank = z.infer<typeof SeasonRankSchema>;

// Result of `content.daily`: the server-authored content for one round. `content`
// is an opaque, app-specific object (e.g. rabbit-words: `{ answer }`) — the
// platform does not interpret it. Apps validate their own
// shape after the bridge returns. A round that isn't available yet (future
// `available_at`) resolves to `null` rather than this object.
export const DailyContentSchema = z.object({
  roundKey: z.string().min(1),
  content: z.record(z.unknown()),
});

export type DailyContent = z.infer<typeof DailyContentSchema>;

// One seat in a match. The `uuid`/`username`/`avatar`/`isSelf` quartet is the
// same as a score row on purpose, so the shared leaderboard renderer can draw
// the player strip without a second avatar path.
export const MatchPlayerSchema = z.object({
  seat: MatchSeat,
  uuid: z.string().uuid(),
  username: z.string().min(1).max(64),
  avatar: z.string().url().nullable().default(null),
  status: MatchPlayerStatusSchema,
  score: z.number().int().default(0),
  isSelf: z.boolean().default(false),
});

export type MatchPlayer = z.infer<typeof MatchPlayerSchema>;

// One person the viewer may invite (`matches.invitable`). Same identity
// triple as every other row so the shared renderer draws it.
export const InvitablePlayerSchema = z.object({
  uuid: z.string().uuid(),
  username: z.string().min(1).max(64),
  avatar: z.string().url().nullable().default(null),
  // Whether the viewer follows them, is followed by them, or both. Purely
  // for the picker's ordering and badge; the server accepts any of the three.
  relation: z.enum(['following', 'follower', 'mutual']).default('following'),
});

export type InvitablePlayer = z.infer<typeof InvitablePlayerSchema>;

// The list-screen shape: everything a row needs to show whose turn it is and
// who is playing, and nothing that costs a per-viewer filter (`view`) or is
// private to the lobby (`joinCode`).
//
// `players` is validated strictly, unlike a board's rows. Dropping one bad row
// from a board loses one line; dropping a seat from a match misreports whose
// turn it is and how many people are playing, which is worse than dropping the
// match. The LIST is still parsed per match (see `parseRows` in the SDK), so
// one broken match hides itself rather than the whole screen.
export const MatchSummarySchema = z.object({
  matchUuid: z.string().uuid(),
  game: MatchGame,
  status: MatchStatusSchema,
  // Bumps on every server-side state write. Echoed back in `matches.move` so
  // the server can refuse a move made against a position the player no longer
  // sees. Also the cheapest "has anything changed" test for a poll.
  version: z.number().int().nonnegative(),
  maxPlayers: z.number().int().min(MATCH_MIN_PLAYERS).max(MATCH_MAX_PLAYERS),
  players: z.array(MatchPlayerSchema),
  // Seat on turn while `active`; null in every other status.
  turnSeat: MatchSeat.nullable().default(null),
  // ISO datetime after which the seat on turn is skipped or forfeited.
  turnDeadline: z.string().nullable().default(null),
  // ISO datetime the current turn began; null unless `active`. What a client
  // measures `matches.nudge` (1 day) and `matches.claim` (14 days) against,
  // so it can offer those only when the server would accept them. Defaulted
  // so a view from a host that predates the field still parses.
  turnStartedAt: z.string().nullable().default(null),
  // Set when `finished`. Null with `finished` means a draw.
  winnerSeat: MatchSeat.nullable().default(null),
  mySeat: MatchSeat,
  isMyTurn: z.boolean().default(false),
  updatedAt: z.string(),
});

export type MatchSummary = z.infer<typeof MatchSummarySchema>;

// One move as recorded in the match log, echoed on a view so the client can
// animate what just happened without diffing two boards.
export const MatchLastMoveSchema = z.object({
  ply: z.number().int().nonnegative(),
  seat: MatchSeat,
  move: z.record(z.unknown()),
  scoreDelta: z.number().int().default(0),
});

export type MatchLastMove = z.infer<typeof MatchLastMoveSchema>;

// The full per-viewer picture of one match. `view` has ALREADY been filtered
// for the requesting seat by the server's rules class: it is the only game
// state that ever crosses the bridge, and a client cannot ask for more.
export const MatchViewSchema = MatchSummarySchema.extend({
  // Only while `lobby`, and only to participants (it is how they invite the
  // fourth). Cleared once the match starts.
  joinCode: JoinCode.nullable().default(null),
  view: z.record(z.unknown()),
  lastMove: MatchLastMoveSchema.nullable().default(null),
});

export type MatchView = z.infer<typeof MatchViewSchema>;

// Result of `matches.nudge`: when the reminder went out. The sender's next
// nudge for this match is accepted a day after it.
export const MatchNudgeResultSchema = z.object({
  nudgedAt: z.string().datetime(),
});

export type MatchNudgeResult = z.infer<typeof MatchNudgeResultSchema>;

// Result of `time.now`. The SDK turns it into an offset against Date.now().
export const ServerTimeSchema = z.object({
  serverTime: z.string().datetime(),
});

export type ServerTime = z.infer<typeof ServerTimeSchema>;

// One pending reminder. `fireAt` is what the game asked for; `deliverAt` is
// kept for compatibility and equals it (there are no quiet hours).
export const ScheduledNotificationSchema = z.object({
  key: z.string().regex(NOTIFICATION_KEY_PATTERN),
  fireAt: z.string().datetime(),
  deliverAt: z.string().datetime(),
});

export type ScheduledNotification = z.infer<typeof ScheduledNotificationSchema>;

// Result of `notifications.schedule`.
export const NotificationScheduleResultSchema = ScheduledNotificationSchema.extend({
  serverTime: z.string().datetime(),
});

export type NotificationScheduleResult = z.infer<typeof NotificationScheduleResultSchema>;

// Result of `notifications.cancel`. `cancelled: false` means nothing was
// pending under that key, which is not an error.
export const NotificationCancelResultSchema = z.object({
  key: z.string().regex(NOTIFICATION_KEY_PATTERN),
  cancelled: z.boolean(),
});

// Result of `notifications.status`.
export const NotificationStatusSchema = z.object({
  push: z.boolean(),
});

export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

// Result of `notifications.list`: this app's pending reminders for the viewer,
// soonest first. Rows are parsed one at a time by the SDK.
export const NotificationListSchema = z.object({
  pending: z.array(z.unknown()),
  serverTime: z.string().datetime(),
});

// One friend's snapshot (`showcase.friends`, `showcase.get`). The identity
// triple matches every other row; `data` is whatever the game published.
export const ShowcaseSchema = z.object({
  uuid: z.string().uuid(),
  username: z.string().min(1).max(64),
  avatar: z.string().url().nullable().default(null),
  data: z.record(z.unknown()),
  updatedAt: z.string().datetime(),
});

export type Showcase = z.infer<typeof ShowcaseSchema>;

// Result of `showcase.publish`.
export const ShowcasePublishResultSchema = z.object({
  updatedAt: z.string().datetime(),
});

export type ShowcasePublishResult = z.infer<typeof ShowcasePublishResultSchema>;

// Result of `gifts.send`.
export const GiftSendResultSchema = z.object({
  giftUuid: z.string().uuid(),
  sentAt: z.string().datetime(),
});

export type GiftSendResult = z.infer<typeof GiftSendResultSchema>;

// One unclaimed gift in the viewer's inbox (`gifts.inbox`), newest first.
export const GiftSchema = z.object({
  giftUuid: z.string().uuid(),
  from: z.object({
    uuid: z.string().uuid(),
    username: z.string().min(1).max(64),
    avatar: z.string().url().nullable().default(null),
  }),
  kind: z.string().regex(GIFT_KIND_PATTERN),
  message: z.string().max(GIFT_MESSAGE_MAX).nullable().default(null),
  sentAt: z.string().datetime(),
  // Whether the sender's email is verified: the server's say on whether this
  // gift may earn the recipient anything. The game decides what to do with
  // it. `.default(true)` so rows from hosts that predate the field still count.
  counts: z.boolean().default(true),
});

export type Gift = z.infer<typeof GiftSchema>;

// Result of `gifts.claim`. The game pays out `kind` on its own.
export const GiftClaimResultSchema = z.object({
  giftUuid: z.string().uuid(),
  kind: z.string().regex(GIFT_KIND_PATTERN),
  claimedAt: z.string().datetime(),
});

export type GiftClaimResult = z.infer<typeof GiftClaimResultSchema>;

// Result of `visits.record`.
export const VisitRecordResultSchema = z.object({
  visitUuid: z.string().uuid(),
  visitedAt: z.string().datetime(),
});

export type VisitRecordResult = z.infer<typeof VisitRecordResultSchema>;

// One visit to the viewer (`visits.inbox`): last 7 days, newest first, seen
// and unseen. `showcase` is the visitor's snapshot for this app as it is NOW
// (null if they never published), so the game can draw the guest without a
// second call; validate it like any `showcase.get` data.
export const VisitSchema = z.object({
  visitUuid: z.string().uuid(),
  kind: z.string().regex(GIFT_KIND_PATTERN),
  visitedAt: z.string().datetime(),
  seenAt: z.string().datetime().nullable().default(null),
  from: z.object({
    uuid: z.string().uuid(),
    username: z.string().min(1).max(64),
    avatar: z.string().url().nullable().default(null),
  }),
  showcase: z.record(z.unknown()).nullable().default(null),
  // Whether the visitor's email is verified; same meaning as on `Gift`.
  counts: z.boolean().default(true),
});

export type Visit = z.infer<typeof VisitSchema>;

// Result of `visits.seen`. `seen` lists only the uuids THIS call moved from
// unseen to seen, so a game that pays out for exactly those pays once even
// when two devices open at the same time.
export const VisitSeenResultSchema = z.object({
  seen: z.array(z.string().uuid()),
  seenAt: z.string().datetime(),
});

export type VisitSeenResult = z.infer<typeof VisitSeenResultSchema>;

export const BridgeInitSchema = z.object({
  type: z.literal('init'),
  user: BridgeUserSchema.nullable(),
  sessionToken: z.string().nullable(),
  expiresAt: z.string().datetime().nullable(),
  // Optional so older outers (pre-theme rollout) still parse cleanly. SDK
  // consumers should treat missing as "unknown" and default their styling to
  // light. The host falls back to its own URL param when init omits it.
  colorScheme: AppColorSchemeSchema.optional(),
  // Optional deep-link hint forwarded verbatim from the outer launcher (e.g.
  // a push-notification tap). Shape is mini-app-specific — the SDK does not
  // interpret it. Zod default-strips unknown keys, so this field MUST be
  // declared here for it to survive validation and reach the mini-app.
  initialState: z.record(z.unknown()).optional(),
  // Bridge verbs this OUTER host actually implements, e.g. `['scores.top', …]`.
  //
  // Hosts move at different speeds: a verb can ship in the SDK bundle and in
  // the web host while the mobile app is still in App Store review, so
  // `typeof OddsRabbit.scores.top === 'function'` is NOT a usable capability
  // test — the method always exists, the host is what varies. Games should gate
  // optional UI on `OddsRabbit.capabilities.has(verb)` instead.
  //
  // Optional: hosts predating the handshake omit it, and the SDK falls back to
  // the pre-handshake baseline plus runtime detection (see sdk.ts).
  capabilities: z.array(z.string().min(1).max(64)).optional(),
});

export type BridgeInit = z.infer<typeof BridgeInitSchema>;

export const BridgeOutboundSchema = z.discriminatedUnion('type', [
  BridgeResponseSchema,
  BridgeLifecycleMessageSchema,
  BridgeInitSchema,
]);

export type BridgeOutbound = z.infer<typeof BridgeOutboundSchema>;
