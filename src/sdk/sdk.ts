import {
  FriendScoreSchema,
  ScoreDistributionEntrySchema,
  DailyContentSchema,
  type BridgeUser,
  type AppColorScheme,
  type AppHapticType,
  type AppLifecycleEvent,
  type FriendScore,
  type ScoreDistributionEntry,
  type DailyContent,
} from '../schemas/messages';
import { BridgeTransport, type LifecycleHandler } from './transport';

export type { FriendScore, ScoreDistributionEntry, DailyContent } from '../schemas/messages';

export interface ScoreSubmitPayload {
  roundKey: string;
  score: number;
  metadata?: Record<string, unknown>;
}

const FriendScoresArraySchema = FriendScoreSchema.array();
const ScoreDistributionArraySchema = ScoreDistributionEntrySchema.array();

// Boot-path cap for content.daily: if the host never answers (silent drop of an
// unknown message type — the transport has no global timeout), resolve null so
// the app can fall back to bundled content instead of hanging.
const CONTENT_DAILY_TIMEOUT_MS = 4000;

export interface OddsRabbitGlobal {
  readonly user: BridgeUser | null;
  readonly sessionToken: string | null;
  readonly expiresAt: string | null;
  /**
   * The user's current color scheme on the host site. `null` only on older
   * hosts that predate the theme rollout — treat null as "unknown, default to
   * light". Static for the lifetime of the iframe; theme changes trigger a
   * full reload (and a fresh init).
   */
  readonly colorScheme: AppColorScheme | null;
  /**
   * Optional deep-link hint passed by the outer launcher (e.g. a push-
   * notification tap on mobile). Shape is mini-app-specific; the SDK
   * forwards it verbatim. `null` when the app was opened normally (games
   * list, deep link with no hint).
   *
   * Static for the iframe lifetime — set once on init, never updated. If the
   * outer wants to express a new intent (e.g. user taps another notification),
   * it tears down and remounts the iframe with a fresh init.
   *
   * Convention: read it inside the `whenReady()` continuation so it's safe
   * to call as soon as the SDK is ready. Validate the shape defensively;
   * untrusted callers can put any JSON object here.
   */
  readonly initialState: Record<string, unknown> | null;

  readonly storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };

  readonly aggregate: {
    /**
     * Register the calling user into `value` for `key` and return the
     * post-write count of distinct users in that bucket. Use this exactly
     * once per round for the bucket the player landed in — calling it
     * across neighboring buckets to "fetch the distribution" would
     * register the user into all of them. For read-only access to other
     * buckets, use `read`. Returns `null` on transport / authorization
     * failure; the count itself is never `null` for a successful write.
     */
    count(key: string, value: string): Promise<number | null>;
    /**
     * Read-only counterpart to `count` — does not modify the caller's
     * bucket membership, so it's safe to call across all buckets to
     * render a community distribution. Returns `null` when the bucket
     * has no recorded value yet (e.g. an unplayed puzzle), or on
     * transport failure.
     */
    read(key: string, value: string): Promise<number | null>;
  };

  readonly scores: {
    /**
     * Submit this user's score for a round. One submission per
     * (app, roundKey, user) — second attempts reject with code
     * `scores/already-submitted`. Pick a `roundKey` that's stable across
     * the round (e.g. a UTC day index, a week number).
     */
    submit(payload: ScoreSubmitPayload): Promise<void>;
    /**
     * Fetch scores for the people the current user follows, for a given
     * round. Returns an empty array when the user follows nobody or
     * nobody they follow has played. Server-side sort: score DESC, then
     * earliest submission. Does not include the viewer's own score.
     */
    friends(payload: { roundKey: string }): Promise<FriendScore[]>;
    /**
     * Fetch the community score histogram for a round, computed server-side
     * from the scores table. Returns one entry per distinct score value
     * (`{ score, count }`), or an empty array when nobody has played the round.
     * Public — works for signed-out viewers. The app maps `score` back to its
     * own buckets. Because it reads the same rows `submit` writes, it can never
     * disagree with the recorded results.
     */
    distribution(payload: { roundKey: string }): Promise<ScoreDistributionEntry[]>;
  };

  readonly content: {
    /**
     * Fetch the server-authored content for a round (e.g. today's puzzle or
     * answer). Public — works for signed-out viewers, since content isn't
     * user-scoped. The server date-gates by round: a round whose `available_at`
     * is still in the future resolves to `null`, so the client can never read a
     * future answer. Also resolves `null` on transport failure or an
     * unrecognized shape — callers should fall back to bundled content.
     *
     * The returned `content` is opaque and app-specific; validate its fields
     * before use.
     */
    daily(payload: { roundKey: string }): Promise<DailyContent | null>;
  };

  readonly actions: {
    share(payload?: { title?: string; text?: string }): Promise<void>;
    haptic(type: AppHapticType): Promise<void>;
    /**
     * Prompt the user to sign in. Resolves once the host has shown the prompt
     * (or immediately if the user is already signed in). Sign-in completion is
     * observed via `OddsRabbit.user` after the host reloads the game on auth
     * success — a single round-trip Promise can't model that flow.
     *
     * Use at natural friction moments (end-of-round, hi-score, share), not at
     * boot. `reason` is shown to the user in the prompt; keep it short.
     */
    requestSignIn(reason?: string): Promise<void>;
  };

  readonly lifecycle: {
    on(event: AppLifecycleEvent, handler: LifecycleHandler): () => void;
  };

  ready(): void;

  whenReady(): Promise<void>;
}

class OddsRabbitSDK implements OddsRabbitGlobal {
  user: BridgeUser | null = null;
  sessionToken: string | null = null;
  expiresAt: string | null = null;
  colorScheme: AppColorScheme | null = null;
  initialState: Record<string, unknown> | null = null;

  private readonly transport: BridgeTransport;
  private readonly initPromise: Promise<void>;
  private resolveInit: (() => void) | null = null;

  constructor(transport: BridgeTransport = new BridgeTransport()) {
    this.transport = transport;
    this.initPromise = new Promise((resolve) => {
      this.resolveInit = resolve;
    });
    transport.onInit((init) => {
      this.user = init.user;
      this.sessionToken = init.sessionToken;
      this.expiresAt = init.expiresAt;
      this.colorScheme = init.colorScheme ?? null;
      this.initialState = init.initialState ?? null;
      this.resolveInit?.();
    });
  }

  readonly storage = {
    get: (key: string): Promise<string | null> =>
      this.transport
        .request<string | null>('storage.get', { key })
        .then((value) => (value as string | null) ?? null),
    set: (key: string, value: string): Promise<void> =>
      this.transport.request<void>('storage.set', { key, value }),
    delete: (key: string): Promise<void> =>
      this.transport.request<void>('storage.delete', { key }),
  };

  readonly aggregate = {
    count: (key: string, value: string): Promise<number | null> =>
      this.transport
        .request<number | null>('aggregate.count', { key, value })
        .then((count) => (count as number | null) ?? null),
    read: (key: string, value: string): Promise<number | null> =>
      this.transport
        .request<number | null>('aggregate.read', { key, value })
        .then((count) => (count as number | null) ?? null),
  };

  readonly scores = {
    submit: (payload: ScoreSubmitPayload): Promise<void> =>
      this.transport.request<void>('scores.submit', payload),
    // Validate inbound entries — a malformed server response (missing
    // username, wrong types) would otherwise crash the renderer. Drops
    // bad rows silently rather than failing the whole list.
    friends: (payload: { roundKey: string }): Promise<FriendScore[]> =>
      this.transport
        .request<unknown>('scores.friends', payload)
        .then((result) => {
          const parsed = FriendScoresArraySchema.safeParse(result);
          return parsed.success ? parsed.data : [];
        }),
    distribution: (payload: {
      roundKey: string;
    }): Promise<ScoreDistributionEntry[]> =>
      this.transport
        .request<unknown>('scores.distribution', payload)
        .then((result) => {
          const parsed = ScoreDistributionArraySchema.safeParse(result);
          return parsed.success ? parsed.data : [];
        }),
  };

  readonly content = {
    // Validate the inbound shape — a missing/old host handler or a malformed
    // response resolves to null so the app falls back to bundled content rather
    // than rendering a broken board. A host that drops the message silently
    // (no response at all — the transport has no global timeout) would hang the
    // promise forever; since this sits on the fresh-game boot path, race it
    // against a timeout so boot can always fall back to bundled content.
    daily: (payload: { roundKey: string }): Promise<DailyContent | null> => {
      const fetched = this.transport
        .request<unknown>('content.daily', payload)
        .then((result) => {
          const parsed = DailyContentSchema.safeParse(result);
          return parsed.success ? parsed.data : null;
        })
        .catch(() => null);
      const timeout = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), CONTENT_DAILY_TIMEOUT_MS);
      });
      return Promise.race([fetched, timeout]);
    },
  };

  readonly actions = {
    share: (payload?: { title?: string; text?: string }): Promise<void> =>
      this.transport.request<void>('actions.share', payload ?? {}),
    haptic: (type: AppHapticType): Promise<void> =>
      this.transport.request<void>('actions.haptic', { type }),
    requestSignIn: (reason?: string): Promise<void> => {
      if (this.user) return Promise.resolve();
      return this.transport.request<void>(
        'actions.requestSignIn',
        reason ? { reason } : undefined
      );
    },
  };

  readonly lifecycle = {
    on: (
      event: AppLifecycleEvent,
      handler: LifecycleHandler
    ): (() => void) => this.transport.onLifecycle(event, handler),
  };

  ready(): void {
    this.transport.request('ready').catch(() => {
      // Best-effort signal; ignore failures.
    });
  }

  whenReady(): Promise<void> {
    return this.initPromise;
  }
}

export { OddsRabbitSDK };
