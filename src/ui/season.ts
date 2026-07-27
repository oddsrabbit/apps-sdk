/**
 * Season-board presentation for the shared leaderboard panel.
 *
 * A season is one calendar month of a daily game's rows collapsed into a single
 * ranked number. Which number depends on the app — see §3.7 of
 * docs/proposals/unified-leaderboard.md — but the *presentation* is identical
 * everywhere, so it lives here rather than four times over.
 *
 * Like `leaderboard.ts`, this never calls the SDK. The caller hands it a promise
 * for a board; the type import is erased at build time.
 */

import type { SeasonBoard } from '../schemas/messages';
import type { LeaderboardRow, LeaderboardTab } from './leaderboard';

export interface SeasonTabOptions {
  /** Fetch the board. Resolving `null` means "this host has no season board". */
  load(): Promise<SeasonBoard | null>;
  /** Tab id. Default `season`. */
  id?: string;
  /** Tab label. Default `Season`. */
  label?: string;
  /**
   * Copy when the month has no qualifying players yet. On a `qualified_avg`
   * board the qualifier sentence is appended automatically, so this only needs
   * to say what's happened, not what the rule is.
   */
  emptyText?: string;
  /**
   * Format the ranked value. Defaults to a localised integer for `sum`/`max`,
   * two decimal places for `qualified_avg`, and — for a metric this bundle
   * doesn't know — whichever of the two the value's own shape implies.
   */
  formatValue?(value: number, board: SeasonBoard): string;
}

const DEFAULT_EMPTY = 'No scores this month yet — play a day to get on the board.';

/**
 * `YYYY-MM` for the current month, in **UTC**.
 *
 * Not local time: a season is a month of puzzle days, and a puzzle day rolls at
 * UTC midnight everywhere — each daily app derives its index from a `Date.UTC`
 * epoch (`rabbit-globe/src/main.ts`, `rabbit-words/src/main.ts`) and counts down
 * to the next UTC midnight. Reading the local month would put a player in
 * UTC+13 on August's empty board from midday UTC on July 31, with twelve hours
 * of July still to play and no way to see it — and mirror that for UTC-11
 * players on the 1st.
 */
export function currentPeriod(date: Date = new Date()): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}`;
}

/** `2026-07` → `July 2026`. Falls back to the raw string if it doesn't parse. */
export function formatPeriod(period: string): string {
  // Same month range as the schema — a looser `\d{2}` would send "2026-13"
  // through `Date.UTC(2026, 12, 1)` and confidently print "January 2027"
  // instead of falling back to the raw string.
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) return period;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = new Date(Date.UTC(year, month - 1, 1));
  if (isNaN(date.getTime())) return period;
  return date.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Does this board's order come from something other than a `value` compare? */
function isPositional(board: SeasonBoard): boolean {
  return board.metric === 'qualified_avg';
}

/** The qualifier sentence, when the board has one. */
function qualifierFor(board: SeasonBoard): string | null {
  if (board.metric !== 'qualified_avg' || board.qualifyingDays === null) return null;
  return (
    `Play ${board.qualifyingDays} of ${board.puzzleDays} days in ` +
    `${formatPeriod(board.period)} to qualify — then your average ranks you.`
  );
}

/** The line under the tabs explaining what the board ranks by. */
function noteFor(board: SeasonBoard): string {
  const when = formatPeriod(board.period);
  if (board.metric === 'max') return `Your best single score in ${when}.`;
  if (board.metric === 'sum') return `Total points across ${when}.`;
  if (board.metric === 'qualified_avg') {
    // The qualifier is the whole design, so it leads — a player below it needs
    // to know they're not ranked and what would change that.
    return qualifierFor(board) ?? `Average score across ${when}.`;
  }
  // A metric this bundle predates — `best_n` is designed but unbuilt (§3.7), and
  // `SeasonBoardSchema.metric` is open precisely so one doesn't blank the board.
  // The ranking behind it is still the server's and still correct; only the
  // caption is unknown, so say the neutral true thing.
  return `Ranked across ${when}.`;
}

function defaultFormat(value: number, board: SeasonBoard): string {
  if (board.metric === 'qualified_avg') return value.toFixed(2);
  if (board.metric === 'sum' || board.metric === 'max') {
    return Math.round(value).toLocaleString();
  }
  // Unknown metric: let the value decide rather than rounding away the decimals
  // of something that turns out to be an average.
  return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
}

/**
 * Build a Season tab for `createLeaderboardPanel`.
 *
 * `load()` resolving `null` yields an empty board rather than an error — a host
 * without the verb should read as "no season here", and callers are expected to
 * gate the tab on `capabilities.has('scores.season')` before adding it at all.
 * A `load()` that REJECTS is a different thing and stays an error: the SDK now
 * rejects a malformed board rather than nulling it, so a server-side break shows
 * up as the tab's error state instead of a month nobody played.
 */
export function createSeasonTab(options: SeasonTabOptions): LeaderboardTab {
  const {
    load,
    id = 'season',
    label = 'Season',
    emptyText = DEFAULT_EMPTY,
    formatValue,
  } = options;

  // Captured by the render hooks below, which the panel only calls after load()
  // has resolved. The metric isn't known until then, and every piece of copy on
  // this board depends on it.
  let board: SeasonBoard | null = null;

  return {
    id,
    label,
    /**
     * An empty board never reaches `renderHeader` — the panel swaps in this
     * text instead — so the qualifier rule would disappear at exactly the
     * moment it is most worth saying: a fresh month where nobody has qualified
     * yet and the player has no way to know what qualifying takes.
     */
    get emptyText(): string {
      const qualifier = board ? qualifierFor(board) : null;
      return qualifier ? `${emptyText} ${qualifier}` : emptyText;
    },
    /**
     * Only `qualified_avg` is genuinely positional: the server sorts it by
     * capped attendance and only then by average, so two equal `value`s aren't
     * a tie the aggregation expresses. `sum` and `max` ARE ordered by `value`,
     * and equal values there are real ties — every other board in these games
     * shares ranks for them, and the same score reading 2nd on one tab and 4th
     * on the next is just wrong.
     *
     * Read at render time, which is always after `load()` settles — the same
     * closure-state pattern the hooks below rely on.
     */
    get rankTies(): boolean {
      return board ? !isPositional(board) : false;
    },
    load: () =>
      load().then((result): LeaderboardRow[] => {
        board = result;
        if (!result) return [];
        return result.entries.map((entry) => ({
          uuid: entry.uuid,
          username: entry.username,
          // The panel ranks and highlights off `score`; for a season board the
          // ranked number is the metric's value.
          score: entry.value,
          createdAt: '',
          avatar: entry.avatar,
          metadata: {
            daysPlayed: entry.daysPlayed,
            average: entry.average,
            streak: entry.streak,
          },
          isSelf: entry.isSelf,
        }));
      }),
    formatValue: (row) => {
      if (!board) return '';
      return formatValue
        ? formatValue(row.score, board)
        : defaultFormat(row.score, board);
    },
    badges: (row) => {
      const meta = row.metadata as {
        daysPlayed?: number;
        streak?: number;
      } | null;
      const badges: string[] = [];
      if (typeof meta?.daysPlayed === 'number') {
        badges.push(meta.daysPlayed === 1 ? '1 day' : `${meta.daysPlayed} days`);
      }
      // Streak earns a badge but never a sort key — as a ranking it's ties all
      // the way down with no skill component (§3.7).
      if (typeof meta?.streak === 'number' && meta.streak > 1) {
        badges.push(`🔥 ${meta.streak}`);
      }
      return badges;
    },
    renderHeader: () => {
      if (!board) return null;
      const note = document.createElement('p');
      note.className = 'lb-note';
      note.textContent = noteFor(board);
      return note;
    },
  };
}
