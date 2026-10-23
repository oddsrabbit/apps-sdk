/**
 * The playground's stand-in for the OddsRabbit server.
 *
 * The playground page plays the part of oddsrabbit.com around the real sandbox
 * host, and this answers every bridge verb the server would, from in-memory
 * state. It copies the server's RULES (caps, scopes, signed-out codes, one row
 * per round, the follow-graph check) so a game that works here meets the same
 * refusals in production. It does not copy server data: boards are filled with
 * made-up players, and friends' showcases are copies of the player's own.
 *
 * Pure: no DOM, no storage, no clock except the injected `now`. The page owns
 * persistence and the verbs that need a person to answer (share sheets,
 * sign-in prompts); `handle` returns `null` for those and for every verb it
 * doesn't model (matches), and the page decides.
 *
 * The limits mirror the server's policy classes (AppNotificationPolicy,
 * AppGiftPolicy, AppVisitPolicy, AppSubmissionPolicy, AppStorageService). When
 * one of those changes, change it here too.
 */

import {
  CONTENT_ERROR_CODES,
  GIFT_ERROR_CODES,
  NOTIFICATION_ERROR_CODES,
  SHOWCASE_MAX_BYTES,
  SOCIAL_ERROR_CODES,
  STORAGE_TOTAL_MAX_BYTES,
  VISIT_ERROR_CODES,
} from '../schemas/messages';

export const PLAYGROUND_SCOPES = ['bridge:notifications', 'bridge:social', 'bridge:submit'] as const;

const DAY_MS = 86_400_000;
const NOTIFICATIONS_MAX_PENDING = 5;
const NOTIFICATION_MIN_LEAD_MS = 60_000;
const NOTIFICATION_MAX_LEAD_MS = 14 * DAY_MS;
const SOCIAL_DAILY_CAP = 10;
const INBOX_TTL_MS = 7 * DAY_MS;
const INBOX_LIMIT = 50;
const SUBMISSIONS_DAILY_CAP = 5;
const BOARD_DEFAULT_LIMIT = 20;
const FAKE_STRANGERS = 16;

export interface PlaygroundUser {
  uuid: string;
  username: string;
  avatar: string | null;
  createdAt: string | null;
  supporter: boolean;
}

export interface Person {
  uuid: string;
  username: string;
  avatar: string | null;
}

/** One round's content as typed into the playground's content editor. */
export interface DailyRound {
  content: Record<string, unknown>;
  reveals?: Record<string, unknown>[];
}

export interface PlaygroundSettings {
  /** The signed-in player, or null for a guest. */
  user: PlaygroundUser | null;
  /** Scopes the manifest declares. Only the ones the server enforces matter. */
  scopes: string[];
  /** Fill a round's boards with made-up players the first time you score in it. */
  fillBoards: boolean;
  /** What `notifications.status` reports for `push` (before the mute). */
  pushReachable: boolean;
  /** Round key → content; `*` answers any round without its own entry. */
  dailyContent: Record<string, DailyRound>;
}

export interface ScoreRow {
  uuid: string;
  username: string;
  avatar: string | null;
  score: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  likes: number;
}

export interface Reminder {
  key: string;
  title: string;
  body: string;
  fireAt: string;
}

export interface GiftRow {
  giftUuid: string;
  from: Person;
  kind: string;
  message: string | null;
  sentAt: string;
  counts: boolean;
  claimedAt: string | null;
}

export interface VisitRow {
  visitUuid: string;
  from: Person;
  kind: string;
  visitedAt: string;
  seenAt: string | null;
  counts: boolean;
}

export interface SentRow {
  to: string;
  kind: string;
  at: string;
}

export interface Submission {
  id: string;
  kind: string;
  title: string;
  image: string;
  createdAt: string;
}

export interface PlaygroundState {
  /** Signed-in storage. A guest's saves live in the host's localStorage. */
  storage: Record<string, string>;
  rounds: Record<string, ScoreRow[]>;
  /** Round key → uuids of the rows the player has liked. */
  myLikes: Record<string, string[]>;
  reminders: Reminder[];
  /** Reminders whose time came, newest first, for the page to offer as taps. */
  delivered: Reminder[];
  muted: boolean;
  showcase: { data: Record<string, unknown>; updatedAt: string } | null;
  giftsInbox: GiftRow[];
  giftsSent: SentRow[];
  visitsInbox: VisitRow[];
  visitsSent: SentRow[];
  /** `${roundKey}#${index}` → the first guess locked in. */
  guesses: Record<string, Record<string, unknown>>;
  submissions: Submission[];
}

export type Outcome =
  | { ok: true; result?: unknown }
  | { ok: false; error: { code: string; message: string } };

export function emptyState(): PlaygroundState {
  return {
    storage: {},
    rounds: {},
    myLikes: {},
    reminders: [],
    delivered: [],
    muted: false,
    showcase: null,
    giftsInbox: [],
    giftsSent: [],
    visitsInbox: [],
    visitsSent: [],
    guesses: {},
    submissions: [],
  };
}

/** A small round avatar, inline so the playground needs no network. */
const PIP_AVATAR =
  'data:image/svg+xml;base64,' +
  'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PGNpcmNsZSBjeD0iMzIiIGN5PSIzMiIgcj0iMzIiIGZpbGw9IiNmNmMxNzciLz48Y2lyY2xlIGN4PSIzMiIgY3k9IjI2IiByPSIxMiIgZmlsbD0iI2ZmZiIvPjxwYXRoIGQ9Ik0xMiA1NmMzLTEyIDExLTE4IDIwLTE4czE3IDYgMjAgMTgiIGZpbGw9IiNmZmYiLz48L3N2Zz4=';

/**
 * The player's friends: people they follow or who follow them. One has an
 * avatar and the rest don't, so a game's image path and its initials fallback
 * both get exercised.
 */
export const FRIENDS: readonly Person[] = [
  { uuid: '7b1c5e0a-1f0e-4c4b-9a51-000000000002', username: 'mika', avatar: null },
  { uuid: '7b1c5e0a-1f0e-4c4b-9a51-000000000003', username: 'juno', avatar: null },
  { uuid: '7b1c5e0a-1f0e-4c4b-9a51-000000000004', username: 'pip', avatar: PIP_AVATAR },
  { uuid: '7b1c5e0a-1f0e-4c4b-9a51-000000000005', username: 'otis_the_long_named_rabbit', avatar: null },
];

const STRANGER_NAMES = [
  'clover', 'basil', 'hazel', 'thistle', 'maple', 'sorrel', 'bramble', 'fern',
  'juniper', 'wren', 'pebble', 'nutmeg', 'sage', 'willow', 'acorn', 'poppy',
];

export const DEFAULT_PLAYER: PlaygroundUser = {
  uuid: '7b1c5e0a-1f0e-4c4b-9a51-000000000001',
  username: 'player',
  avatar: null,
  createdAt: '2026-01-15T12:00:00.000Z',
  supporter: false,
};

function fail(code: string, message: string): Outcome {
  return { ok: false, error: { code, message } };
}

function ok(result?: unknown): Outcome {
  return result === undefined ? { ok: true } : { ok: true, result };
}

/**
 * 32-bit FNV-1a with murmur3's finalizer, for made-up scores that stay put
 * across reloads. Plain FNV barely moves its high bits when only the last
 * character differs, which is exactly how the friends' uuids differ.
 */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function unit(text: string): number {
  return hash(text) / 0xffffffff;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

function strangerUuid(i: number): string {
  return `7b1c5e0a-1f0e-4c4b-9a51-${String(100 + i).padStart(12, '0')}`;
}

/** Same reading of a period as the server: keys carrying a `YYYY-MM-DD` date. */
function roundDate(roundKey: string): string | null {
  const match = /(\d{4}-\d{2}-\d{2})/.exec(roundKey);
  return match ? match[1]! : null;
}

function byScore(a: ScoreRow, b: ScoreRow): number {
  return b.score - a.score || a.createdAt.localeCompare(b.createdAt);
}

type Payload = Record<string, unknown>;

export class FakePlatform {
  constructor(
    public state: PlaygroundState,
    public settings: PlaygroundSettings,
    private readonly now: () => number = Date.now,
    private readonly uuid: () => string = () => crypto.randomUUID()
  ) {}

  private iso(offsetMs = 0): string {
    return new Date(this.now() + offsetMs).toISOString();
  }

  private get user(): PlaygroundUser | null {
    return this.settings.user;
  }

  private hasScope(scope: string): boolean {
    return this.settings.scopes.includes(scope);
  }

  private isFriend(uuid: string): boolean {
    return FRIENDS.some((f) => f.uuid === uuid);
  }

  /**
   * Answer one bridge request, or `null` when the page should: the verbs that
   * need a person (share sheets, sign-in) and the ones the playground can't
   * model (matches need rules on our server).
   */
  handle(type: string, payload: unknown): Outcome | null {
    const p = (payload && typeof payload === 'object' ? payload : {}) as Payload;
    switch (type) {
      case 'ready':
      case 'actions.haptic':
        return ok();
      case 'time.now':
        return ok({ serverTime: this.iso() });

      case 'storage.get':
      case 'storage.set':
      case 'storage.delete':
        return this.storage(type, p);

      case 'scores.submit':
        return this.submitScore(p);
      case 'scores.friends':
        return this.friendsBoard(String(p.roundKey));
      case 'scores.distribution':
        return this.distribution(String(p.roundKey));
      case 'scores.top':
        return ok(this.topBoard(String(p.roundKey), p.order as string | undefined, p.limit as number | undefined));
      case 'scores.like':
        return this.like(String(p.roundKey), String(p.uuid), p.liked === true);
      case 'scores.myLikes':
        if (!this.user) return fail('scores/unauthorized', 'Not authenticated.');
        return ok(this.state.myLikes[String(p.roundKey)] ?? []);
      case 'scores.rank':
        return this.rank(String(p.roundKey), p.order as string | undefined);
      case 'scores.season':
        return ok(this.season(String(p.period), p.metric as string | undefined, p.limit as number | undefined));
      case 'scores.seasonRank':
        return this.seasonRank(String(p.period), p.metric as string | undefined);

      case 'content.daily':
        return ok(this.daily(String(p.roundKey)));
      case 'content.reveal':
        return this.reveal(String(p.roundKey), Number(p.index), (p.guess ?? {}) as Payload);
      case 'content.submit':
        return this.submitContent(p);

      case 'notifications.schedule':
      case 'notifications.cancel':
      case 'notifications.list':
      case 'notifications.status':
      case 'notifications.muted':
      case 'notifications.setMuted':
        return this.notifications(type, p);

      case 'showcase.publish':
      case 'showcase.friends':
      case 'showcase.get':
        return this.showcases(type, p);

      case 'gifts.send':
      case 'gifts.inbox':
      case 'gifts.claim':
      case 'gifts.sentToday':
        return this.gifts(type, p);

      case 'visits.record':
      case 'visits.inbox':
      case 'visits.seen':
      case 'visits.sentToday':
        return this.visits(type, p);

      default:
        return null;
    }
  }

  // ---- storage --------------------------------------------------------------

  private storage(type: string, p: Payload): Outcome {
    if (!this.user) return fail('storage/unauthorized', 'Not authenticated.');
    const key = String(p.key);
    if (type === 'storage.get') return ok(this.state.storage[key] ?? null);
    if (type === 'storage.delete') {
      delete this.state.storage[key];
      return ok();
    }
    const value = String(p.value);
    let total = utf8Bytes(value);
    for (const [k, v] of Object.entries(this.state.storage)) {
      if (k !== key) total += utf8Bytes(v);
    }
    if (total > STORAGE_TOTAL_MAX_BYTES) {
      return fail('storage/tuple-size-exceeded', `This player's saves for the game would be ${total} bytes; the cap is ${STORAGE_TOTAL_MAX_BYTES}.`);
    }
    this.state.storage[key] = value;
    return ok();
  }

  // ---- scores ---------------------------------------------------------------

  private submitScore(p: Payload): Outcome {
    const user = this.user;
    if (!user) return fail('scores/unauthorized', 'Not authenticated.');
    const roundKey = String(p.roundKey);
    const score = Number(p.score);
    const rows = (this.state.rounds[roundKey] ??= []);
    const mine = rows.find((r) => r.uuid === user.uuid);
    const metadata = (p.metadata as Record<string, unknown> | undefined) ?? null;
    if (mine) {
      if (p.keepBest !== true) {
        return fail('scores/already-submitted', 'Already submitted for this round.');
      }
      if (score > mine.score) {
        mine.score = score;
        mine.metadata = metadata;
        mine.createdAt = this.iso();
      }
      return ok();
    }
    rows.push({ ...this.person(user), score, metadata, createdAt: this.iso(), likes: 0 });
    if (this.settings.fillBoards) this.seedRound(roundKey, score);
    return ok();
  }

  /**
   * Made-up players around the player's own score, so a board has rows above
   * and below them. Deterministic per round, so a reload shows the same board.
   */
  private seedRound(roundKey: string, around: number): void {
    const rows = this.state.rounds[roundKey]!;
    if (rows.some((r) => r.uuid !== this.user?.uuid)) return;
    const base = Math.abs(around) || 10;
    const people: Person[] = [
      ...FRIENDS,
      ...STRANGER_NAMES.slice(0, FAKE_STRANGERS).map((username, i) => ({
        uuid: strangerUuid(i),
        username,
        avatar: null,
      })),
    ];
    for (const person of people) {
      const r = unit(`${roundKey}:${person.uuid}`);
      const score = Math.round(Math.sign(around || 1) * base * (0.3 + r * 1.2));
      rows.push({
        ...person,
        score,
        metadata: null,
        createdAt: this.iso(-Math.round(unit(`${person.uuid}:${roundKey}:t`) * 20 * 3600_000) - 60_000),
        likes: Math.floor(unit(`${roundKey}:${person.uuid}:likes`) * 10),
      });
    }
  }

  private person(user: PlaygroundUser): Person {
    return { uuid: user.uuid, username: user.username, avatar: user.avatar };
  }

  /** A copy, so a caller can't reach back into the stored row. */
  private publicRow(row: ScoreRow): ScoreRow {
    return { ...row };
  }

  private friendsBoard(roundKey: string): Outcome {
    const user = this.user;
    if (!user) return ok([]);
    const rows = (this.state.rounds[roundKey] ?? [])
      .filter((r) => r.uuid === user.uuid || this.isFriend(r.uuid))
      .sort(byScore)
      .map((r) => ({ ...this.publicRow(r), isSelf: r.uuid === user.uuid }));
    return ok(rows);
  }

  private distribution(roundKey: string): Outcome {
    const counts = new Map<number, number>();
    for (const row of this.state.rounds[roundKey] ?? []) {
      counts.set(row.score, (counts.get(row.score) ?? 0) + 1);
    }
    return ok(
      [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([score, count]) => ({ score, count }))
    );
  }

  private ordered(roundKey: string, order: string | undefined): ScoreRow[] {
    const rows = [...(this.state.rounds[roundKey] ?? [])];
    switch (order) {
      case 'first':
        return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      case 'latest':
        return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      case 'likes':
        return rows.sort((a, b) => b.likes - a.likes || byScore(a, b));
      default:
        return rows.sort(byScore);
    }
  }

  private topBoard(roundKey: string, order: string | undefined, limit: number | undefined): ScoreRow[] {
    return this.ordered(roundKey, order)
      .slice(0, Math.min(Math.max(limit ?? BOARD_DEFAULT_LIMIT, 1), 100))
      .map((r) => this.publicRow(r));
  }

  private like(roundKey: string, uuid: string, liked: boolean): Outcome {
    const user = this.user;
    if (!user) return fail('scores/unauthorized', 'Not authenticated.');
    if (uuid === user.uuid) return fail('scores/own-entry', "You can't like your own entry.");
    const row = (this.state.rounds[roundKey] ?? []).find((r) => r.uuid === uuid);
    if (!row) return fail('scores/not-found', 'That player has no entry in this round.');
    const mine = (this.state.myLikes[roundKey] ??= []);
    const had = mine.includes(uuid);
    if (liked && !had) {
      mine.push(uuid);
      row.likes += 1;
    } else if (!liked && had) {
      mine.splice(mine.indexOf(uuid), 1);
      row.likes = Math.max(0, row.likes - 1);
    }
    return ok({ liked, likes: row.likes });
  }

  private rank(roundKey: string, order: string | undefined): Outcome {
    const user = this.user;
    if (!user) return fail('scores/unauthorized', 'Not authenticated.');
    const rows = this.ordered(roundKey, order === 'first' ? 'first' : 'top');
    const index = rows.findIndex((r) => r.uuid === user.uuid);
    if (index < 0) return ok(null);
    return ok({ rank: index + 1, total: rows.length, entry: { ...this.publicRow(rows[index]!), isSelf: true } });
  }

  /** Puzzle days in a period so far: the whole month once it's over. */
  private puzzleDays(period: string): number {
    const today = this.iso().slice(0, 10);
    const thisMonth = today.slice(0, 7);
    if (period > thisMonth) return 0;
    if (period === thisMonth) return Number(today.slice(8, 10));
    const [y, m] = period.split('-').map(Number) as [number, number];
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  private seasonEntries(period: string, metric: string, qualifyingDays: number | null) {
    const byPlayer = new Map<string, { person: Person; days: Map<string, number> }>();
    for (const [roundKey, rows] of Object.entries(this.state.rounds)) {
      const date = roundDate(roundKey);
      if (!date || !date.startsWith(period)) continue;
      for (const row of rows) {
        const entry = byPlayer.get(row.uuid) ?? { person: row, days: new Map<string, number>() };
        entry.days.set(date, Math.max(entry.days.get(date) ?? -Infinity, row.score));
        byPlayer.set(row.uuid, entry);
      }
    }
    const entries = [...byPlayer.values()].map(({ person, days }) => {
      const scores = [...days.values()];
      const sum = scores.reduce((a, b) => a + b, 0);
      const average = scores.length ? sum / scores.length : null;
      let value = sum;
      if (metric === 'max') value = Math.max(...scores);
      else if (metric === 'qualified_avg') value = average ?? 0;
      else if (metric === 'best_n') {
        value = [...scores].sort((a, b) => b - a).slice(0, qualifyingDays ?? scores.length).reduce((a, b) => a + b, 0);
      }
      return {
        uuid: person.uuid,
        username: person.username,
        avatar: person.avatar,
        value,
        daysPlayed: scores.length,
        average,
        streak: longestStreak([...days.keys()]),
        isSelf: person.uuid === this.user?.uuid,
      };
    });
    entries.sort((a, b) => {
      if (metric === 'qualified_avg' && qualifyingDays !== null) {
        const qa = Math.min(a.daysPlayed, qualifyingDays);
        const qb = Math.min(b.daysPlayed, qualifyingDays);
        if (qa !== qb) return qb - qa;
      }
      return b.value - a.value;
    });
    return entries;
  }

  private seasonHeader(period: string, requested: string | undefined) {
    const metric = requested ?? 'sum';
    const puzzleDays = this.puzzleDays(period);
    const qualifyingDays =
      metric === 'qualified_avg' || metric === 'best_n' ? Math.ceil((puzzleDays * 2) / 3) : null;
    return { period, metric, puzzleDays, qualifyingDays };
  }

  private season(period: string, metric: string | undefined, limit: number | undefined) {
    const header = this.seasonHeader(period, metric);
    const entries = this.seasonEntries(period, header.metric, header.qualifyingDays);
    return { ...header, entries: entries.slice(0, Math.min(Math.max(limit ?? BOARD_DEFAULT_LIMIT, 1), 100)) };
  }

  private seasonRank(period: string, metric: string | undefined): Outcome {
    const user = this.user;
    if (!user) return fail('scores/unauthorized', 'Not authenticated.');
    const header = this.seasonHeader(period, metric);
    const entries = this.seasonEntries(period, header.metric, header.qualifyingDays);
    const index = entries.findIndex((e) => e.uuid === user.uuid);
    return ok({
      ...header,
      rank: index < 0 ? null : index + 1,
      total: entries.length,
      entry: index < 0 ? null : entries[index],
    });
  }

  // ---- content --------------------------------------------------------------

  private round(roundKey: string): DailyRound | null {
    return this.settings.dailyContent[roundKey] ?? this.settings.dailyContent['*'] ?? null;
  }

  private daily(roundKey: string): { roundKey: string; content: Record<string, unknown> } | null {
    const round = this.round(roundKey);
    return round ? { roundKey, content: round.content } : null;
  }

  private reveal(roundKey: string, index: number, guess: Payload): Outcome {
    const round = this.round(roundKey);
    if (!round) return fail(CONTENT_ERROR_CODES.notAvailable, 'That round is not published.');
    if (!round.reveals || round.reveals.length === 0) {
      return fail(CONTENT_ERROR_CODES.noReveal, "This round's content has nothing to reveal.");
    }
    const answer = round.reveals[index];
    if (!answer) return fail(CONTENT_ERROR_CODES.invalidGuess, `Index ${index} is out of range.`);
    let held = guess;
    if (this.user) {
      const slot = `${roundKey}#${index}`;
      held = this.state.guesses[slot] ??= guess;
    }
    return ok({ roundKey, index, guess: held, reveal: answer });
  }

  private submitContent(p: Payload): Outcome {
    if (!this.user) return fail(CONTENT_ERROR_CODES.unauthorized, 'Not authenticated.');
    if (!this.hasScope('bridge:submit')) {
      return fail(CONTENT_ERROR_CODES.forbidden, 'The manifest does not declare bridge:submit.');
    }
    const title = String(p.title).replace(/<[^>]*>/g, '').trim();
    if (title === '') return fail(CONTENT_ERROR_CODES.invalid, 'The title is empty once tags are stripped.');
    const today = utcDay(this.iso());
    if (this.state.submissions.filter((s) => utcDay(s.createdAt) === today).length >= SUBMISSIONS_DAILY_CAP) {
      return fail(CONTENT_ERROR_CODES.tooMany, `At most ${SUBMISSIONS_DAILY_CAP} a day.`);
    }
    const id = this.uuid();
    this.state.submissions.unshift({ id, kind: String(p.kind), title, image: String(p.image), createdAt: this.iso() });
    return ok({ id });
  }

  // ---- notifications --------------------------------------------------------

  /** Move reminders whose time has come to `delivered`. */
  deliverDue(): Reminder[] {
    const now = this.now();
    const due = this.state.reminders.filter((r) => Date.parse(r.fireAt) <= now);
    if (due.length) {
      this.state.reminders = this.state.reminders.filter((r) => !due.includes(r));
      this.state.delivered.unshift(...due);
    }
    return due;
  }

  private notifications(type: string, p: Payload): Outcome {
    if (!this.user) return fail(NOTIFICATION_ERROR_CODES.unauthorized, 'Not authenticated.');
    if (type === 'notifications.status') {
      return ok({ push: this.settings.pushReachable && !this.state.muted, muted: this.state.muted });
    }
    if (type === 'notifications.muted') return ok({ muted: this.state.muted });
    if (type === 'notifications.setMuted') {
      this.state.muted = p.muted === true;
      return ok({ muted: this.state.muted });
    }
    if (!this.hasScope('bridge:notifications')) {
      return fail(NOTIFICATION_ERROR_CODES.forbidden, 'The manifest does not declare bridge:notifications.');
    }
    this.deliverDue();
    const serverTime = this.iso();
    if (type === 'notifications.list') {
      const pending = [...this.state.reminders]
        .sort((a, b) => a.fireAt.localeCompare(b.fireAt))
        .map((r) => ({ key: r.key, fireAt: r.fireAt, deliverAt: r.fireAt }));
      return ok({ pending, serverTime });
    }
    const key = String(p.key);
    if (type === 'notifications.cancel') {
      const before = this.state.reminders.length;
      this.state.reminders = this.state.reminders.filter((r) => r.key !== key);
      return ok({ key, cancelled: this.state.reminders.length !== before });
    }
    const fireAtMs = Date.parse(String(p.fireAt));
    const lead = fireAtMs - this.now();
    if (!Number.isFinite(fireAtMs) || lead < NOTIFICATION_MIN_LEAD_MS || lead > NOTIFICATION_MAX_LEAD_MS) {
      return fail(NOTIFICATION_ERROR_CODES.badTime, 'fireAt must be between a minute and 14 days away.');
    }
    const others = this.state.reminders.filter((r) => r.key !== key);
    if (others.length >= NOTIFICATIONS_MAX_PENDING) {
      return fail(NOTIFICATION_ERROR_CODES.tooMany, `At most ${NOTIFICATIONS_MAX_PENDING} pending reminders per game.`);
    }
    const fireAt = new Date(fireAtMs).toISOString();
    this.state.reminders = [...others, { key, title: String(p.title), body: String(p.body), fireAt }];
    return ok({ key, fireAt, deliverAt: fireAt, serverTime });
  }

  // ---- showcases ------------------------------------------------------------

  /** A friend's snapshot: a copy of the player's own, so the game has one to draw. */
  private friendShowcase(friend: Person, index: number) {
    const own = this.state.showcase;
    if (!own) return null;
    return {
      uuid: friend.uuid,
      username: friend.username,
      avatar: friend.avatar,
      data: own.data,
      updatedAt: new Date(Date.parse(own.updatedAt) - (index + 1) * 3600_000).toISOString(),
    };
  }

  private showcases(type: string, p: Payload): Outcome {
    const user = this.user;
    if (!user) {
      if (type === 'showcase.friends') return ok([]);
      if (type === 'showcase.get') return ok(null);
      return fail(SOCIAL_ERROR_CODES.unauthorized, 'Not authenticated.');
    }
    if (!this.hasScope('bridge:social')) {
      return fail(SOCIAL_ERROR_CODES.forbidden, 'The manifest does not declare bridge:social.');
    }
    if (type === 'showcase.publish') {
      const data = (p.data ?? {}) as Record<string, unknown>;
      if (utf8Bytes(JSON.stringify(data)) > SHOWCASE_MAX_BYTES) {
        return fail(SOCIAL_ERROR_CODES.tooLarge, `Snapshots are at most ${SHOWCASE_MAX_BYTES} bytes of JSON.`);
      }
      const updatedAt = this.iso();
      this.state.showcase = { data, updatedAt };
      return ok({ updatedAt });
    }
    if (type === 'showcase.friends') {
      const limit = Math.min(Math.max(Number((p as { limit?: number }).limit ?? 50), 1), 100);
      return ok(FRIENDS.map((f, i) => this.friendShowcase(f, i)).filter(Boolean).slice(0, limit));
    }
    const uuid = String(p.userUuid);
    if (uuid === user.uuid) {
      const own = this.state.showcase;
      return ok(own ? { ...this.person(user), data: own.data, updatedAt: own.updatedAt } : null);
    }
    const index = FRIENDS.findIndex((f) => f.uuid === uuid);
    if (index < 0) return fail(SOCIAL_ERROR_CODES.notConnected, "You aren't connected to that player.");
    return ok(this.friendShowcase(FRIENDS[index]!, index));
  }

  // ---- gifts and visits -----------------------------------------------------

  private sendCheck(
    sent: SentRow[],
    to: string,
    codes: { invalid: string; notConnected: string; already: string; tooMany: string }
  ): Outcome | null {
    if (to === this.user?.uuid) return fail(codes.invalid, "You can't send one to yourself.");
    if (!this.isFriend(to)) return fail(codes.notConnected, "You aren't connected to that player.");
    const today = utcDay(this.iso());
    const todays = sent.filter((s) => utcDay(s.at) === today);
    if (todays.some((s) => s.to === to)) return fail(codes.already, 'Once per friend per UTC day.');
    if (todays.length >= SOCIAL_DAILY_CAP) return fail(codes.tooMany, `At most ${SOCIAL_DAILY_CAP} a day.`);
    return null;
  }

  private sentToday(sent: SentRow[]): string[] {
    const today = utcDay(this.iso());
    return sent.filter((s) => utcDay(s.at) === today).map((s) => s.to);
  }

  private fresh<T>(rows: T[], at: (row: T) => string): T[] {
    const cutoff = this.now() - INBOX_TTL_MS;
    return rows.filter((r) => Date.parse(at(r)) >= cutoff);
  }

  private gifts(type: string, p: Payload): Outcome {
    if (!this.user) {
      if (type === 'gifts.inbox' || type === 'gifts.sentToday') return ok([]);
      return fail(GIFT_ERROR_CODES.unauthorized, 'Not authenticated.');
    }
    if (!this.hasScope('bridge:social')) {
      return fail(SOCIAL_ERROR_CODES.forbidden, 'The manifest does not declare bridge:social.');
    }
    if (type === 'gifts.sentToday') return ok(this.sentToday(this.state.giftsSent));
    if (type === 'gifts.inbox') {
      const rows = this.fresh(this.state.giftsInbox, (g) => g.sentAt)
        .filter((g) => g.claimedAt === null)
        .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
        .slice(0, INBOX_LIMIT)
        .map(({ claimedAt: _claimed, ...gift }) => gift);
      return ok(rows);
    }
    if (type === 'gifts.claim') {
      const gift = this.fresh(this.state.giftsInbox, (g) => g.sentAt).find((g) => g.giftUuid === p.giftUuid);
      if (!gift) return fail(GIFT_ERROR_CODES.notFound, 'No such gift.');
      if (gift.claimedAt) return fail(GIFT_ERROR_CODES.claimed, 'Already claimed.');
      gift.claimedAt = this.iso();
      return ok({ giftUuid: gift.giftUuid, kind: gift.kind, claimedAt: gift.claimedAt });
    }
    const to = String(p.toUserUuid);
    const refused = this.sendCheck(this.state.giftsSent, to, {
      invalid: GIFT_ERROR_CODES.invalid,
      notConnected: GIFT_ERROR_CODES.notConnected,
      already: GIFT_ERROR_CODES.alreadySentToday,
      tooMany: GIFT_ERROR_CODES.tooMany,
    });
    if (refused) return refused;
    const sentAt = this.iso();
    this.state.giftsSent.push({ to, kind: String(p.kind), at: sentAt });
    return ok({ giftUuid: this.uuid(), sentAt });
  }

  private visits(type: string, p: Payload): Outcome {
    if (!this.user) {
      if (type === 'visits.inbox' || type === 'visits.sentToday') return ok([]);
      return fail(VISIT_ERROR_CODES.unauthorized, 'Not authenticated.');
    }
    if (!this.hasScope('bridge:social')) {
      return fail(SOCIAL_ERROR_CODES.forbidden, 'The manifest does not declare bridge:social.');
    }
    if (type === 'visits.sentToday') return ok(this.sentToday(this.state.visitsSent));
    if (type === 'visits.inbox') {
      const rows = this.fresh(this.state.visitsInbox, (v) => v.visitedAt)
        .sort((a, b) => b.visitedAt.localeCompare(a.visitedAt))
        .slice(0, INBOX_LIMIT)
        .map((v) => {
          const index = FRIENDS.findIndex((f) => f.uuid === v.from.uuid);
          const showcase = index < 0 ? null : this.friendShowcase(FRIENDS[index]!, index);
          return { ...v, showcase: showcase ? showcase.data : null };
        });
      return ok(rows);
    }
    if (type === 'visits.seen') {
      const seenAt = this.iso();
      const ids = (p.visitUuids as string[]) ?? [];
      const seen: string[] = [];
      for (const visit of this.state.visitsInbox) {
        if (ids.includes(visit.visitUuid) && visit.seenAt === null) {
          visit.seenAt = seenAt;
          seen.push(visit.visitUuid);
        }
      }
      return ok({ seen, seenAt });
    }
    const to = String(p.toUserUuid);
    const refused = this.sendCheck(this.state.visitsSent, to, {
      invalid: VISIT_ERROR_CODES.invalid,
      notConnected: VISIT_ERROR_CODES.notConnected,
      already: VISIT_ERROR_CODES.alreadyVisitedToday,
      tooMany: VISIT_ERROR_CODES.tooMany,
    });
    if (refused) return refused;
    const visitedAt = this.iso();
    this.state.visitsSent.push({ to, kind: String(p.kind), at: visitedAt });
    return ok({ visitUuid: this.uuid(), visitedAt });
  }

  /** A friend sends the player a gift (the playground's "receive" button). */
  receiveGift(from: Person, kind: string, message: string | null, counts = true): GiftRow {
    const gift: GiftRow = { giftUuid: this.uuid(), from, kind, message, sentAt: this.iso(), counts, claimedAt: null };
    this.state.giftsInbox.unshift(gift);
    return gift;
  }

  /** A friend visits the player. */
  receiveVisit(from: Person, kind: string, counts = true): VisitRow {
    const visit: VisitRow = { visitUuid: this.uuid(), from, kind, visitedAt: this.iso(), seenAt: null, counts };
    this.state.visitsInbox.unshift(visit);
    return visit;
  }
}

/**
 * The bell line a friend would get for a visit, from the manifest's
 * `social.visitLines`, with the server's fallback.
 */
export function visitLine(visitLines: Record<string, string>, kind: string, username: string): string {
  const line = visitLines[kind];
  return (line && line.split('{username}').length === 2 ? line : '{username} came to visit.').replace('{username}', username);
}

function longestStreak(dates: string[]): number {
  const days = [...new Set(dates)].map((d) => Date.parse(`${d}T00:00:00Z`) / DAY_MS).sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i]! - days[i - 1]! === 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}
