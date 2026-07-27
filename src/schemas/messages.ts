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
