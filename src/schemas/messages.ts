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
