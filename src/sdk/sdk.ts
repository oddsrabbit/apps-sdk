import {
  FriendScoreSchema,
  TopScoreEntrySchema,
  ScoreDistributionEntrySchema,
  DailyContentSchema,
  SeasonBoardEnvelopeSchema,
  SeasonEntrySchema,
  RoundRankSchema,
  SeasonRankSchema,
  MatchViewSchema,
  MatchSummarySchema,
  MatchNudgeResultSchema,
  InvitablePlayerSchema,
  ServerTimeSchema,
  ScheduledNotificationSchema,
  NotificationScheduleResultSchema,
  NotificationCancelResultSchema,
  NotificationListSchema,
  NotificationStatusSchema,
  ShowcaseSchema,
  ShowcasePublishResultSchema,
  GiftSchema,
  GiftSendResultSchema,
  GiftClaimResultSchema,
  VisitSchema,
  VisitRecordResultSchema,
  VisitSeenResultSchema,
  type Visit,
  type VisitRecordResult,
  type VisitSeenResult,
  type Showcase,
  type ShowcasePublishResult,
  type Gift,
  type GiftSendResult,
  type GiftClaimResult,
  type NotificationStatus,
  type ScheduledNotification,
  type NotificationScheduleResult,
  type MatchView,
  type MatchSummary,
  type MatchNudgeResult,
  type MatchListFilter,
  type InvitablePlayer,
  type SeasonBoard,
  type SeasonEntry,
  type SeasonMetric,
  type RoundRank,
  type SeasonRank,
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

export type {
  FriendScore,
  TopScoreEntry,
  ScoreDistributionEntry,
  DailyContent,
  SeasonBoard,
  SeasonEntry,
  SeasonMetric,
  RoundRank,
  SeasonRank,
  MatchView,
  MatchSummary,
  MatchPlayer,
  MatchLastMove,
  MatchStatus,
  MatchPlayerStatus,
  MatchListFilter,
  MatchNudgeResult,
  InvitablePlayer,
  ScheduledNotification,
  NotificationScheduleResult,
  NotificationStatus,
  Showcase,
  ShowcasePublishResult,
  Gift,
  GiftSendResult,
  GiftClaimResult,
  Visit,
  VisitRecordResult,
  VisitSeenResult,
} from '../schemas/messages';

export {
  MATCH_ERROR_CODES,
  NOTIFICATION_ERROR_CODES,
  SOCIAL_ERROR_CODES,
  GIFT_ERROR_CODES,
  VISIT_ERROR_CODES,
} from '../schemas/messages';

export interface GiftSendPayload {
  /** Who gets it. Must follow the viewer or be followed by them. */
  toUserUuid: string;
  /** The game's word for the gift, `[a-z0-9-]{1,32}`, e.g. `'clover'`. */
  kind: string;
  /** Optional note, one line, up to 80 characters. */
  message?: string;
}

export interface VisitRecordPayload {
  /** Whose home was visited. Must follow the viewer or be followed by them. */
  toUserUuid: string;
  /**
   * The game's word for what the visitor did, `[a-z0-9-]{1,32}`, e.g.
   * `'snack'`. Picks the push line from the manifest's `social.visitLines`.
   */
  kind: string;
}

export interface NotificationSchedulePayload {
  /** The game's name for this reminder, e.g. `'nap-done'`. Reusing a key replaces it. */
  key: string;
  /** When you'd like it delivered: a Date, epoch ms, or ISO string. */
  fireAt: Date | number | string;
  /** Up to 64 characters, one line. */
  title: string;
  /** Up to 160 characters. */
  body: string;
}

export interface MatchCreatePayload {
  /** Rules-class id, e.g. `'connect4'`. Must be one the server knows for this app. */
  game: string;
  /** 2..4. */
  maxPlayers: number;
  /**
   * Player UUIDs to invite. Each must be connected to the creator on the
   * follow graph in either direction, or the whole create rejects with
   * `match/not-connected`. At most `maxPlayers - 1`.
   */
  invitees?: string[];
  /** Mint a join code for any seats invitees do not fill. */
  open?: boolean;
}

export type MatchJoinPayload = { matchUuid: string } | { joinCode: string };

export interface MatchListPayload {
  /** `'active'` (default) is lobby + active; `'all'` adds finished and abandoned. */
  status?: MatchListFilter;
  /** Max rows, clamped server-side to 1..100 (default 20). */
  limit?: number;
}

export interface MatchMovePayload {
  matchUuid: string;
  /** The `version` of the view this move was decided on. */
  version: number;
  /** Game-specific action, e.g. `{ col: 3 }`. Never a board. Capped at 2 KB. */
  move: Record<string, unknown>;
}

export interface MatchWatchOptions {
  /** Poll interval while the page is visible. Default 5000 ms, floor 1000. */
  intervalMs?: number;
  /**
   * Called when a poll rejects. Polling continues — a transient failure on
   * one tick is not a reason to stop watching — unless the host reports the
   * verb unsupported, in which case the watch stops on its own.
   */
  onError?: (error: unknown) => void;
}

export interface RankPayload {
  roundKey: string;
  /**
   * Must match the board this rank annotates. A rank computed under `top` (by
   * score) describes a different ordering than a `first` hall-of-fame board, and
   * pinning one under the other points at the wrong row.
   */
  order?: 'top' | 'first';
}

export interface SeasonRankPayload {
  /** Calendar month, `YYYY-MM`, in UTC. See `currentPeriod()` in the UI package. */
  period: string;
  /** Override the app's configured aggregation. Match the board's. */
  metric?: SeasonMetric;
}

export interface SeasonPayload {
  /** Calendar month, `YYYY-MM`, in UTC. See `currentPeriod()` in the UI package. */
  period: string;
  /** Override the app's configured aggregation. */
  metric?: SeasonMetric;
  /** Max rows, clamped server-side to 1..100 (default 20). */
  limit?: number;
}

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
  // `matches.*` are deliberately absent: no pre-handshake host has them, and
  // this list is a historical snapshot, not a mirror of the schema.
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
 *
 * The same goes for every `match/*` code (`MATCH_ERROR_CODES`): a rejected
 * move, a stale version, a full table are outcomes of one call in a working
 * match system, and caching any of them would end multiplayer for the session
 * on the first illegal move. `notifications/*`, `social/*`, `gifts/*` and
 * `visits/*` codes (`NOTIFICATION_ERROR_CODES`, `SOCIAL_ERROR_CODES`,
 * `GIFT_ERROR_CODES`, `VISIT_ERROR_CODES`) stay out for the same reason.
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

/** Default `matches.watch` poll interval. Turn-based; nobody is waiting on a frame. */
const MATCH_WATCH_INTERVAL_MS = 5000;

/**
 * How long a server-clock offset is trusted before `time.now` asks again. The
 * offset is also dropped whenever the page comes back from hidden or the host
 * resumes it: a phone that slept for hours may have had its clock changed.
 */
const TIME_OFFSET_TTL_MS = 10 * 60 * 1000;
/** A round trip slower than this gives an offset too loose to cache. */
const TIME_MAX_RTT_MS = 5000;
/** After a failed `time.now`, fall back to Date.now() for this long before asking again. */
const TIME_RETRY_MS = 60 * 1000;

/** The device's IANA zone, or undefined where Intl cannot say. */
function deviceTimeZone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz.length > 0 && tz.length <= 64 ? tz : undefined;
  } catch {
    return undefined;
  }
}

function toIso(when: Date | number | string): string {
  const date = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('notifications.schedule: fireAt is not a valid date');
  }
  return date.toISOString();
}

/** True only when there is a document and it is hidden. Node (tests) has neither. */
function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export interface OddsRabbitGlobal {
  /**
   * The signed-in user, or null for a guest. `supporter` is true when they
   * hold the platform Supporter tier (false on hosts that predate it).
   */
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
    /**
     * Fetch the season board — every player's daily rows across one calendar
     * month, aggregated into a single ranked number. Public (works signed-out).
     *
     * The point of a season board is that a daily game's global board wipes at
     * midnight: nothing a player did yesterday counts, which is a strange
     * reward for a game whose whole design is coming back tomorrow. A month
     * accumulates.
     *
     * `period` is `YYYY-MM`. `metric` defaults to whatever the app is
     * configured for server-side — pass it only to override. The result carries
     * `puzzleDays` and `qualifyingDays` so the UI can state the rule it's
     * ranking by without re-deriving it.
     *
     * Resolves `null` — not `[]` — when the host doesn't implement the verb, so
     * a game can tell "no season board here" apart from "the season board is
     * empty" and hide the tab rather than showing an empty one. A malformed
     * envelope REJECTS instead, so a server-side break surfaces as an error
     * rather than as a month nobody played. Individual malformed entries are
     * still dropped rather than fatal, as with the other reads.
     */
    season(payload: SeasonPayload): Promise<SeasonBoard | null>;
    /**
     * The viewer's own row and true rank in a round, for the pinned
     * `…  #412 @you` line under a top-N board.
     *
     * Resolves `null` for all three of "this host has no rank verb", "nobody is
     * signed in", and "the viewer hasn't played this round" — a caller only ever
     * does one thing with those, which is not draw a pinned row. A malformed
     * response REJECTS, as elsewhere.
     *
     * Pass the same `order` as the board. Prefer handing this to the shared
     * panel's `loadPinned` hook rather than racing it against the board's own
     * fetch: a rejection there is contained to the pinned row, whereas a
     * `Promise.all` with the board turns a rank failure into a dead board.
     */
    rank(payload: RankPayload): Promise<RoundRank | null>;
    /**
     * The same for a season board, and the one that matters: a daily board's
     * viewer has just played and knows their score, but nobody can compute their
     * own monthly standing, so a season board with no self row tells a player
     * outside the top N nothing about themselves.
     *
     * Resolves `null` on an unsupported host or a signed-out viewer. A viewer
     * who played no day this month resolves to an object with `rank`/`entry`
     * null but `period`/`metric`/`puzzleDays`/`qualifyingDays` populated, so the
     * caller can still state the qualifier they'd need to meet.
     */
    seasonRank(payload: SeasonRankPayload): Promise<SeasonRank | null>;
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

  /**
   * Async turn-based multiplayer. See docs/proposals/multiplayer-matches.md.
   *
   * Every verb is authenticated and every read is PER-VIEWER: the server
   * filters `view` to what the requesting seat may see, so a game reads
   * `view`, never raw state, and a client can never hold an opponent's rack.
   * Moves are actions applied server-side, never boards.
   *
   * Gate the whole multiplayer entry point on
   * `capabilities.has('matches.get')` and render nothing without it: the
   * mobile host ships these behind App Store review, and a button that always
   * fails is worse than no button.
   *
   * Writes and single-match reads REJECT on failure with a `match/*` code
   * (`MATCH_ERROR_CODES`) — a game has to know a move did not land. Only
   * `list` degrades, to `[]`, since an empty list is what an unsupported host
   * or a signed-out viewer should see.
   */
  readonly matches: {
    /**
     * Start a match. Resolves the new match's view: `lobby` while seats are
     * empty, or straight to `active` when invitees fill the table and the game
     * needs no accept step. The creator always holds seat 0.
     */
    create(payload: MatchCreatePayload): Promise<MatchView>;
    /** Take a seat, by invitation (`matchUuid`) or by join code. */
    join(payload: MatchJoinPayload): Promise<MatchView>;
    /**
     * The viewer's matches, newest activity first. `[]` when signed out (no
     * round trip) or on a host without the verb. One malformed match drops
     * itself rather than the list.
     */
    list(payload?: MatchListPayload): Promise<MatchSummary[]>;
    /** One match, filtered for this viewer. Rejects `match/not-found` for non-participants. */
    get(payload: { matchUuid: string }): Promise<MatchView>;
    /**
     * Play a move. Rejects with `match/version-conflict` when `version` is
     * stale (refetch, re-render, let the player decide again),
     * `match/not-your-turn`, or `match/illegal-move` (the message says why).
     * Resolves the post-move view, already advanced to the next seat.
     */
    move(payload: MatchMovePayload): Promise<MatchView>;
    /** Leave the match. Ends a 2-player match; a larger table plays on without you. */
    resign(payload: { matchUuid: string }): Promise<MatchView>;
    /**
     * Push the seat on turn a reminder that it is their move. Only from a
     * waiting player (not the seat on turn), once the turn is a day old
     * (`turnStartedAt`), and at most once a day per sender per match.
     * Otherwise rejects `match/too-soon` with a message saying when
     * ("You can nudge again in 5 hours."). Changes nothing about the match,
     * so `version` does not move.
     *
     * Gate the button on `capabilities.has('matches.nudge')`.
     */
    nudge(payload: { matchUuid: string }): Promise<MatchNudgeResult>;
    /**
     * End a stalled turn. Once the seat on turn has not moved for 14 days
     * (`turnStartedAt`), a waiting player may claim it: with two players
     * left the match finishes scored as it stands (higher score wins, equal
     * scores draw, nobody is marked forfeited); with three or four the idle
     * seat is forfeited and the rest play on. Rejects `match/too-soon`
     * earlier, with a message saying when. Resolves the resulting view.
     *
     * Gate the button on `capabilities.has('matches.claim')`.
     */
    claim(payload: { matchUuid: string }): Promise<MatchView>;
    /**
     * People the viewer may invite — connected on the follow graph in either
     * direction, which is exactly the set `create` accepts. `[]` when signed
     * out or on a host without the verb; one malformed row drops itself.
     *
     * `limit` caps one page at 200; `offset` skips that many rows, so a client
     * with a follow graph larger than a page can fetch the rest instead of
     * searching a truncated list. A host that does not implement `offset`
     * answers with the first page again — page until a page is short or
     * returns no unseen uuids, never on a fixed count.
     */
    invitable(payload?: { limit?: number; offset?: number }): Promise<InvitablePlayer[]>;
    /**
     * Poll one match while the page is visible and the match is unfinished,
     * calling `onChange` with each view whose `version` moved (the first poll
     * always fires). Pauses on `lifecycle` pause and while the document is
     * hidden, resumes on the way back, and stops itself once the match is
     * `finished` or `abandoned` — after delivering that final view. Returns a
     * stop function.
     *
     * Turn-based play needs nothing faster than this, and it needs no host
     * work — which is the whole reason the platform has no socket channel.
     */
    watch(
      matchUuid: string,
      onChange: (view: MatchView) => void,
      options?: MatchWatchOptions
    ): () => void;
  };

  /**
   * The server's clock.
   */
  readonly time: {
    /**
     * Server time as epoch milliseconds. Use it instead of `Date.now()` for
     * anything that measures real elapsed time, because the device clock is
     * the player's to change.
     *
     * The first call makes one round trip and corrects for its latency; later
     * calls answer from a cached offset with no round trip. The offset is
     * refreshed after 10 minutes and whenever the page returns from the
     * background. Public, so it works signed out.
     *
     * Never rejects. On a host without the verb, or when the request fails,
     * it resolves `Date.now()`, so a game must still guard against a clock
     * that jumps (clamp negative or huge elapsed times). Check
     * `capabilities.has('time.now')` if you need to know which you got.
     */
    now(): Promise<number>;
  };

  /**
   * Reminders delivered later as a push on mobile and a notification in the
   * bell everywhere, e.g. "Clover is awake" when a nap timer ends.
   *
   * The platform, not the game, decides what goes out: pushes only when the
   * user has game pushes on, at most 5 pending per app. There are no quiet
   * hours, so a reminder goes out at `fireAt` whatever the local time. There is
   * no daily cap while every game is first-party, so each game has to keep
   * its own reminders rare. Write copy that stays true if it arrives late.
   *
   * Requires the `bridge:notifications` scope and a signed-in user. Gate the
   * UI on `capabilities.has('notifications.schedule')`: the mobile host ships
   * these behind App Store review.
   *
   * `schedule` and `cancel` REJECT with a `notifications/*` code
   * (`NOTIFICATION_ERROR_CODES`) on failure. `list` degrades to `[]`.
   */
  readonly notifications: {
    /**
     * Create or replace the reminder under `key`. Resolves with `deliverAt`,
     * which equals `fireAt` (there are no quiet hours).
     */
    schedule(payload: NotificationSchedulePayload): Promise<NotificationScheduleResult>;
    /** Cancel the pending reminder under `key`. Resolves false when none was pending. */
    cancel(key: string): Promise<boolean>;
    /**
     * This app's pending reminders for the viewer, soonest first. `[]` when
     * signed out (no round trip) or on a host without the verb.
     */
    list(): Promise<ScheduledNotification[]>;
    /**
     * Whether a reminder push would reach the viewer right now: their Games
     * and Game reminders settings are on and they have a phone to send to.
     * When `push` is false the reminder still lands in the bell, so offer
     * "we'll leave a note in your bell" rather than a nudge on their phone.
     *
     * Resolves `null` when it can't say: signed out, a host without the verb,
     * or a failed request. Treat null as unknown, not as off.
     */
    status(): Promise<NotificationStatus | null>;
  };

  /**
   * A small snapshot of the game that the viewer's friends can look at, e.g.
   * a pet's name, coat and burrow. "Friends" are people the viewer follows or
   * who follow them, with no block between them.
   *
   * Requires the `bridge:social` scope and a signed-in user. Gate the UI on
   * `capabilities.has('showcase.friends')`.
   *
   * `publish` REJECTS with a `social/*` code (`SOCIAL_ERROR_CODES`). `friends`
   * degrades to `[]`; `get` resolves null on a host without the verb.
   */
  readonly showcase: {
    /**
     * Create or replace the viewer's snapshot for this game: a JSON object of
     * at most 8 KB. Rate-limited to 30 a minute, so publish on meaningful
     * changes, not every frame.
     */
    publish(data: Record<string, unknown>): Promise<ShowcasePublishResult>;
    /**
     * Friends' snapshots, most recently updated first (default 50, max 100).
     * Only people who have published appear. `[]` when signed out (no round
     * trip) or on a host without the verb. Malformed rows are dropped.
     */
    friends(options?: { limit?: number }): Promise<Showcase[]>;
    /**
     * One person's snapshot, or null when they haven't published (or signed
     * out, or the host lacks the verb). Rejects with `social/not-connected`
     * unless the viewer is connected to them or is them.
     */
    get(userUuid: string): Promise<Showcase | null>;
  };

  /**
   * Small gifts between friends. The platform only carries them: `kind` is
   * the game's word and the game pays out when the recipient claims one.
   * One gift per friend per UTC day, 10 a day in all; unclaimed gifts vanish
   * after 7 days. The recipient gets a bell notification (and a push when
   * their game reminders are on) that opens the game.
   *
   * Requires the `bridge:social` scope and a signed-in user. Gate the UI on
   * `capabilities.has('gifts.send')`.
   *
   * `send` and `claim` REJECT with a `gifts/*` code (`GIFT_ERROR_CODES`).
   * `inbox` and `sentToday` degrade to `[]`.
   */
  readonly gifts: {
    send(payload: GiftSendPayload): Promise<GiftSendResult>;
    /** Unclaimed gifts to the viewer from the last 7 days, newest first (at most 50). */
    inbox(): Promise<Gift[]>;
    /** Mark a gift claimed. Rejects `gifts/claimed` the second time; pay out once. */
    claim(giftUuid: string): Promise<GiftClaimResult>;
    /** Uuids of the friends the viewer has sent a gift to today (UTC). */
    sentToday(): Promise<string[]>;
  };

  /**
   * Visits to friends' homes. A sibling of gifts with its own slot: one visit
   * per friend per UTC day, 10 a day in all, whatever gifts were sent. The
   * platform only carries them: `kind` is the game's word, and the game
   * decides what a visit is worth. The friend gets a bell notification (and a
   * push when their game reminders are on) whose line comes from the app
   * manifest's `social.visitLines`, never from the game at runtime.
   *
   * Requires the `bridge:social` scope and a signed-in user. Gate the UI on
   * `capabilities.has('visits.record')`.
   *
   * `record` and `seen` REJECT with a `visits/*` code (`VISIT_ERROR_CODES`).
   * `inbox` and `sentToday` degrade to `[]`.
   */
  readonly visits: {
    record(payload: VisitRecordPayload): Promise<VisitRecordResult>;
    /**
     * Visits to the viewer from the last 7 days, seen and unseen, newest first
     * (at most 50). Each carries the visitor's current showcase, or null.
     */
    inbox(): Promise<Visit[]>;
    /**
     * Mark visits seen (at most 50 uuids). Resolves the uuids THIS call moved
     * from unseen to seen: pay out for exactly those, and two devices opening
     * at once can't both pay.
     */
    seen(visitUuids: string[]): Promise<VisitSeenResult>;
    /** Uuids of the friends the viewer has visited today (UTC). */
    sentToday(): Promise<string[]>;
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
    // Returns an envelope rather than a row list, so it can't use requestRows.
    // Same two principles though: an unsupported host degrades instead of
    // rejecting, and one bad row drops itself rather than the whole board.
    season: (payload: SeasonPayload): Promise<SeasonBoard | null> =>
      this.request<unknown>('scores.season', payload)
        .then((result): SeasonBoard => {
          const parsed = SeasonBoardEnvelopeSchema.safeParse(result);
          // A malformed envelope REJECTS; it does not resolve null. `null` means
          // exactly one thing — "this host has no season board" — which the UI
          // renders as an empty month. Folding a broken response into that says
          // "nobody played this month" to the player and logs nothing, so a
          // server-side regression looks like a quiet season. A rejection puts
          // the tab in its error state, which is at least visible.
          if (!parsed.success) {
            throw new Error('scores.season: malformed season board');
          }
          return {
            ...parsed.data,
            entries: parseRows<SeasonEntry>(SeasonEntrySchema, parsed.data.entries),
          };
        })
        .catch((error: unknown) => {
          if (isUnsupportedError(error)) return null;
          throw error;
        }),
    // Both rank reads are authenticated, so a signed-out viewer is answered
    // here rather than by a round-trip that can only 401. `OR.user` is
    // populated from `init`, so this is only correct inside `whenReady()` —
    // which is where a game builds its leaderboard anyway.
    rank: (payload: RankPayload): Promise<RoundRank | null> => {
      if (!this.user) return Promise.resolve(null);
      return this.request<unknown>('scores.rank', payload)
        .then((result): RoundRank | null => {
          // Hosts unwrap the REST envelope and resolve the inner value, as they
          // do for `scores.season`. The server answers "you haven't played this
          // round" with an explicit null, so that arrives here as null — and a
          // caller does the same thing with it as with an unsupported host,
          // which is not draw a pinned row.
          if (result == null) return null;
          const parsed = RoundRankSchema.safeParse(result);
          if (!parsed.success) throw new Error('scores.rank: malformed rank');
          return parsed.data;
        })
        .catch((error: unknown) => {
          if (isUnsupportedError(error)) return null;
          throw error;
        });
    },
    seasonRank: (payload: SeasonRankPayload): Promise<SeasonRank | null> => {
      if (!this.user) return Promise.resolve(null);
      return this.request<unknown>('scores.seasonRank', payload)
        .then((result): SeasonRank | null => {
          // Unlike scores.rank, "played nothing this month" still parses: the
          // envelope carries the period's qualifier, which is what the UI needs
          // to tell a player what would put them on the board, so the server
          // sends the context with `rank`/`entry` null rather than sending
          // nothing. Only a genuinely absent answer is null here.
          if (result == null) return null;
          const parsed = SeasonRankSchema.safeParse(result);
          if (!parsed.success) {
            throw new Error('scores.seasonRank: malformed rank');
          }
          return parsed.data;
        })
        .catch((error: unknown) => {
          if (isUnsupportedError(error)) return null;
          throw error;
        });
    },
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

  /**
   * Every single-match verb answers with a view. A malformed one REJECTS
   * rather than resolving something partial: a game cannot render half a
   * match, and a silent null here would read as "match gone" to the player
   * while the server thinks it is their move.
   */
  private requestMatchView(
    type: BridgeRequest['type'],
    payload: unknown
  ): Promise<MatchView> {
    return this.request<unknown>(type, payload).then((result): MatchView => {
      const parsed = MatchViewSchema.safeParse(result);
      if (!parsed.success) throw new Error(`${type}: malformed match view`);
      return parsed.data;
    });
  }

  readonly matches = {
    create: (payload: MatchCreatePayload): Promise<MatchView> =>
      this.requestMatchView('matches.create', payload),
    join: (payload: MatchJoinPayload): Promise<MatchView> =>
      this.requestMatchView('matches.join', payload),
    // Authenticated, so a signed-out viewer is answered here rather than by a
    // round trip that can only 401 — same as the rank reads.
    list: (payload: MatchListPayload = {}): Promise<MatchSummary[]> => {
      if (!this.user) return Promise.resolve([]);
      return this.requestRows<MatchSummary>('matches.list', payload, MatchSummarySchema);
    },
    get: (payload: { matchUuid: string }): Promise<MatchView> =>
      this.requestMatchView('matches.get', payload),
    move: (payload: MatchMovePayload): Promise<MatchView> =>
      this.requestMatchView('matches.move', payload),
    resign: (payload: { matchUuid: string }): Promise<MatchView> =>
      this.requestMatchView('matches.resign', payload),
    // Rejects rather than degrading, like every other write: a game has to
    // know the reminder did not go, and a malformed answer is a host bug.
    nudge: (payload: { matchUuid: string }): Promise<MatchNudgeResult> =>
      this.request<unknown>('matches.nudge', payload).then((result): MatchNudgeResult => {
        const parsed = MatchNudgeResultSchema.safeParse(result);
        if (!parsed.success) throw new Error('matches.nudge: malformed result');
        return parsed.data;
      }),
    claim: (payload: { matchUuid: string }): Promise<MatchView> =>
      this.requestMatchView('matches.claim', payload),
    invitable: (payload: { limit?: number; offset?: number } = {}): Promise<InvitablePlayer[]> => {
      if (!this.user) return Promise.resolve([]);
      return this.requestRows<InvitablePlayer>('matches.invitable', payload, InvitablePlayerSchema);
    },
    watch: (
      matchUuid: string,
      onChange: (view: MatchView) => void,
      options: MatchWatchOptions = {}
    ): (() => void) => {
      const intervalMs = Math.max(1000, options.intervalMs ?? MATCH_WATCH_INTERVAL_MS);
      let stopped = false;
      let paused = false;
      let inFlight = false;
      let lastVersion: number | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const clearTimer = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      };

      const schedule = (): void => {
        clearTimer();
        if (stopped || paused) return;
        timer = setTimeout(tick, intervalMs);
      };

      const tick = (): void => {
        if (stopped || paused || inFlight) return;
        inFlight = true;
        this.matches
          .get({ matchUuid })
          .then((view) => {
            if (stopped) return;
            if (view.version !== lastVersion) {
              lastVersion = view.version;
              onChange(view);
            }
            // Deliver the terminal view, then let go: nothing about a finished
            // match changes, and a poll that never ends is a battery drain the
            // player cannot see.
            if (view.status === 'finished' || view.status === 'abandoned') {
              stop();
            }
          })
          .catch((error: unknown) => {
            if (stopped) return;
            if (isUnsupportedError(error)) {
              stop();
              return;
            }
            options.onError?.(error);
          })
          .then(() => {
            inFlight = false;
            schedule();
          });
      };

      const pause = (): void => {
        paused = true;
        clearTimer();
      };
      const resume = (): void => {
        if (!paused) return;
        paused = false;
        // Poll straight away on return: the interesting change (the opponent
        // moved) almost certainly happened while we were away.
        tick();
      };

      // Two independent pause signals: the host's lifecycle (mobile WebView
      // backgrounded) and the document's own visibility (web tab hidden).
      // Either one pauses; both must clear before polling resumes.
      const offPause = this.transport.onLifecycle('pause', pause);
      const offResume = this.transport.onLifecycle('resume', () => {
        if (!documentHidden()) resume();
      });
      const onVisibility = (): void => {
        if (documentHidden()) pause();
        else resume();
      };
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibility);
      }

      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        clearTimer();
        offPause();
        offResume();
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onVisibility);
        }
      };

      if (documentHidden()) paused = true;
      else tick();
      return stop;
    },
  };

  /** Server time minus Date.now(), when known. */
  private timeOffset: { offsetMs: number; at: number } | null = null;
  private timeInFlight: Promise<number> | null = null;
  private timeRetryAfter = 0;
  private timeListening = false;

  /**
   * Drop the cached offset when the page comes back. Registered on the first
   * `time.now` call so a game that never asks pays nothing.
   */
  private watchTimeInvalidation(): void {
    if (this.timeListening) return;
    this.timeListening = true;
    const drop = (): void => {
      this.timeOffset = null;
    };
    this.transport.onLifecycle('resume', drop);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!documentHidden()) drop();
      });
    }
  }

  readonly time = {
    now: (): Promise<number> => {
      this.watchTimeInvalidation();
      const cached = this.timeOffset;
      if (cached && Date.now() - cached.at < TIME_OFFSET_TTL_MS) {
        return Promise.resolve(Date.now() + cached.offsetMs);
      }
      if (Date.now() < this.timeRetryAfter || !this.capabilities.has('time.now')) {
        return Promise.resolve(Date.now());
      }
      // Callers that ask at the same moment (boot) share one round trip.
      if (this.timeInFlight) return this.timeInFlight;

      const t0 = Date.now();
      this.timeInFlight = this.request<unknown>('time.now')
        .then((result) => {
          const t1 = Date.now();
          const parsed = ServerTimeSchema.safeParse(result);
          if (!parsed.success) throw new Error('time.now: malformed server time');
          // The server read its clock somewhere in the round trip; assume the
          // middle. The error is at most half the round trip.
          const offsetMs = Date.parse(parsed.data.serverTime) + (t1 - t0) / 2 - t1;
          if (t1 - t0 <= TIME_MAX_RTT_MS) {
            this.timeOffset = { offsetMs, at: t1 };
          }
          return Date.now() + offsetMs;
        })
        .catch(() => {
          this.timeRetryAfter = Date.now() + TIME_RETRY_MS;
          return Date.now();
        })
        .finally(() => {
          this.timeInFlight = null;
        });
      return this.timeInFlight;
    },
  };

  readonly notifications = {
    schedule: (payload: NotificationSchedulePayload): Promise<NotificationScheduleResult> => {
      let fireAt: string;
      try {
        fireAt = toIso(payload.fireAt);
      } catch (error) {
        return Promise.reject(error);
      }
      const tz = deviceTimeZone();
      return this.request<unknown>('notifications.schedule', {
        key: payload.key,
        fireAt,
        title: payload.title,
        body: payload.body,
        ...(tz ? { tz } : {}),
      }).then((result): NotificationScheduleResult => {
        const parsed = NotificationScheduleResultSchema.safeParse(result);
        if (!parsed.success) throw new Error('notifications.schedule: malformed result');
        return parsed.data;
      });
    },
    cancel: (key: string): Promise<boolean> =>
      this.request<unknown>('notifications.cancel', { key }).then((result) => {
        const parsed = NotificationCancelResultSchema.safeParse(result);
        if (!parsed.success) throw new Error('notifications.cancel: malformed result');
        return parsed.data.cancelled;
      }),
    list: (): Promise<ScheduledNotification[]> => {
      if (!this.user) return Promise.resolve([]);
      return this.request<unknown>('notifications.list')
        .then((result) => {
          const parsed = NotificationListSchema.safeParse(result);
          if (!parsed.success) throw new Error('notifications.list: malformed result');
          return parseRows<ScheduledNotification>(ScheduledNotificationSchema, parsed.data.pending);
        })
        .catch((error: unknown) => {
          if (isUnsupportedError(error)) return [];
          throw error;
        });
    },
    // A read that only gates UI copy, so every failure degrades to null
    // ("unknown") rather than rejecting.
    status: (): Promise<NotificationStatus | null> => {
      if (!this.user) return Promise.resolve(null);
      return this.request<unknown>('notifications.status')
        .then((result) => {
          const parsed = NotificationStatusSchema.safeParse(result);
          return parsed.success ? parsed.data : null;
        })
        .catch(() => null);
    },
  };

  readonly showcase = {
    publish: (data: Record<string, unknown>): Promise<ShowcasePublishResult> =>
      this.request<unknown>('showcase.publish', { data }).then((result) => {
        const parsed = ShowcasePublishResultSchema.safeParse(result);
        if (!parsed.success) throw new Error('showcase.publish: malformed result');
        return parsed.data;
      }),
    friends: (options?: { limit?: number }): Promise<Showcase[]> => {
      if (!this.user) return Promise.resolve([]);
      const payload = options?.limit !== undefined ? { limit: options.limit } : {};
      return this.requestRows<Showcase>('showcase.friends', payload, ShowcaseSchema);
    },
    get: (userUuid: string): Promise<Showcase | null> => {
      if (!this.user) return Promise.resolve(null);
      return this.request<unknown>('showcase.get', { userUuid })
        .then((result) => {
          if (result === null || result === undefined) return null;
          const parsed = ShowcaseSchema.safeParse(result);
          if (!parsed.success) throw new Error('showcase.get: malformed result');
          return parsed.data;
        })
        .catch((error: unknown) => {
          if (isUnsupportedError(error)) return null;
          throw error;
        });
    },
  };

  readonly gifts = {
    send: (payload: GiftSendPayload): Promise<GiftSendResult> =>
      this.request<unknown>('gifts.send', {
        toUserUuid: payload.toUserUuid,
        kind: payload.kind,
        ...(payload.message !== undefined ? { message: payload.message } : {}),
      }).then((result) => {
        const parsed = GiftSendResultSchema.safeParse(result);
        if (!parsed.success) throw new Error('gifts.send: malformed result');
        return parsed.data;
      }),
    inbox: (): Promise<Gift[]> => {
      if (!this.user) return Promise.resolve([]);
      return this.requestRows<Gift>('gifts.inbox', undefined, GiftSchema);
    },
    claim: (giftUuid: string): Promise<GiftClaimResult> =>
      this.request<unknown>('gifts.claim', { giftUuid }).then((result) => {
        const parsed = GiftClaimResultSchema.safeParse(result);
        if (!parsed.success) throw new Error('gifts.claim: malformed result');
        return parsed.data;
      }),
    sentToday: (): Promise<string[]> => {
      if (!this.user) return Promise.resolve([]);
      return this.request<unknown>('gifts.sentToday')
        .then((result) =>
          Array.isArray(result) ? result.filter((u): u is string => typeof u === 'string') : []
        )
        .catch((error: unknown) => {
          if (isUnsupportedError(error)) return [];
          throw error;
        });
    },
  };

  readonly visits = {
    record: (payload: VisitRecordPayload): Promise<VisitRecordResult> =>
      this.request<unknown>('visits.record', {
        toUserUuid: payload.toUserUuid,
        kind: payload.kind,
      }).then((result) => {
        const parsed = VisitRecordResultSchema.safeParse(result);
        if (!parsed.success) throw new Error('visits.record: malformed result');
        return parsed.data;
      }),
    inbox: (): Promise<Visit[]> => {
      if (!this.user) return Promise.resolve([]);
      return this.requestRows<Visit>('visits.inbox', undefined, VisitSchema);
    },
    seen: (visitUuids: string[]): Promise<VisitSeenResult> => {
      // Nothing to mark: the host rejects an empty list, so answer here.
      if (visitUuids.length === 0) {
        return Promise.resolve({ seen: [], seenAt: new Date().toISOString() });
      }
      return this.request<unknown>('visits.seen', { visitUuids }).then((result) => {
        const parsed = VisitSeenResultSchema.safeParse(result);
        if (!parsed.success) throw new Error('visits.seen: malformed result');
        return parsed.data;
      });
    },
    sentToday: (): Promise<string[]> => {
      if (!this.user) return Promise.resolve([]);
      return this.request<unknown>('visits.sentToday')
        .then((result) =>
          Array.isArray(result) ? result.filter((u): u is string => typeof u === 'string') : []
        )
        .catch((error: unknown) => {
          if (isUnsupportedError(error)) return [];
          throw error;
        });
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
