/**
 * Shared leaderboard UI for OddsRabbit mini-apps.
 *
 * One renderer for every game's board, replacing the near-identical copies that
 * had grown in `2048/js/leaderboard.js` (modal, medals) and
 * `rabbit-globe/src/main.ts` (`renderFriendsPanel`, `rowAvatar`). The `lb-*`
 * class names and the avatar-hash logic were already byte-identical in both;
 * this module is that shared code with the per-game parts lifted into options.
 *
 * Deliberately knows nothing about the SDK. Callers pass `load()` per tab, so
 * this file has no opinion on which verb backs a board, no capability checks to
 * keep in sync, and nothing to stub in a test. Type-only imports from the schema
 * package are erased at build time, so bundling this never pulls in zod.
 *
 * SECURITY: every node is built with `createElement` + `textContent`. Usernames
 * and avatar URLs are attacker-controlled. There is no `innerHTML` in this file
 * and there must never be one — a username is rendered on a public board that
 * strangers load.
 */

/**
 * One row of any board. Both `FriendScore` (which carries `isSelf`) and
 * `TopScoreEntry` (which doesn't) satisfy this structurally, so callers can pass
 * SDK results through untouched.
 */
export interface LeaderboardRow {
  uuid: string;
  username: string;
  score: number;
  createdAt: string;
  avatar: string | null;
  metadata: Record<string, unknown> | null;
  isSelf?: boolean;
}

export interface LeaderboardTab {
  /** Stable id, used for `defaultTab` and as the tab's DOM id. */
  id: string;
  /** Tab button text, e.g. `Friends`. */
  label: string;
  /** Shown when the board loads successfully but has no rows. */
  emptyText: string;
  /**
   * Replaces `emptyText` with a blurb and a button when the board is empty —
   * for an empty state that should offer a way out ("nobody you follow has
   * played yet. Invite one?") rather than just stating the fact.
   */
  emptyPrompt?: LeaderboardPrompt | null;
  /**
   * Fetch this board's rows. Resolving `[]` renders `emptyText`; rejecting
   * renders the error state for this tab only, leaving the others usable.
   * Throwing synchronously is treated the same as rejecting — see the call
   * site in {@link createLeaderboardPanel}. Not called when `signInPrompt` is
   * set.
   */
  load(): Promise<LeaderboardRow[]>;
  /**
   * Copy for this tab's error state, replacing the panel's `errorText`. The
   * function form is handed the rejection reason, so a caller that can tell
   * "this host will never serve this board" apart from "the network blipped"
   * can say so — the first is not a "try again".
   */
  errorText?: string | ((error: unknown) => string);
  /**
   * Render a sign-in call to action instead of this board, and skip `load()`.
   *
   * Per-tab rather than per-panel because the boards differ: `scores.friends`
   * needs a follow graph and therefore a session, while `scores.top` is a
   * public read. A signed-out viewer should still get the global board — which
   * is most of the argument for making it public.
   */
  signInPrompt?: LeaderboardPrompt | null;
  /**
   * Right-hand cell for a row — a formatted score, a date, "Solved in 4".
   * Returning `''` omits the cell.
   */
  formatValue(row: LeaderboardRow, index: number): string;
  /**
   * Extra class for the value cell, e.g. to style a loss differently from a
   * win. Appended to `lb-value`; return null for the default.
   */
  valueClass?(row: LeaderboardRow, index: number): string | null | undefined;
  /**
   * Small labels between the name and the value — "18 days", "🔥 7".
   *
   * This is where a signal belongs when it should be visible without steering
   * the ranking. Season boards show days played and streak here precisely
   * because neither survives being a sort key: streak is ties all the way down,
   * and attendance as a primary ranking is farmable by opening the game and
   * losing (§3.7).
   */
  badges?(row: LeaderboardRow, index: number): string[] | null | undefined;
  /**
   * Standard competition ranking, where equal scores share a rank (1, 2, 2, 4).
   * Default `true`. Set `false` for boards ordered by something other than the
   * score — a hall of fame ordered by earliest submission is positional, and
   * sharing ranks there would claim a tie that doesn't exist.
   */
  rankTies?: boolean;
  /**
   * The viewer's own placement, pinned as a separated row under the board when
   * they don't appear in it — the `…  #412 @you` line.
   *
   * Loaded in its own chain, deliberately: a rejection here leaves the board
   * exactly as it was and simply omits the pinned row. Racing it against
   * `load()` in a `Promise.all` would turn a rank failure into a dead board,
   * which is the shape of the original 2048 bug (§2.1).
   *
   * Resolving null means "nothing to pin" — no session, no rank verb on this
   * host, or the viewer hasn't played. Called only when `load()` yields rows,
   * since there is nothing to pin a row *under* otherwise.
   */
  loadPinned?(): Promise<PinnedRank | null>;
  /** Optional node above the list, e.g. a percentile headline or a win count. */
  renderHeader?(rows: LeaderboardRow[]): HTMLElement | null;
}

/** The viewer's placement, for the pinned row. */
export interface PinnedRank {
  /** 1-based rank across the whole board, not just the fetched page. */
  rank: number;
  /** Players on the board. Omit to render a bare `#412` with no "of N". */
  total?: number;
  row: LeaderboardRow;
}

/** A blurb plus one button, used for the sign-in and empty-board states. */
export interface LeaderboardPrompt {
  blurb: string;
  label: string;
  onClick(): void;
}

export interface LeaderboardOptions {
  tabs: LeaderboardTab[];
  /**
   * The viewer's uuid, used to highlight their own row. A row is the viewer's
   * when the backend says so (`isSelf`) or when the uuid matches — public
   * boards have no single viewer, so `scores.top` rows carry no `isSelf` and
   * matching is the only signal.
   */
  viewerUuid?: string | null;
  /**
   * Tab to open on. Default: the first tab that actually has rows — so a viewer
   * who follows nobody, or who isn't signed in, lands on a populated board
   * instead of an empty Friends tab telling them to go make friends.
   *
   * A preference, not a pin. It paints straight away (so a caller holding rows
   * for that board isn't held behind the others' fetches), but if it settles
   * empty or errored while another tab has rows, the panel falls back to that
   * one — the same rule as having named no default at all. A tab showing a
   * sign-in prompt is content and is never fallen back from. Only ever before
   * the viewer has touched the strip; a tab they chose is never overridden.
   */
  defaultTab?: string;
  /** Text while the boards load. */
  loadingText?: string;
  /** Text when a board's `load()` rejects. */
  errorText?: string;
}

export interface LeaderboardPanel {
  element: HTMLElement;
  /**
   * Drops pending renders, so a board whose `load()` resolves after the caller
   * has torn the panel down doesn't paint into detached nodes. Every listener
   * the panel owns lives on `element`, so removing that node releases them.
   * Safe to call twice.
   */
  destroy(): void;
}

const MEDALS = ['🥇', '🥈', '🥉'];
const DEFAULT_LOADING = 'Loading…';
const DEFAULT_ERROR = "Couldn't load the leaderboard. Try again.";

/** Source of unique ids for the tab/tabpanel ARIA wiring. */
let panelSeq = 0;

function el(tag: string, className?: string | null, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Colored-initial circle with the user's photo layered over it. The initial is
 * always painted first and the photo only revealed once it loads, so a 404 or a
 * slow CDN degrades to initials instead of a hole in the row.
 *
 * Hue is derived from the name so a given user keeps the same color everywhere.
 */
export function leaderboardAvatar(name: string, avatarUrl: string | null): HTMLElement {
  const clean = name.replace(/^@/, '');
  const node = el('span', 'lb-avatar');
  let h = 0;
  for (let i = 0; i < clean.length; i++) h = (h * 31 + clean.charCodeAt(i)) >>> 0;
  node.style.background = `hsl(${h % 360} 55% 52%)`;
  node.textContent = (clean.charAt(0) || '?').toUpperCase();

  if (avatarUrl) {
    const img = document.createElement('img');
    img.className = 'lb-avatar-img';
    img.alt = '';
    // One request per row, and boards are now up to 100 rows deep while the
    // list shows about ten at a time — so eager loading would fetch ~90 photos
    // nobody has scrolled to, on a mobile connection, every time a board opens.
    // Lazy loading is measured against the scroll container, which is exactly
    // the bounded `.lb-list`. The initial is painted first either way, so a row
    // that hasn't fetched its photo yet is already complete rather than empty.
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = avatarUrl;
    img.addEventListener('load', () => node.classList.add('lb-avatar-has-img'));
    img.addEventListener('error', () => img.remove());
    node.appendChild(img);
  }
  return node;
}

/**
 * Ranks for a pre-ordered list. Competition ranking when `shareTies`.
 *
 * Exported for tests only — deliberately absent from `src/ui/index.ts`, so it
 * stays off the `window.OddsRabbitUI` surface the vanilla games consume.
 */
export function ranksFor(rows: readonly LeaderboardRow[], shareTies: boolean): number[] {
  const ranks: number[] = [];
  let prevScore: number | null = null;
  let prevRank = 0;
  rows.forEach((row, i) => {
    if (!shareTies) {
      ranks.push(i + 1);
      return;
    }
    const rank = prevScore !== null && row.score === prevScore ? prevRank : i + 1;
    prevScore = row.score;
    prevRank = rank;
    ranks.push(rank);
  });
  return ranks;
}

/**
 * Medals for an already-ranked list: 🥇🥈🥉 for the top three places, but only
 * where the place is held by exactly one row.
 *
 * Competition ranking shares a rank on equal scores, which is right for the
 * NUMBER — four players who all solved in five did all place first — and wrong
 * for the MEDAL. rabbit-words has seven possible daily values and a handful of
 * players a day, so a whole board tying on first is ordinary; four gold medals
 * down a column reads as a rendering bug rather than as a four-way tie. The
 * shared number states the tie plainly, and the medal keeps meaning "nobody
 * else got here", which is what makes it worth showing at all.
 *
 * Boards with `rankTies: false` are unaffected — every rank there is unique by
 * construction.
 *
 * Exported for tests only — deliberately absent from `src/ui/index.ts`, like
 * {@link ranksFor}.
 */
export function medalsFor(ranks: readonly number[]): (string | null)[] {
  const held = new Map<number, number>();
  for (const rank of ranks) held.set(rank, (held.get(rank) ?? 0) + 1);
  return ranks.map((rank) =>
    rank <= MEDALS.length && held.get(rank) === 1 ? MEDALS[rank - 1]! : null
  );
}

/**
 * `OddsRabbit.scores.rank(...)`'s answer as a `PinnedRank`, or null when there
 * is nothing to pin.
 *
 * Structurally typed rather than importing `RoundRank`, so this file keeps its
 * "knows nothing about the SDK" property — a `RoundRank` satisfies it, and so
 * does anything else with the same three fields.
 *
 *     loadPinned: () => OR.scores.rank({ roundKey, order: 'top' }).then(pinnedFromRank)
 */
export function pinnedFromRank(
  result: { rank: number; total: number; entry: LeaderboardRow } | null
): PinnedRank | null {
  if (!result) return null;
  return { rank: result.rank, total: result.total, row: result.entry };
}

function isViewerRow(row: LeaderboardRow, viewerUuid: string | null): boolean {
  if (row.isSelf) return true;
  return viewerUuid !== null && row.uuid === viewerUuid;
}

/**
 * One `<li>`. `rankLabel` is what goes in the rank cell — a medal and a bare
 * number for a row in the list, `#412` for a pinned row, where the `#` says
 * "this is a rank" rather than "this is the next position in the list".
 */
function renderRow(
  row: LeaderboardRow,
  index: number,
  tab: LeaderboardTab,
  rankLabel: string,
  mine: boolean,
  extraClass?: string
): HTMLElement {
  const classes = ['lb-row'];
  if (mine) classes.push('lb-row-you');
  if (extraClass) classes.push(extraClass);
  const li = el('li', classes.join(' '));

  li.appendChild(el('span', 'lb-rank', rankLabel));

  const name = row.username ? `@${row.username}` : 'player';
  li.appendChild(leaderboardAvatar(name, row.avatar));
  li.appendChild(el('span', 'lb-name', mine ? `${name} (you)` : name));

  const badges = tab.badges?.(row, index);
  if (badges && badges.length > 0) {
    const strip = el('span', 'lb-badges');
    badges.forEach((badge) => strip.appendChild(el('span', 'lb-badge', badge)));
    li.appendChild(strip);
  }

  const value = tab.formatValue(row, index);
  if (value !== '') {
    const extra = tab.valueClass?.(row, index);
    li.appendChild(el('span', extra ? `lb-value ${extra}` : 'lb-value', value));
  }
  return li;
}

/**
 * The gap, the viewer's own row, and the field-size note, appended to a list
 * that already holds `boardRows` board rows.
 *
 * Split out of `renderList` so the pinned row — which arrives in its own chain,
 * well after the board is on screen — can be appended to the live list instead
 * of forcing a re-render of rows that haven't changed. Both paths build the
 * same nodes, so a tab switched away from and back rebuilds identically.
 */
function appendPinned(
  list: HTMLElement,
  pinned: PinnedRank,
  tab: LeaderboardTab,
  boardRows: number
): void {
  // The gap says "further down the same board". When the viewer is the very
  // next row it would be claiming a stretch of board that isn't there — and
  // with no gap to break, there is no separation for `.lb-row-pinned` to
  // reinstate either, so the row is left to read as what it is.
  const gapped = pinned.rank > boardRows + 1;
  if (gapped) {
    const gap = el('li', 'lb-row-gap');
    gap.setAttribute('aria-hidden', 'true');
    gap.appendChild(el('span', 'lb-gap-mark', '⋯'));
    list.appendChild(gap);
  }

  // Index continues past the rendered page rather than restarting at 0: the
  // tab's `badges`/`formatValue` hooks are handed a position, and handing
  // them 0 would tell a hall-of-fame board this is the first-ever solve.
  list.appendChild(
    renderRow(
      pinned.row,
      boardRows,
      tab,
      `#${pinned.rank}`,
      true,
      gapped ? 'lb-row-pinned' : undefined
    )
  );

  if (typeof pinned.total === 'number' && pinned.total > 0) {
    const note = el('li', 'lb-pinned-note');
    const players = pinned.total === 1 ? 'player' : 'players';
    note.textContent = `of ${pinned.total.toLocaleString()} ${players}`;
    list.appendChild(note);
  }
}

function renderList(
  rows: readonly LeaderboardRow[],
  tab: LeaderboardTab,
  viewerUuid: string | null,
  pinned: PinnedRank | null
): HTMLElement {
  const list = el('ul', 'lb-list');
  const ranks = ranksFor(rows, tab.rankTies !== false);
  const medals = medalsFor(ranks);

  rows.forEach((row, i) => {
    const rank = ranks[i] ?? i + 1;
    list.appendChild(
      renderRow(
        row,
        i,
        tab,
        medals[i] ?? String(rank),
        isViewerRow(row, viewerUuid),
        undefined
      )
    );
  });

  // The viewer's own placement, when they didn't make the page above. Only on
  // a re-render — on first arrival it is appended to the live list instead.
  if (pinned) appendPinned(list, pinned, tab, rows.length);
  return list;
}

type TabState =
  // `pinned` is filled in later and in its own chain — the board renders as
  // soon as its rows land, and the viewer's placement appends underneath if and
  // when it arrives.
  | { status: 'ok'; rows: LeaderboardRow[]; pinned: PinnedRank | null }
  | { status: 'signin' }
  | { status: 'error'; error: unknown };

/** A tab's own error copy when it has one, else the panel's. */
function errorTextFor(tab: LeaderboardTab, error: unknown, fallback: string): string {
  const own =
    typeof tab.errorText === 'function' ? tab.errorText(error) : tab.errorText;
  return own || fallback;
}

function renderPrompt(prompt: LeaderboardPrompt): HTMLElement {
  const cta = el('div', 'lb-cta');
  cta.appendChild(el('p', 'lb-cta-blurb', prompt.blurb));
  const btn = el('button', 'lb-cta-btn', prompt.label) as HTMLButtonElement;
  btn.type = 'button';
  btn.addEventListener('click', () => prompt.onClick());
  cta.appendChild(btn);
  return cta;
}

/**
 * Build a tabbed leaderboard panel.
 *
 * Every tab's `load()` fires immediately and in parallel, rather than lazily on
 * first click. That isn't just latency: `defaultTab` defaults to the first tab
 * with rows, which can't be decided until every board has answered.
 */
export function createLeaderboardPanel(options: LeaderboardOptions): LeaderboardPanel {
  const {
    tabs,
    viewerUuid = null,
    defaultTab,
    loadingText = DEFAULT_LOADING,
    errorText = DEFAULT_ERROR,
  } = options;

  const root = el('div', 'lb-panel');
  let destroyed = false;

  if (tabs.length === 0) {
    root.appendChild(el('p', 'lb-empty', errorText));
    return { element: root, destroy: () => { destroyed = true; } };
  }

  const domId = `lb-${++panelSeq}`;
  const body = el('div', 'lb-body');
  body.id = `${domId}-panel`;
  body.appendChild(el('p', 'lb-loading', loadingText));
  root.appendChild(body);

  // Announces the pinned row, which lands after the board has already been
  // rendered and read. A dedicated empty region rather than `aria-live` on the
  // list itself: the list is rebuilt on every tab switch, and a live region
  // that already holds text when it enters the DOM is announced inconsistently
  // across screen readers — sometimes re-reading the whole board.
  const announcer = el('div', 'lb-sr-only');
  announcer.setAttribute('role', 'status');
  root.appendChild(announcer);

  // A tab whose load rejects becomes `{status:'error'}` rather than taking the
  // whole panel down — one dead board should not blank the others.
  const states = new Map<string, TabState>();
  const tabButtons = new Map<string, HTMLButtonElement>();
  const hasStrip = tabs.length > 1;
  let activeId: string | null = null;
  // Set once the viewer picks a tab themselves. From then on the panel never
  // moves them — the empty-default fallback below is a correction to a guess
  // the panel made, not a licence to override a choice the viewer made.
  let userSelected = false;

  const showTab = (id: string): void => {
    if (destroyed) return;
    activeId = id;
    const tab = tabs.find((t) => t.id === id);
    body.textContent = '';
    if (!tab) return;

    const state = states.get(id);
    if (!state) {
      // Selected before its load settled — the tab's own promise re-renders it.
      body.appendChild(el('p', 'lb-loading', loadingText));
    } else if (state.status === 'signin') {
      body.appendChild(renderPrompt(tab.signInPrompt!));
    } else if (state.status === 'error') {
      body.appendChild(
        el('p', 'lb-empty', errorTextFor(tab, state.error, errorText))
      );
    } else if (state.rows.length === 0) {
      body.appendChild(
        tab.emptyPrompt
          ? renderPrompt(tab.emptyPrompt)
          : el('p', 'lb-empty', tab.emptyText)
      );
    } else {
      const header = tab.renderHeader?.(state.rows);
      if (header) body.appendChild(header);
      body.appendChild(renderList(state.rows, tab, viewerUuid, state.pinned));
    }

    // A tabpanel is a tab stop only when it holds nothing focusable itself —
    // a board that renders a sign-in button would otherwise cost two Tab
    // presses to get to that button. Recomputed per render because the same
    // panel swings between a plain list and a CTA.
    if (hasStrip) {
      body.tabIndex = body.querySelector('button, a[href], [tabindex]') ? -1 : 0;
    }

    // Roving tabindex: Tab reaches the strip once and lands on the selected
    // board, then Left/Right move between them.
    tabButtons.forEach((btn, tabId) => {
      const selected = tabId === id;
      btn.classList.toggle('lb-tab-active', selected);
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
      btn.tabIndex = selected ? 0 : -1;
      if (selected) body.setAttribute('aria-labelledby', btn.id);
    });
  };

  // Automatic activation — focus moves and the board follows. Every board is
  // already loaded by the time the strip is usable, so there is nothing to be
  // gained by making the user press Enter as well.
  const onStripKey = (e: KeyboardEvent, index: number): void => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    let next: number;
    if (step !== 0) next = (index + step + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    const target = tabs[next]!;
    userSelected = true;
    showTab(target.id);
    tabButtons.get(target.id)?.focus();
  };

  // Only draw the tab strip for a real choice. A single-tab panel — words until
  // its season board lands — should read as a plain list.
  if (hasStrip) {
    const strip = el('div', 'lb-tabs');
    strip.setAttribute('role', 'tablist');
    // The body is a real tabpanel only when there is a tablist to own it. A
    // single-board panel gets no orphaned role: a `tab`/`tabpanel` pair with no
    // sibling to switch to is worse for a screen reader than plain markup.
    body.setAttribute('role', 'tabpanel');
    tabs.forEach((tab, i) => {
      const btn = el('button', 'lb-tab', tab.label) as HTMLButtonElement;
      btn.type = 'button';
      btn.id = `${domId}-tab-${i}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('data-tab-id', tab.id);
      btn.setAttribute('aria-controls', body.id);
      btn.setAttribute('aria-selected', 'false');
      btn.tabIndex = -1;
      btn.addEventListener('click', () => {
        userSelected = true;
        showTab(tab.id);
      });
      btn.addEventListener('keydown', (e) => onStripKey(e, i));
      tabButtons.set(tab.id, btn);
      strip.appendChild(btn);
    });
    root.insertBefore(strip, body);
  }

  /**
   * Fetch and append the viewer's own placement, once this tab's rows are in.
   *
   * Skipped entirely when the viewer is already on the board — their row is
   * there and highlighted, and pinning a second copy of it underneath would be
   * worse than pinning nothing. That also means the common case for a friends
   * board costs no request at all.
   *
   * Never rejects outward: a rank that fails leaves the board exactly as it
   * rendered, minus one row.
   */
  const loadPinnedFor = (tab: LeaderboardTab, state: TabState): void => {
    if (!tab.loadPinned) return;
    if (state.status !== 'ok' || state.rows.length === 0) return;
    if (state.rows.some((row) => isViewerRow(row, viewerUuid))) return;

    void Promise.resolve()
      .then(() => tab.loadPinned!())
      .then((pinned) => {
        if (destroyed || !pinned) return;
        state.pinned = pinned;
        if (activeId !== tab.id) return;
        // Append to the list already on screen rather than re-rendering it.
        // The board itself hasn't changed, and rebuilding every row to add
        // three nodes underneath them is work and flicker for nothing.
        const list = body.querySelector('ul.lb-list');
        if (list instanceof HTMLElement) {
          appendPinned(list, pinned, tab, state.rows.length);
        } else {
          showTab(tab.id);
        }
        announcer.textContent = pinned.total
          ? `You are ranked ${pinned.rank} of ${pinned.total}.`
          : `You are ranked ${pinned.rank}.`;
      })
      .catch((error: unknown) => {
        // The board is already on screen and correct; the viewer simply isn't
        // told where they placed. Warned rather than swallowed outright — a
        // malformed rank is a host contract bug, and the SDK raises it on
        // purpose, so silence here would make it invisible from both ends.
        console.warn(`leaderboard: pinned rank for tab "${tab.id}" failed`, error);
      });
  };

  const settled = tabs.map((tab): Promise<TabState> => {
    const result: Promise<TabState> = tab.signInPrompt
      ? Promise.resolve<TabState>({ status: 'signin' })
      : // `load()` is invoked inside the chain so a SYNCHRONOUS throw lands in
        // the same error state as a rejection. Called bare it would escape this
        // constructor and take down whatever the caller was mid-render — for
        // solitaire that is the win overlay, which hadn't been shown yet.
        Promise.resolve()
          .then(() => tab.load())
          .then((rows): TabState => ({ status: 'ok', rows, pinned: null }))
          .catch((error: unknown): TabState => ({ status: 'error', error }));
    return result.then((state) => {
      states.set(tab.id, state);
      if (activeId === tab.id) showTab(tab.id);
      loadPinnedFor(tab, state);
      return state;
    });
  });

  // An explicit `defaultTab` paints straight away, so a caller that already
  // holds the rows for that board (an end-game screen that just fetched its
  // friends list) isn't held behind the other tabs' network calls.
  const requested = defaultTab
    ? tabs.find((tab) => tab.id === defaultTab)
    : undefined;
  if (requested) showTab(requested.id);

  // "First tab with rows" is the rule, and it genuinely can't be applied until
  // every board has answered.
  //
  // It also runs when a `defaultTab` WAS named but settled dead — no rows, or an
  // error. The caller named that tab expecting content; landing the viewer on a
  // dead board because the guess missed is the failure §3.4 exists to prevent,
  // and it is worth correcting even though the correction moves the selection.
  // Nothing moves once the viewer has picked a tab, and nothing moves if there
  // is no populated board to move to.
  //
  // A sign-in prompt is NOT dead and is left alone. It is the one non-`ok` state
  // that renders something the caller deliberately configured — a blurb and a
  // button — so a caller who points a signed-out viewer at Friends gets the
  // prompt they asked for rather than being silently rerouted to a board that
  // needs no session. Empty and errored say "there is nothing here"; a sign-in
  // prompt says "here is what to do next", which is content.
  void Promise.all(settled).then(() => {
    if (destroyed || userSelected) return;
    const active = activeId !== null ? states.get(activeId) : undefined;
    if (active?.status === 'signin') return;
    if (active?.status === 'ok' && active.rows.length > 0) return;
    const populated = tabs.find((tab) => {
      const state = states.get(tab.id);
      return state?.status === 'ok' && state.rows.length > 0;
    });
    // No populated board anywhere: keep whatever the caller asked for, since
    // its empty copy is likelier to be the apt one.
    if (!populated) {
      if (activeId === null) showTab(tabs[0]!.id);
      return;
    }
    showTab(populated.id);
  });

  return {
    element: root,
    destroy: () => {
      destroyed = true;
    },
  };
}

export interface LeaderboardModalOptions extends LeaderboardOptions {
  /** Modal heading and `aria-label`. Default `Leaderboard`. */
  title?: string;
  /** Runs after the modal is removed, however it was dismissed. */
  onClose?(): void;
}

export interface LeaderboardModal {
  close(): void;
}

/**
 * The live modal, so a second open can close the first properly instead of just
 * pulling its node out of the DOM. Yanking the node left the old instance's
 * `keydown` handler on `document`: the next Escape ran its `close()`, fired its
 * `onClose`, and called `focus()` on an element that no longer existed — which
 * drops focus to `<body>` rather than back to whatever opened the dialog.
 */
let liveModal: LeaderboardModal | null = null;

/**
 * Open the panel in a modal. Escape, the close button, and a click on the
 * backdrop all dismiss it; focus moves to the close button on open and returns
 * to whatever had it before, so a keyboard user isn't dumped at the top of the
 * document.
 */
export function openLeaderboardModal(
  options: LeaderboardModalOptions
): LeaderboardModal {
  const { title = 'Leaderboard', onClose, ...panelOptions } = options;

  // One at a time — a second open replaces the first rather than stacking two
  // dialogs with the same aria-modal. Close it through its own `close()` so it
  // unbinds and settles its focus first; only then read `activeElement`, or the
  // new modal would capture the old modal's close button as its return target.
  liveModal?.close();
  // Belt and braces for a backdrop this module doesn't have a handle on (an
  // older bundle, or a caller that removed the node itself).
  document.querySelectorAll('.lb-backdrop').forEach((node) => node.remove());

  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const backdrop = el('div', 'lb-backdrop');
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', title);

  const modal = el('div', 'lb-modal');
  const header = el('div', 'lb-modal-header');
  header.appendChild(el('h2', 'lb-modal-title', title));

  const closeBtn = el('button', 'lb-close', '×') as HTMLButtonElement;
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const panel = createLeaderboardPanel(panelOptions);
  modal.appendChild(panel.element);
  backdrop.appendChild(modal);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (liveModal === handle) liveModal = null;
    document.removeEventListener('keydown', onKey);
    panel.destroy();
    backdrop.remove();
    previousFocus?.focus();
    onClose?.();
  };
  const handle: LeaderboardModal = { close };
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }

  document.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  document.body.appendChild(backdrop);
  closeBtn.focus();

  liveModal = handle;
  return handle;
}
