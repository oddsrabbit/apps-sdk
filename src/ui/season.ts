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

import type { SeasonBoard, SeasonEntry, SeasonRank } from '../schemas/messages';
import type { LeaderboardRow, LeaderboardTab, PinnedRank } from './leaderboard';

export interface SeasonTabOptions {
  /** Fetch the board. Resolving `null` means "this host has no season board". */
  load(): Promise<SeasonBoard | null>;
  /**
   * Fetch the viewer's own placement, for the pinned row under the board — i.e.
   * `OddsRabbit.scores.seasonRank(...)`. Omit and no row is pinned.
   *
   * This is the call that makes a season board mean anything to a player who
   * isn't in the top 20: they cannot compute their own monthly standing from
   * anything they can see. The panel only fires it when the viewer is absent
   * from the fetched page, and a failure here is contained to the pinned row.
   */
  loadRank?(): Promise<SeasonRank | null>;
  /** Tab id. Default `season`. */
  id?: string;
  /** Tab label. Default `Season`. */
  label?: string;
  /**
   * Copy when the month has no ranked players yet. On a `qualified_avg` board
   * the qualifier sentence is appended automatically, so this only needs to say
   * what's happened, not what the rule is.
   */
  emptyText?: string;
  /**
   * Show each player's per-day average as a row badge. Defaults to true on
   * `sum` and `max` boards and false everywhere else — on `qualified_avg` the
   * ranked value IS the average and the badge would just repeat it, and on a
   * metric this bundle doesn't know it might be. Set explicitly to override.
   *
   * On a `sum` board this is the figure that separates skill from attendance —
   * the metric's documented weakness (§3.7) is that a monthly total mostly
   * measures showing up, and the average next to it is what says otherwise.
   */
  showAverage?: boolean;
  /**
   * Format the ranked value. Defaults to a localised integer for `sum`/`max`,
   * two decimal places for `qualified_avg`, and — for a metric this bundle
   * doesn't know — whichever of the two the value's own shape implies.
   */
  formatValue?(value: number, board: SeasonBoard): string;
}

const DEFAULT_EMPTY = 'No scores this month yet — play a day to get on the board.';

/**
 * Shown when `load()` resolves null, i.e. the host doesn't implement the verb.
 *
 * Distinct from `DEFAULT_EMPTY` on purpose. Callers gate this tab on
 * `capabilities.has('scores.season')`, so null should be unreachable — but the
 * capability can narrow at runtime (a host that declared the verb and then
 * rejected it), and in that one case DEFAULT_EMPTY would tell the player nobody
 * played this month. That is exactly the lie the SDK's reject-on-malformed rule
 * exists to prevent, and it would be silly to reintroduce it one layer up.
 */
const UNSUPPORTED_TEXT = "Season boards aren't available here yet.";

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

/**
 * Does this board's order come from something other than a `value` compare?
 *
 * Only `qualified_avg`, whose server-side ordering is
 * `LEAST(COUNT(*), qualifyingDays) DESC, avg_score DESC` — capped attendance
 * first, average only as the tie-break. Two rows showing the same average are
 * therefore not necessarily tied, so ranks stay positional there. `sum` and
 * `max` order on the value itself and share ranks.
 */
function isPositional(board: SeasonBoard): boolean {
  return board.metric === 'qualified_avg';
}

/**
 * The qualifier sentence, when the board has one.
 *
 * States what happens BELOW the threshold as well as above it, because the
 * server returns those players rather than hiding them — see `qualifyingDays`
 * in `messages.ts`. Without the second clause the board contradicts its own
 * caption: rows appear that a viewer would expect their average to have placed,
 * sitting below rows with a worse one.
 */
function qualifierFor(board: SeasonBoard): string | null {
  if (board.metric !== 'qualified_avg' || board.qualifyingDays === null) return null;
  return (
    `Play ${board.qualifyingDays} of ${board.puzzleDays} days in ` +
    `${formatPeriod(board.period)} to qualify — then your average ranks you. ` +
    `Below that you rank under everyone who has.`
  );
}

/**
 * Does this board show a per-day average badge unless the caller says otherwise?
 *
 * An allow-list rather than "anything but `qualified_avg`", for the same reason
 * `defaultFormat` doesn't assume an unknown metric is an integer. If a metric
 * this bundle predates turns out to rank on an average, the badge would restate
 * the ranked value — and restate it rounded, so a row reading `4.50` would carry
 * a badge reading `avg 5`. Losing a useful badge on a future total beats
 * printing a figure that contradicts the one next to it.
 */
function showsAverageByDefault(board: SeasonBoard): boolean {
  return board.metric === 'sum' || board.metric === 'max';
}

/**
 * Has this row met the board's qualifier? True when the board has no qualifier
 * at all, so callers can treat "qualified" as the default state.
 */
function isQualified(board: SeasonBoard, daysPlayed: number): boolean {
  if (board.metric !== 'qualified_avg' || board.qualifyingDays === null) return true;
  return daysPlayed >= board.qualifyingDays;
}

/**
 * A season entry as a panel row.
 *
 * Shared by the board and the pinned row on purpose: `badges` reads
 * `metadata.daysPlayed` / `.average` / `.streak` by name, so a second mapping
 * that spelled one of them differently would silently drop that badge from the
 * viewer's own row and nowhere else.
 */
function seasonRow(entry: SeasonEntry): LeaderboardRow {
  return {
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
  };
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
    loadRank,
    id = 'season',
    label = 'Season',
    emptyText = DEFAULT_EMPTY,
    showAverage,
    formatValue,
  } = options;

  // Captured by the render hooks below, which the panel only calls after load()
  // has resolved. The metric isn't known until then, and every piece of copy on
  // this board depends on it.
  let board: SeasonBoard | null = null;
  // `board === null` alone can't distinguish "host has no season board" from
  // "load() hasn't settled yet", and the two need different copy.
  let unsupported = false;

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
      if (unsupported) return UNSUPPORTED_TEXT;
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
        unsupported = result === null;
        if (!result) return [];
        return result.entries.map(seasonRow);
      }),
    ...(loadRank
      ? {
          loadPinned: (): Promise<PinnedRank | null> =>
            loadRank().then((result) => {
              // `rank`/`entry` are null together when the viewer played no day
              // this month. The envelope still arrives (it carries the period's
              // qualifier), but there is no placement to pin.
              if (!result || result.rank === null || result.entry === null) {
                return null;
              }
              return {
                rank: result.rank,
                total: result.total,
                // Same shape `load()` produces, so the pinned row goes through
                // this tab's own `badges` and `formatValue` untouched — the
                // viewer's days-played and streak render exactly as everyone
                // else's do.
                row: seasonRow(result.entry),
              };
            }),
        }
      : {}),
    formatValue: (row) => {
      if (!board) return '';
      return formatValue
        ? formatValue(row.score, board)
        : defaultFormat(row.score, board);
    },
    badges: (row) => {
      if (!board) return [];
      const meta = row.metadata as {
        daysPlayed?: number;
        average?: number | null;
        streak?: number;
      } | null;
      const badges: string[] = [];
      if (typeof meta?.daysPlayed === 'number') {
        // Below the qualifier the badge shows progress toward it — "14/21 days"
        // — because that is the whole explanation for why this row sits under
        // one with a worse average. Plain "14 days" leaves the ordering looking
        // like a bug.
        if (isQualified(board, meta.daysPlayed)) {
          badges.push(meta.daysPlayed === 1 ? '1 day' : `${meta.daysPlayed} days`);
        } else {
          badges.push(`${meta.daysPlayed}/${board.qualifyingDays} days`);
        }
      }
      // On a points total this is the skill signal next to the attendance one;
      // on `qualified_avg` it IS the ranked value, so showing it twice is noise.
      const wantAverage = showAverage ?? showsAverageByDefault(board);
      if (wantAverage && typeof meta?.average === 'number') {
        badges.push(`avg ${Math.round(meta.average).toLocaleString()}`);
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
