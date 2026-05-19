import {
  FriendScoreSchema,
  type BridgeUser,
  type AppColorScheme,
  type AppHapticType,
  type AppLifecycleEvent,
  type FriendScore,
} from '../schemas/messages';
import { BridgeTransport, type LifecycleHandler } from './transport';

export type { FriendScore } from '../schemas/messages';

export interface ScoreSubmitPayload {
  roundKey: string;
  score: number;
  metadata?: Record<string, unknown>;
}

const FriendScoresArraySchema = FriendScoreSchema.array();

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

  readonly storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };

  readonly aggregate: {
    /**
     * Register the calling user into `value` for `key` and return the
     * post-write count of distinct users in that bucket. Returns `null`
     * below the k=5 anonymity floor. Use this exactly once per round for
     * the bucket the player landed in — calling it across neighboring
     * buckets to "fetch the distribution" registers the user into all of
     * them. For read-only access to other buckets, use `read`.
     */
    count(key: string, value: string): Promise<number | null>;
    /**
     * Read-only counterpart to `count`. Same k=5 anonymity floor; does
     * not modify the caller's bucket membership. Safe to call across all
     * buckets to render a community distribution.
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
