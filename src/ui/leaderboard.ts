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
  /** Optional node above the list, e.g. a percentile headline or a win count. */
  renderHeader?(rows: LeaderboardRow[]): HTMLElement | null;
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
    img.src = avatarUrl;
    img.addEventListener('load', () => node.classList.add('lb-avatar-has-img'));
    img.addEventListener('error', () => img.remove());
    node.appendChild(img);
  }
  return node;
}

/** Ranks for a pre-ordered list. Competition ranking when `shareTies`. */
function ranksFor(rows: readonly LeaderboardRow[], shareTies: boolean): number[] {
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

function isViewerRow(row: LeaderboardRow, viewerUuid: string | null): boolean {
  if (row.isSelf) return true;
  return viewerUuid !== null && row.uuid === viewerUuid;
}

function renderList(
  rows: readonly LeaderboardRow[],
  tab: LeaderboardTab,
  viewerUuid: string | null
): HTMLElement {
  const list = el('ul', 'lb-list');
  const ranks = ranksFor(rows, tab.rankTies !== false);

  rows.forEach((row, i) => {
    const mine = isViewerRow(row, viewerUuid);
    const li = el('li', mine ? 'lb-row lb-row-you' : 'lb-row');

    const rank = ranks[i] ?? i + 1;
    const medal = rank <= MEDALS.length ? MEDALS[rank - 1] : undefined;
    li.appendChild(el('span', 'lb-rank', medal ?? String(rank)));

    const name = row.username ? `@${row.username}` : 'player';
    li.appendChild(leaderboardAvatar(name, row.avatar));
    li.appendChild(el('span', 'lb-name', mine ? `${name} (you)` : name));

    const badges = tab.badges?.(row, i);
    if (badges && badges.length > 0) {
      const strip = el('span', 'lb-badges');
      badges.forEach((badge) => strip.appendChild(el('span', 'lb-badge', badge)));
      li.appendChild(strip);
    }

    const value = tab.formatValue(row, i);
    if (value !== '') {
      const extra = tab.valueClass?.(row, i);
      li.appendChild(el('span', extra ? `lb-value ${extra}` : 'lb-value', value));
    }

    list.appendChild(li);
  });
  return list;
}

type TabState =
  | { status: 'ok'; rows: LeaderboardRow[] }
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

  // A tab whose load rejects becomes `{status:'error'}` rather than taking the
  // whole panel down — one dead board should not blank the others.
  const states = new Map<string, TabState>();
  const tabButtons = new Map<string, HTMLButtonElement>();
  const hasStrip = tabs.length > 1;
  let activeId: string | null = null;

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
      body.appendChild(renderList(state.rows, tab, viewerUuid));
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
      btn.addEventListener('click', () => showTab(tab.id));
      btn.addEventListener('keydown', (e) => onStripKey(e, i));
      tabButtons.set(tab.id, btn);
      strip.appendChild(btn);
    });
    root.insertBefore(strip, body);
  }

  const settled = tabs.map((tab): Promise<TabState> => {
    const result: Promise<TabState> = tab.signInPrompt
      ? Promise.resolve<TabState>({ status: 'signin' })
      : // `load()` is invoked inside the chain so a SYNCHRONOUS throw lands in
        // the same error state as a rejection. Called bare it would escape this
        // constructor and take down whatever the caller was mid-render — for
        // solitaire that is the win overlay, which hadn't been shown yet.
        Promise.resolve()
          .then(() => tab.load())
          .then((rows): TabState => ({ status: 'ok', rows }))
          .catch((error: unknown): TabState => ({ status: 'error', error }));
    return result.then((state) => {
      states.set(tab.id, state);
      if (activeId === tab.id) showTab(tab.id);
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

  // Without one, "first tab with rows" is the rule — and that genuinely can't
  // be decided until every board has answered.
  void Promise.all(settled).then(() => {
    if (destroyed || activeId !== null) return;
    const populated = tabs.find((tab) => {
      const state = states.get(tab.id);
      return state?.status === 'ok' && state.rows.length > 0;
    });
    showTab((populated ?? tabs[0]!).id);
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
