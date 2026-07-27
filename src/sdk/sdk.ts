import {
  FriendScoreSchema,
  TopScoreEntrySchema,
  ScoreDistributionEntrySchema,
  DailyContentSchema,
  type BridgeRequest,
  type BridgeUser,
  type AppColorScheme,
  type AppHapticType,
  type AppLifecycleEvent,
  type FriendScore,
  type TopScoreEntry,
  type ScoreDistributionEntry,
  type DailyContent,
} from '../schemas/messages';
import { BridgeTransport, type LifecycleHandler } from './transport';

export type { FriendScore, TopScoreEntry, ScoreDistributionEntry, DailyContent } from '../schemas/messages';

export interface ScoreSubmitPayload {
  roundKey: string;
  score: number;
  metadata?: Record<string, unknown>;
  /**
   * Opt into "keep the highest score" for a constant `roundKey` (all-time
   * boards, e.g. 2048): a resubmit updates the stored row only when this score
   * beats it, and never rejects as already-submitted. Omit (or false) for the
   * default one-submission-per-round behaviour.
   */
  keepBest?: boolean;
}

export interface TopScoresPayload {
  roundKey: string;
  /** Max rows to return, clamped server-side to 1..100 (default 20). */
  limit?: number;
  /** 'top' (default) ranks by score; 'first' ranks by earliest submission. */
  order?: 'top' | 'first';
}

/**
 * Bridge verbs that existed before the capability handshake. Used only when
 * `init` carries no `capabilities` array — an older outer host.
 *
 * Deliberately optimistic: it lists verbs SOME pre-handshake host implements,
 * not verbs all of them do. `scores.top` (missing from old mobile builds) and
 * `actions.requestSignIn` (missing from mobile entirely) are both in here even
 * though we know a host that lacks them exists. Erring the other way would deny
 * working features on the web host, where these have always worked, and there
 * is no way to tell the two apart before asking. The runtime detection below
 * corrects the guess on first use without needing any host cooperation — so the
 * cost of a wrong entry is one rejected call, while the cost of a wrong
 * omission is a feature that never appears on a host that supports it.
 */
const LEGACY_CAPABILITIES: readonly string[] = [
  'storage.get',
  'storage.set',
  'storage.delete',
  'scores.submit',
  'scores.friends',
  'scores.distribution',
  'scores.top',
  'content.daily',
  'actions.share',
  'actions.haptic',
  'actions.requestSignIn',
  'session.refresh',
  'ready',
];

/**
 * Error codes meaning "this host does not implement that verb". One per host,
 * because each names it differently: the mobile host's switch default
 * (`bridge/unknown-action`, AppHost.tsx), the web host's
 * (`bridge/unknown-type`, games.js), and the sandbox host rejecting a request
 * its schema doesn't recognise (`bridge/unsupported-request`, host.ts).
 *
 * Membership here is CACHED and permanent for the session — a verb that answers
 * with one of these is retired and `capabilities.has()` reports it false from
 * then on. So only codes that describe the HOST belong here. A code describing
 * one bad call (`bridge/invalid-request`, a payload that failed validation for
 * a verb the host does implement) must stay out: it's the caller's bug and the
 * next call can succeed. Caching it would mean one non-integer score retires
 * `scores.submit` for the session, silently ending score recording.
 */
const UNSUPPORTED_CODES = [
  'bridge/unknown-action',
  'bridge/unknown-type',
  'bridge/unsupported-request',
];

function isUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && UNSUPPORTED_CODES.includes(code);
}

/**
 * Parse a server row list one row at a time, keeping the rows that validate.
 * Deliberately NOT `Schema.array().safeParse(result)`: array-level validation is
 * all-or-nothing, so a single malformed row (missing username, a relative avatar
 * URL) empties the whole board instead of dropping itself.
 */
function parseRows<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  result: unknown
): T[] {
  if (!Array.isArray(result)) return [];
  const rows: T[] = [];
  for (const row of result) {
    const parsed = schema.safeParse(row);
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
}

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
    /**
     * Fetch the global top-N leaderboard for a round — all players, not just the
     * people the viewer follows. Public (works signed-out). `order: 'top'`
     * (default) ranks by score DESC; `order: 'first'` ranks by earliest
     * submission (a "who did it first" hall-of-fame). Returns an empty array when
     * nobody has played or on a malformed response. Rows carry no `isSelf`; match
     * `uuid` against `OddsRabbit.user` to highlight the viewer.
     */
    top(payload: TopScoresPayload): Promise<TopScoreEntry[]>;
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

  /**
   * What the CURRENT outer host can do. Gate optional UI on this rather than on
   * the presence of an SDK method: every method exists in every SDK build, but
   * the web host, the mobile app, and the dev sandbox each implement a different
   * subset, and mobile lags by App Store review.
   *
   * READ THIS ONLY INSIDE `whenReady()`. Answers come from `init.capabilities`,
   * which arrives by postMessage — so a `has()` call at script-eval time runs
   * before any host has spoken and silently gets the pre-handshake baseline
   * below, not this host's real answer. A `<script>` gate that skips
   * `whenReady()` is therefore always answered by `LEGACY_CAPABILITIES`, which
   * is exactly the wrong answer on the newer hosts the handshake exists for.
   *
   *     await OddsRabbit.whenReady();
   *     if (OddsRabbit.capabilities.has('scores.top')) showLeaderboardButton();
   *
   * Older hosts declare nothing, so the SDK assumes a pre-handshake baseline and
   * then narrows it at runtime: any verb the host rejects as unknown is
   * remembered as unsupported, so a `has()` call after a failed attempt tells
   * the truth.
   */
  readonly capabilities: {
    has(verb: string): boolean;
    all(): string[];
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
  /** Host-declared verbs, or null when this host predates the handshake. */
  private hostCapabilities: Set<string> | null = null;
  /** Verbs this host has actually rejected as unknown. Always authoritative. */
  private readonly unsupportedVerbs = new Set<string>();

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
      this.hostCapabilities = init.capabilities
        ? new Set(init.capabilities)
        : null;
      this.resolveInit?.();
    });
  }

  /**
   * `transport.request` plus capability bookkeeping: a verb the host rejects as
   * unknown is remembered, so `capabilities.has()` reports it correctly from
   * then on even when `init` declared nothing.
   */
  private request<T = unknown>(
    type: BridgeRequest['type'],
    payload?: unknown
  ): Promise<T> {
    return this.transport.request<T>(type, payload).catch((error: unknown) => {
      if (isUnsupportedError(error)) this.unsupportedVerbs.add(type);
      throw error;
    });
  }

  /**
   * Read helper for the list-returning score verbs: an unsupported host yields
   * an empty board rather than a rejection, so a game running on a host that
   * predates the verb degrades to "no scores yet" instead of an error state.
   * Every other failure still rejects.
   */
  private requestRows<T>(
    type: BridgeRequest['type'],
    payload: unknown,
    schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }
  ): Promise<T[]> {
    return this.request<unknown>(type, payload)
      .then((result) => parseRows<T>(schema, result))
      .catch((error: unknown) => {
        if (isUnsupportedError(error)) return [];
        throw error;
      });
  }

  readonly capabilities = {
    has: (verb: string): boolean => {
      if (this.unsupportedVerbs.has(verb)) return false;
      return this.hostCapabilities
        ? this.hostCapabilities.has(verb)
        : LEGACY_CAPABILITIES.includes(verb);
    },
    all: (): string[] => {
      const declared = this.hostCapabilities
        ? [...this.hostCapabilities]
        : [...LEGACY_CAPABILITIES];
      return declared.filter((verb) => !this.unsupportedVerbs.has(verb));
    },
  };

  readonly storage = {
    get: (key: string): Promise<string | null> =>
      this.request<string | null>('storage.get', { key }).then(
        (value) => (value as string | null) ?? null
      ),
    set: (key: string, value: string): Promise<void> =>
      this.request<void>('storage.set', { key, value }),
    delete: (key: string): Promise<void> =>
      this.request<void>('storage.delete', { key }),
  };

  readonly scores = {
    // Writes reject on failure — a game may need to know its score didn't land.
    submit: (payload: ScoreSubmitPayload): Promise<void> =>
      this.request<void>('scores.submit', payload),
    // Reads validate inbound entries — a malformed server response (missing
    // username, wrong types) would otherwise crash the renderer. Drops
    // bad rows silently rather than failing the whole list (see parseRows).
    friends: (payload: { roundKey: string }): Promise<FriendScore[]> =>
      this.requestRows<FriendScore>('scores.friends', payload, FriendScoreSchema),
    distribution: (payload: {
      roundKey: string;
    }): Promise<ScoreDistributionEntry[]> =>
      this.requestRows<ScoreDistributionEntry>(
        'scores.distribution',
        payload,
        ScoreDistributionEntrySchema
      ),
    top: (payload: TopScoresPayload): Promise<TopScoreEntry[]> =>
      this.requestRows<TopScoreEntry>('scores.top', payload, TopScoreEntrySchema),
  };

  readonly content = {
    // Validate the inbound shape — a missing/old host handler or a malformed
    // response resolves to null so the app falls back to bundled content rather
    // than rendering a broken board. A host that drops the message silently
    // (no response at all — the transport has no global timeout) would hang the
    // promise forever; since this sits on the fresh-game boot path, race it
    // against a timeout so boot can always fall back to bundled content.
    daily: (payload: { roundKey: string }): Promise<DailyContent | null> => {
      const fetched = this
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
      this.request<void>('actions.share', payload ?? {}),
    haptic: (type: AppHapticType): Promise<void> =>
      this.request<void>('actions.haptic', { type }),
    requestSignIn: (reason?: string): Promise<void> => {
      if (this.user) return Promise.resolve();
      return this.request<void>(
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
    // Through `this.request`, not the transport, so `ready` is subject to the
    // same capability bookkeeping as every other verb — otherwise it's the one
    // verb whose rejection never narrows `capabilities`.
    this.request('ready').catch(() => {
      // Best-effort signal; ignore failures.
    });
  }

  whenReady(): Promise<void> {
    return this.initPromise;
  }
}

export { OddsRabbitSDK };
