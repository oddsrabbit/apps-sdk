import type { FriendScore, OddsRabbitGlobal } from '../../src/sdk/sdk';
import { ANSWERS, isValidGuess } from './words';

declare global {
  interface Window {
    OddsRabbit: OddsRabbitGlobal;
  }
}

const ROW_COUNT = 6;
const COL_COUNT = 5;
// 2026-05-08 UTC midnight is `puzzleIndex` 0; we display it as #1.
const EPOCH_MS = Date.UTC(2026, 4, 8);
const DAY_MS = 86_400_000;

type TileColor = 'green' | 'yellow' | 'gray';

interface State {
  puzzleIndex: number;
  answer: string;
  guesses: string[];
  status: 'in_progress' | 'won' | 'lost';
}

interface Stats {
  played: number;
  wins: number;
  distribution: [number, number, number, number, number, number];
}

interface Streak {
  current: number;
  max: number;
  lastPlayedPuzzleIndex: number | null;
}

const DEFAULT_STATS: Stats = { played: 0, wins: 0, distribution: [0, 0, 0, 0, 0, 0] };
const DEFAULT_STREAK: Streak = { current: 0, max: 0, lastPlayedPuzzleIndex: null };

// Bucket keys submitted to / read from aggregate.count. Order matters for the
// distribution chart — labels under each bar follow this sequence.
const DISTRIBUTION_BUCKETS = [
  'won-1', 'won-2', 'won-3', 'won-4', 'won-5', 'won-6', 'lost',
] as const;
type DistributionBucket = typeof DISTRIBUTION_BUCKETS[number];

// `null` per bucket = below the k=5 anonymity floor on the aggregate API.
// We render those as zero-width bars without leaking the "1..4 players" range.
type CommunityData = {
  buckets: Record<DistributionBucket, number | null>;
};

// ---------- Module-level UI state ----------

let currentState: State;
let currentStats: Stats = DEFAULT_STATS;
let currentStreak: Streak = DEFAULT_STREAK;
let currentCommunity: CommunityData | undefined;
let currentFriends: FriendScore[] | undefined;
let currentInput = '';

// One-shot animation flags. Set when an event happens (submit, keystroke);
// consumed by the next `render()` and then cleared, so subsequent re-renders
// (which happen on every keystroke since the DOM is fully rebuilt) don't
// replay flip/bounce/pop animations on already-revealed tiles.
let lastRevealedRow: number | null = null;
let lastFilledColumn: number | null = null;

// ---------- Pure helpers ----------

function todayPuzzleIndex(): number {
  return Math.floor((Date.now() - EPOCH_MS) / DAY_MS);
}

function pickAnswer(index: number): string {
  return ANSWERS[index % ANSWERS.length] ?? ANSWERS[0]!;
}

function scoreGuess(guess: string, answer: string): TileColor[] {
  const result: TileColor[] = Array.from({ length: COL_COUNT }, () => 'gray');
  const remaining = answer.split('');
  for (let i = 0; i < COL_COUNT; i++) {
    if (guess[i] === remaining[i]) {
      result[i] = 'green';
      remaining[i] = '';
    }
  }
  for (let i = 0; i < COL_COUNT; i++) {
    if (result[i] === 'green') continue;
    const idx = remaining.indexOf(guess[i] ?? '');
    if (idx >= 0) {
      result[i] = 'yellow';
      remaining[idx] = '';
    }
  }
  return result;
}

function emojiForColor(color: TileColor): string {
  return color === 'green' ? '🟩' : color === 'yellow' ? '🟨' : '⬛';
}

function buildShareGrid(state: State): string {
  return state.guesses
    .map((g) => scoreGuess(g, state.answer).map(emojiForColor).join(''))
    .join('\n');
}

function freshState(): State {
  const index = todayPuzzleIndex();
  return {
    puzzleIndex: index,
    answer: pickAnswer(index),
    guesses: [],
    status: 'in_progress',
  };
}

async function loadState(): Promise<State> {
  try {
    const raw = await window.OddsRabbit.storage.get('today');
    if (!raw) return freshState();
    const parsed = JSON.parse(raw) as State;
    if (parsed.puzzleIndex !== todayPuzzleIndex()) return freshState();
    return parsed;
  } catch {
    return freshState();
  }
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await window.OddsRabbit.storage.get(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  // Symmetric with readJson: swallow bridge errors (e.g. storage/unauthorized
  // when the host degraded to anonymous mode) so an unhandled rejection in
  // submitGuess can't strand the UI mid-render. Read paths already fall back
  // to defaults; writes just become best-effort.
  try {
    await window.OddsRabbit.storage.set(key, JSON.stringify(value));
  } catch {
    /* best-effort */
  }
}

function applyResultToStats(stats: Stats, state: State): Stats {
  const next: Stats = {
    played: stats.played + 1,
    wins: stats.wins + (state.status === 'won' ? 1 : 0),
    distribution: [...stats.distribution] as Stats['distribution'],
  };
  if (state.status === 'won') {
    const i = state.guesses.length - 1;
    if (i >= 0 && i < 6) next.distribution[i] = (next.distribution[i] ?? 0) + 1;
  }
  return next;
}

function applyResultToStreak(streak: Streak, state: State): Streak {
  if (state.status === 'won') {
    const consecutive =
      streak.lastPlayedPuzzleIndex === state.puzzleIndex - 1
        ? streak.current + 1
        : 1;
    return {
      current: consecutive,
      max: Math.max(streak.max, consecutive),
      lastPlayedPuzzleIndex: state.puzzleIndex,
    };
  }
  return {
    current: 0,
    max: streak.max,
    lastPlayedPuzzleIndex: state.puzzleIndex,
  };
}

function formatPuzzleDate(puzzleIndex: number): string {
  const date = new Date(EPOCH_MS + puzzleIndex * DAY_MS);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

// ---------- Rendering ----------

const root = document.getElementById('root')!;

function render(): void {
  root.innerHTML = '';
  root.appendChild(renderPuzzleHeader(currentState));
  root.appendChild(renderBoard(currentState));
  if (currentState.status === 'in_progress') {
    root.appendChild(renderKeyboard(currentState));
  } else {
    root.appendChild(
      renderEndGame(
        currentState,
        currentStats,
        currentStreak,
        currentCommunity,
        currentFriends
      )
    );
  }
  root.appendChild(renderResetTime());

  // Animations are one-shot. Clear the flags AFTER rendering so they apply
  // to this paint exactly once and aren't re-applied on the next render.
  lastRevealedRow = null;
  lastFilledColumn = null;
}

function renderPuzzleHeader(state: State): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'puzzle-header';

  const meta = document.createElement('div');
  meta.className = 'puzzle-meta';
  meta.innerHTML = `
    <span class="puzzle-number">Puzzle #${state.puzzleIndex + 1}</span>
    <span class="puzzle-date">${escapeHtml(formatPuzzleDate(state.puzzleIndex))}</span>
  `;

  const help = document.createElement('button');
  help.type = 'button';
  help.className = 'help-btn';
  help.setAttribute('aria-label', 'How to play');
  help.textContent = '?';
  help.addEventListener('click', () => showInstructions());

  wrap.appendChild(meta);
  wrap.appendChild(help);
  return wrap;
}

function renderBoard(state: State): HTMLElement {
  const board = document.createElement('div');
  board.className = 'board';

  const activeRowIndex =
    state.status === 'in_progress' ? state.guesses.length : -1;

  for (let row = 0; row < ROW_COUNT; row++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'board-row';
    rowEl.dataset.row = String(row);

    const guess = state.guesses[row];
    const colors = guess ? scoreGuess(guess, state.answer) : null;

    if (row === activeRowIndex) rowEl.classList.add('row-active');
    if (row === lastRevealedRow) rowEl.classList.add('row-revealed');
    // Win bounce gates on `lastRevealedRow` too — only animate on the
    // submission render, not on reload or on subsequent typing-driven renders.
    if (state.status === 'won' && row === lastRevealedRow) {
      rowEl.classList.add('row-win');
    }

    for (let col = 0; col < COL_COUNT; col++) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.style.setProperty('--col', String(col));

      let letter = guess?.[col] ?? '';
      if (row === activeRowIndex) letter = currentInput[col] ?? '';
      tile.textContent = letter;

      if (colors) {
        tile.dataset.color = colors[col];
        tile.setAttribute(
          'aria-label',
          `${guess?.[col] ?? ''}, ${colors[col] === 'green' ? 'correct' : colors[col] === 'yellow' ? 'present' : 'absent'}`
        );
      } else if (letter) {
        tile.classList.add('tile-filled');
        // Pop animation only on the freshly-typed tile, not on every previously
        // typed tile in the row.
        if (row === activeRowIndex && col === lastFilledColumn) {
          tile.classList.add('tile-just-filled');
        }
      }

      rowEl.appendChild(tile);
    }
    board.appendChild(rowEl);
  }

  return board;
}

const KEYBOARD_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', '↵ZXCVBNM⌫'];

function computeKeyboardState(state: State): Map<string, TileColor> {
  const priority: Record<TileColor, number> = { gray: 0, yellow: 1, green: 2 };
  const keys = new Map<string, TileColor>();
  for (const guess of state.guesses) {
    const colors = scoreGuess(guess, state.answer);
    for (let i = 0; i < guess.length; i++) {
      const letter = guess[i]!;
      const color = colors[i]!;
      const existing = keys.get(letter);
      if (!existing || priority[color] > priority[existing]) {
        keys.set(letter, color);
      }
    }
  }
  return keys;
}

function renderKeyboard(state: State): HTMLElement {
  const colorMap = computeKeyboardState(state);
  const kb = document.createElement('div');
  kb.className = 'keyboard';

  for (const row of KEYBOARD_ROWS) {
    const rowEl = document.createElement('div');
    rowEl.className = 'keyboard-row';
    for (const ch of row) {
      const key = document.createElement('button');
      key.type = 'button';
      key.className = 'keyboard-key';

      if (ch === '↵') {
        key.classList.add('keyboard-key-wide');
        key.dataset.action = 'submit';
        key.textContent = 'Enter';
      } else if (ch === '⌫') {
        key.classList.add('keyboard-key-wide');
        key.dataset.action = 'backspace';
        key.textContent = '⌫';
        key.setAttribute('aria-label', 'Backspace');
      } else {
        key.dataset.action = 'letter';
        key.dataset.letter = ch;
        key.textContent = ch;
        const color = colorMap.get(ch);
        if (color) key.dataset.color = color;
      }

      rowEl.appendChild(key);
    }
    kb.appendChild(rowEl);
  }

  kb.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest(
      '.keyboard-key'
    ) as HTMLButtonElement | null;
    if (!target) return;

    switch (target.dataset.action) {
      case 'letter':
        pushChar(target.dataset.letter ?? '');
        return;
      case 'backspace':
        popChar();
        return;
      case 'submit':
        attemptSubmit();
        return;
    }
  });

  return kb;
}

function renderEndGame(
  state: State,
  stats: Stats,
  streak: Streak,
  community?: CommunityData,
  friends?: FriendScore[]
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'end-game';
  wrap.setAttribute('role', 'status');

  const verdict = document.createElement('p');
  verdict.className = 'verdict';
  if (state.status === 'won') {
    verdict.textContent = `Solved in ${state.guesses.length}/6.`;
  } else {
    verdict.innerHTML = `Out of guesses. Word was <strong>${escapeHtml(state.answer)}</strong>.`;
  }
  wrap.appendChild(verdict);

  // Today's distribution (community) — puzzle-specific stats first since
  // they're the most time-sensitive context for the result.
  if (community) {
    wrap.appendChild(renderCommunityDistribution(state, community));
  }

  // Friends panel — the social heart. Always render (handles anon + empty
  // states internally) so signed-out users still see the sign-in CTA.
  wrap.appendChild(renderFriendsPanel(friends));

  // Personal lifetime stats below — less urgent than the round-specific
  // community + friends data above.
  const statsRow = document.createElement('div');
  statsRow.className = 'stats-row';
  const winPct = stats.played > 0 ? Math.round((stats.wins / stats.played) * 100) : 0;
  const cells: Array<[string, string]> = [
    ['Played', String(stats.played)],
    ['Win %', String(winPct)],
    ['Streak', String(streak.current)],
    ['Best', String(streak.max)],
  ];
  for (const [label, value] of cells) {
    const cell = document.createElement('div');
    cell.className = 'stat-cell';
    cell.innerHTML = `<div class="stat-value">${escapeHtml(value)}</div><div class="stat-label">${escapeHtml(label)}</div>`;
    statsRow.appendChild(cell);
  }
  wrap.appendChild(statsRow);

  // Personal lifetime guess distribution
  const histTitle = document.createElement('h3');
  histTitle.className = 'hist-title';
  histTitle.textContent = 'Your Distribution';
  wrap.appendChild(histTitle);

  const hist = document.createElement('div');
  hist.className = 'histogram';
  const max = Math.max(1, ...stats.distribution);
  const winRow = state.status === 'won' ? state.guesses.length : -1;
  for (let i = 0; i < ROW_COUNT; i++) {
    const count = stats.distribution[i] ?? 0;
    const bar = document.createElement('div');
    bar.className = 'hist-bar';
    if (i + 1 === winRow) bar.classList.add('hist-bar-current');

    const label = document.createElement('span');
    label.className = 'hist-label';
    label.textContent = String(i + 1);

    const fill = document.createElement('div');
    fill.className = 'hist-fill';
    fill.style.width = `${Math.max(8, (count / max) * 100)}%`;
    fill.textContent = String(count);

    bar.appendChild(label);
    bar.appendChild(fill);
    hist.appendChild(bar);
  }
  wrap.appendChild(hist);

  const share = document.createElement('button');
  share.type = 'button';
  share.className = 'share-btn';
  share.textContent = 'Share result';
  share.addEventListener('click', () => void shareResult(state));
  wrap.appendChild(share);

  return wrap;
}

function renderCommunityDistribution(
  state: State,
  community: CommunityData
): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'community-distribution';

  const title = document.createElement('h3');
  title.className = 'hist-title';
  title.textContent = "Today's Distribution";
  wrap.appendChild(title);

  // Treat below-k=5-floor buckets as 0 for display — they render as empty
  // bars without revealing the 1..4-player range. Distinct from "literally
  // zero players got 1-guess" only in semantics, not pixels.
  const counts = DISTRIBUTION_BUCKETS.map((b) => community.buckets[b] ?? 0);
  const total = counts.reduce((a, b) => a + b, 0);

  if (total === 0) {
    const empty = document.createElement('p');
    empty.className = 'community-empty';
    empty.textContent = 'Stats unlock once a few more players finish today.';
    wrap.appendChild(empty);
    return wrap;
  }

  const userBucket = bucketForState(state);
  const max = Math.max(1, ...counts);

  const hist = document.createElement('div');
  hist.className = 'histogram community-hist';
  DISTRIBUTION_BUCKETS.forEach((bucket, i) => {
    const count = counts[i] ?? 0;
    const pct = Math.round((count / total) * 100);

    const bar = document.createElement('div');
    bar.className = 'hist-bar';
    if (bucket === userBucket) bar.classList.add('hist-bar-current');

    const label = document.createElement('span');
    label.className = 'hist-label';
    // Display label: 1..6 for won-N, "X" for lost — matches the share-grid
    // convention ("X/6").
    label.textContent = bucket === 'lost' ? 'X' : bucket.slice(-1);

    const fill = document.createElement('div');
    fill.className = 'hist-fill';
    fill.style.width = `${Math.max(8, (count / max) * 100)}%`;
    fill.textContent = `${pct}%`;

    bar.appendChild(label);
    bar.appendChild(fill);
    hist.appendChild(bar);
  });
  wrap.appendChild(hist);

  return wrap;
}

function renderFriendsPanel(friends?: FriendScore[]): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'friends-panel';

  const title = document.createElement('h3');
  title.className = 'hist-title';
  title.textContent = 'Friends';
  wrap.appendChild(title);

  // Anonymous: sign-in CTA. Use requestSignIn — the host shows the prompt at
  // a natural friction moment (end-of-round), per the SDK guidance.
  if (!window.OddsRabbit.user) {
    const cta = document.createElement('div');
    cta.className = 'friends-cta';

    const blurb = document.createElement('p');
    blurb.className = 'friends-cta-blurb';
    blurb.textContent = 'Sign in to see how people you follow are doing today.';
    cta.appendChild(blurb);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'friends-cta-btn';
    btn.textContent = 'Sign in';
    btn.addEventListener('click', () => {
      void window.OddsRabbit.actions.requestSignIn(
        'See how your friends did today'
      );
    });
    cta.appendChild(btn);
    wrap.appendChild(cta);
    return wrap;
  }

  if (!friends || friends.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'friends-empty';
    empty.textContent = "None of the people you follow have played today.";
    wrap.appendChild(empty);
    return wrap;
  }

  const list = document.createElement('ul');
  list.className = 'friends-list';
  for (const friend of friends) {
    const li = document.createElement('li');
    li.className = 'friends-row';

    // App-specific metadata shape — rabbit-words submits `{ won, guessCount }`.
    // Falling back to score-based inference keeps this resilient if a future
    // migration drops the metadata.
    const meta = friend.metadata as
      | { won?: boolean; guessCount?: number }
      | null;
    const won = meta?.won ?? friend.score > 0;
    const guessCount = meta?.guessCount;

    const name = document.createElement('span');
    name.className = 'friends-name';
    name.textContent = `@${friend.username}`;
    li.appendChild(name);

    const result = document.createElement('span');
    result.className = 'friends-result';
    if (won && typeof guessCount === 'number') {
      result.textContent = `Solved in ${guessCount}`;
    } else if (won) {
      result.textContent = 'Solved';
    } else {
      result.textContent = "Didn't solve";
      result.classList.add('friends-result-lost');
    }
    li.appendChild(result);
    list.appendChild(li);
  }
  wrap.appendChild(list);

  return wrap;
}

function nextResetMs(): number {
  const now = new Date();
  const nextMidnightUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  );
  return nextMidnightUtc - now.getTime();
}

function formatTimeUntilReset(): string {
  const ms = Math.max(0, nextResetMs());
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `Next puzzle in ${hours}h ${minutes}m`;
  return `Next puzzle in ${minutes}m`;
}

function renderResetTime(): HTMLElement {
  const el = document.createElement('p');
  el.className = 'reset-time';
  el.textContent = formatTimeUntilReset();

  const interval = window.setInterval(() => {
    if (!el.isConnected) {
      window.clearInterval(interval);
      return;
    }
    el.textContent = formatTimeUntilReset();
  }, 60_000);

  return el;
}

// ---------- Toast / shake / modal ----------

function showToast(message: string): void {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'alert');
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('toast-show'));

  window.setTimeout(() => {
    toast.classList.remove('toast-show');
    window.setTimeout(() => toast.remove(), 300);
  }, 1500);
}

function shakeActiveRow(): void {
  if (currentState.status !== 'in_progress') return;
  const rows = root.querySelectorAll<HTMLElement>('.board-row');
  const row = rows[currentState.guesses.length];
  if (!row) return;
  row.classList.remove('row-shake');
  // Force reflow so the animation can replay if invoked twice quickly.
  void row.offsetWidth;
  row.classList.add('row-shake');
}

function showInstructions(onClose?: () => void): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', 'modal-title');
  backdrop.innerHTML = `
    <div class="modal">
      <h2 id="modal-title">How to play</h2>
      <p>Guess the 5-letter word in 6 tries. Each guess must be a real word. Tiles change color to show how close your guess was.</p>
      <ul class="legend">
        <li><span class="legend-tile" data-color="green">A</span> Right letter, right spot.</li>
        <li><span class="legend-tile" data-color="yellow">B</span> Right letter, wrong spot.</li>
        <li><span class="legend-tile" data-color="gray">C</span> Letter not in the word.</li>
      </ul>
      <p class="legend-note">A new puzzle drops every day at midnight UTC. Your stats and streak are saved across days.</p>
      <button type="button" class="modal-close">Got it</button>
    </div>
  `;
  document.body.appendChild(backdrop);

  const close = (): void => {
    backdrop.remove();
    if (onClose) onClose();
  };
  backdrop.querySelector<HTMLButtonElement>('.modal-close')!.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  // ESC to dismiss
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
}

// ---------- Input handling ----------

function pushChar(ch: string): void {
  if (currentState.status !== 'in_progress') return;
  if (currentInput.length >= COL_COUNT) return;
  if (!/^[a-zA-Z]$/.test(ch)) return;
  // Mark the column we're about to fill so render() animates only that tile.
  lastFilledColumn = currentInput.length;
  currentInput += ch.toUpperCase();
  render();
}

function popChar(): void {
  if (currentState.status !== 'in_progress') return;
  if (currentInput.length === 0) return;
  // Backspace doesn't pop — it just removes content.
  lastFilledColumn = null;
  currentInput = currentInput.slice(0, -1);
  render();
}

function attemptSubmit(): void {
  if (currentState.status !== 'in_progress') return;
  void submitGuess(currentState, currentInput);
}

function onPhysicalKey(e: KeyboardEvent): void {
  if (currentState.status !== 'in_progress') return;
  // Don't intercept keys while a modal is open — the modal handles its own ESC.
  if (document.querySelector('.modal-backdrop')) return;

  if (e.key === 'Enter') {
    e.preventDefault();
    attemptSubmit();
  } else if (e.key === 'Backspace') {
    e.preventDefault();
    popChar();
  } else if (/^[a-zA-Z]$/.test(e.key)) {
    e.preventDefault();
    pushChar(e.key);
  }
}

// ---------- Game flow ----------

async function submitGuess(state: State, raw: string): Promise<void> {
  if (state.status !== 'in_progress') return;

  if (raw.length !== COL_COUNT) {
    showToast('Need 5 letters');
    shakeActiveRow();
    return;
  }
  if (!/^[A-Z]+$/.test(raw)) {
    showToast('Letters only');
    shakeActiveRow();
    return;
  }
  if (!isValidGuess(raw)) {
    showToast('Not in word list');
    shakeActiveRow();
    void window.OddsRabbit.actions.haptic('error');
    return;
  }

  state.guesses.push(raw);
  currentInput = '';
  lastRevealedRow = state.guesses.length - 1;
  void window.OddsRabbit.actions.haptic('light');

  const isWin = raw === state.answer;
  const isLoss = !isWin && state.guesses.length >= ROW_COUNT;
  if (isWin) state.status = 'won';
  else if (isLoss) state.status = 'lost';

  await writeJson('today', state);

  if (state.status !== 'in_progress') {
    // Writes first so the subsequent reads see this player's contribution
    // (the player's own bucket appears in their distribution; scores.friends
    // doesn't include the viewer, but other clients reading the leaderboard
    // expect the score to be present).
    const [updatedStats, updatedStreak] = await Promise.all([
      finalizeStats(state),
      finalizeStreak(state),
      updateAggregate(state),
      submitScoreToServer(state),
    ]);
    currentStats = updatedStats;
    currentStreak = updatedStreak;
    void window.OddsRabbit.actions.haptic(state.status === 'won' ? 'success' : 'error');

    [currentCommunity, currentFriends] = await Promise.all([
      loadCommunityData(state),
      loadFriends(state),
    ]);
  }

  render();
}

async function finalizeStats(state: State): Promise<Stats> {
  const stats = await readJson<Stats>('stats', DEFAULT_STATS);
  const next = applyResultToStats(stats, state);
  await writeJson('stats', next);
  return next;
}

async function finalizeStreak(state: State): Promise<Streak> {
  const streak = await readJson<Streak>('streak', DEFAULT_STREAK);
  const next = applyResultToStreak(streak, state);
  await writeJson('streak', next);
  return next;
}

async function updateAggregate(state: State): Promise<void> {
  const bucket = bucketForState(state);
  try {
    await window.OddsRabbit.aggregate.count(`result-${state.puzzleIndex}`, bucket);
  } catch {
    /* best-effort */
  }
}

function bucketForState(state: State): DistributionBucket {
  if (state.status !== 'won') return 'lost';
  switch (state.guesses.length) {
    case 1: return 'won-1';
    case 2: return 'won-2';
    case 3: return 'won-3';
    case 4: return 'won-4';
    case 5: return 'won-5';
    case 6: return 'won-6';
    default: return 'lost';
  }
}

/**
 * Submit this user's result to the platform scores table for the friends
 * panel + future leaderboard. Score formula: `ROW_COUNT + 1 - guessCount`
 * for wins (1-guess win = 6 pts, 6-guess win = 1 pt), 0 for losses. Ties on
 * guess count are broken by submission time server-side.
 *
 * Best-effort:
 *  - 409 (already submitted) is expected on rerenders / replays — silent.
 *  - Network / 5xx errors leave the friends panel empty; the local game
 *    state is unaffected.
 *  - Skipped entirely for anonymous users (the bridge would 401 anyway).
 */
async function submitScoreToServer(state: State): Promise<void> {
  if (!window.OddsRabbit.user) return;
  if (state.status === 'in_progress') return;
  const won = state.status === 'won';
  const guessCount = state.guesses.length;
  try {
    await window.OddsRabbit.scores.submit({
      roundKey: `puzzle-${state.puzzleIndex}`,
      score: won ? ROW_COUNT + 1 - guessCount : 0,
      metadata: { won, guessCount },
    });
  } catch {
    /* best-effort — see jsdoc above */
  }
}

/**
 * Fetch all 7 distribution buckets in parallel for today's puzzle. Uses
 * aggregate.read (not .count) — .count would register the viewer into every
 * bucket and corrupt the distribution. Each call can return null independently
 * (per-bucket k=5 floor), which the renderer treats as "below floor, show
 * empty bar."
 */
async function loadCommunityData(state: State): Promise<CommunityData> {
  const key = `result-${state.puzzleIndex}`;
  const counts = await Promise.all(
    DISTRIBUTION_BUCKETS.map((bucket) =>
      window.OddsRabbit.aggregate.read(key, bucket).catch(() => null)
    )
  );
  const buckets = {} as Record<DistributionBucket, number | null>;
  DISTRIBUTION_BUCKETS.forEach((bucket, i) => {
    buckets[bucket] = counts[i] ?? null;
  });
  return { buckets };
}

async function loadFriends(state: State): Promise<FriendScore[]> {
  if (!window.OddsRabbit.user) return [];
  try {
    return await window.OddsRabbit.scores.friends({
      roundKey: `puzzle-${state.puzzleIndex}`,
    });
  } catch {
    return [];
  }
}

async function shareResult(state: State): Promise<void> {
  showShareModal(state);
}

const SHARE_LANDING_URL = 'https://www.oddsrabbit.com/games/rabbit-words/';

function buildShareTitle(state: State): string {
  const score = state.status === 'won' ? `${state.guesses.length}/6` : 'X/6';
  return `RabbitWords #${state.puzzleIndex + 1} ${score}`;
}

function buildShareText(state: State): string {
  return `${buildShareTitle(state)}\n\n${buildShareGrid(state)}\n\nPlay at ${SHARE_LANDING_URL}`;
}

function showShareModal(state: State): void {
  const title = buildShareTitle(state);
  const grid = buildShareGrid(state);
  const text = buildShareText(state);

  // Detect platform capabilities so we only show buttons that will work.
  // Native share is gated to touch devices: on macOS/Windows desktop the OS
  // share sheet is anemic (Mail, Notes, AirDrop only) and the unique value
  // — sending to a specific contact / chat in one tap — only exists on
  // mobile. Desktop users are better served by Copy + the social row below.
  const isTouchDevice = navigator.maxTouchPoints > 0;
  const supportsNativeShare = isTouchDevice && typeof navigator.share === 'function';
  let supportsFileShare = false;
  if (supportsNativeShare && typeof navigator.canShare === 'function') {
    try {
      const probe = new File(['probe'], 'probe.png', { type: 'image/png' });
      supportsFileShare = navigator.canShare({ files: [probe] });
    } catch {
      supportsFileShare = false;
    }
  }

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop share-modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', 'share-modal-title');
  backdrop.innerHTML = `
    <div class="modal share-modal">
      <button type="button" class="modal-x" aria-label="Close" data-action="close">&times;</button>
      <h2 id="share-modal-title">Share your result</h2>

      <div class="share-preview">
        <div class="share-preview-title">${escapeHtml(title)}</div>
        <pre class="share-preview-grid">${escapeHtml(grid)}</pre>
      </div>

      <button type="button" class="share-action share-action-primary" data-action="copy">Copy result</button>
      ${supportsNativeShare ? `<button type="button" class="share-action" data-action="native">Share via apps…</button>` : ''}

      <div class="share-section-label">Share to social</div>
      <div class="share-buttons">
        <button type="button" class="share-button share-button-x" data-action="twitter" aria-label="Share to X">X</button>
        <button type="button" class="share-button share-button-threads" data-action="threads" aria-label="Share to Threads">Threads</button>
        <button type="button" class="share-button share-button-bluesky" data-action="bluesky" aria-label="Share to Bluesky">Bluesky</button>
        <button type="button" class="share-button share-button-reddit" data-action="reddit" aria-label="Share to Reddit">Reddit</button>
        <button type="button" class="share-button share-button-whatsapp" data-action="whatsapp" aria-label="Share to WhatsApp">WhatsApp</button>
        <button type="button" class="share-button share-button-facebook" data-action="facebook" aria-label="Share to Facebook">Facebook</button>
      </div>

      <div class="share-section-label">Save as image</div>
      <button type="button" class="share-action" data-action="download-image">Download image</button>
      ${supportsFileShare ? `<button type="button" class="share-action" data-action="share-image">Share image…</button>` : ''}
    </div>
  `;

  document.body.appendChild(backdrop);

  const close = (): void => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);

  backdrop.addEventListener('click', async (e) => {
    if (e.target === backdrop) {
      close();
      return;
    }
    const target = (e.target as HTMLElement).closest('[data-action]') as HTMLButtonElement | null;
    if (!target) return;
    await runShareAction(target.dataset.action ?? '', state, title, text, close);
  });
}

async function runShareAction(
  action: string,
  state: State,
  title: string,
  text: string,
  close: () => void
): Promise<void> {
  switch (action) {
    case 'close':
      close();
      return;
    case 'copy':
      try {
        await navigator.clipboard.writeText(text);
        showToast('Copied to clipboard');
      } catch {
        showToast('Could not copy');
      }
      return;
    case 'native':
      // Route through the SDK so the call runs in the outer host's context
      // (WP page on web, RN host on mobile) where Permissions Policy doesn't
      // gate `navigator.share`. The SDK falls through to clipboard if the
      // share API rejects, so a "no app picked" cancel still leaves the user
      // with the result on their clipboard.
      try {
        await window.OddsRabbit.actions.share({ title, text });
      } catch {
        showToast('Could not share');
      }
      return;
    case 'twitter':
      openShareUrl(`https://x.com/intent/post?text=${encodeURIComponent(text)}`);
      return;
    case 'threads':
      openShareUrl(`https://www.threads.net/intent/post?text=${encodeURIComponent(text)}`);
      return;
    case 'bluesky':
      openShareUrl(`https://bsky.app/intent/compose?text=${encodeURIComponent(text)}`);
      return;
    case 'reddit':
      openShareUrl(
        `https://www.reddit.com/submit?url=${encodeURIComponent(SHARE_LANDING_URL)}&title=${encodeURIComponent(title)}`
      );
      return;
    case 'whatsapp':
      openShareUrl(`https://wa.me/?text=${encodeURIComponent(text)}`);
      return;
    case 'facebook':
      // Facebook strips text from share intents, so URL-only is what lands.
      // The og:image / og:title on the landing page are what produce the card.
      openShareUrl(
        `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(SHARE_LANDING_URL)}`
      );
      return;
    case 'download-image':
      try {
        const blob = await buildShareImage(state);
        triggerDownload(blob, `rabbitwords-${state.puzzleIndex + 1}.png`);
      } catch {
        showToast('Could not generate image');
      }
      return;
    case 'share-image':
      try {
        const blob = await buildShareImage(state);
        const file = new File([blob], `rabbitwords-${state.puzzleIndex + 1}.png`, {
          type: 'image/png',
        });
        await navigator.share({ title, text, files: [file] });
      } catch {
        // User-cancelled or unavailable.
      }
      return;
  }
}

function openShareUrl(url: string): void {
  // noopener so the destination tab can't reach back into our window.
  window.open(url, '_blank', 'noopener,noreferrer');
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Renders the result as a 1080×1080 PNG. Same colored-grid convention as the
// emoji share string — letters are NEVER drawn so the image doesn't spoil the
// answer for anyone who hasn't played yet.
async function buildShareImage(state: State): Promise<Blob> {
  const SIZE = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  // White background — best contrast in social feeds where dark backgrounds
  // are common; the colored tiles pop.
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Title
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 72px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('RabbitWords', SIZE / 2, 110);

  // Subtitle: "Puzzle #N · X/6"
  const score = state.status === 'won' ? `${state.guesses.length}/6` : 'X/6';
  ctx.fillStyle = '#666666';
  ctx.font = '500 40px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText(`Puzzle #${state.puzzleIndex + 1} · ${score}`, SIZE / 2, 210);

  // Tile grid — only render guessed rows (matches emoji-text convention).
  const rows = state.guesses.length;
  const TILE = 130;
  const GAP = 14;
  const gridW = COL_COUNT * TILE + (COL_COUNT - 1) * GAP;
  const gridH = rows * TILE + (rows - 1) * GAP;
  const startX = (SIZE - gridW) / 2;
  const subtitleBottom = 290;
  const footerTop = SIZE - 140;
  const startY = subtitleBottom + Math.max(0, (footerTop - subtitleBottom - gridH) / 2);

  const RADIUS = 10;
  for (let row = 0; row < rows; row++) {
    const guess = state.guesses[row]!;
    const colors = scoreGuess(guess, state.answer);
    for (let col = 0; col < COL_COUNT; col++) {
      const x = startX + col * (TILE + GAP);
      const y = startY + row * (TILE + GAP);
      const c = colors[col];
      ctx.fillStyle = c === 'green' ? '#6aaa64' : c === 'yellow' ? '#c9b458' : '#787c7e';
      drawRoundedRect(ctx, x, y, TILE, TILE, RADIUS);
      ctx.fill();
    }
  }

  // Footer URL
  ctx.fillStyle = '#999999';
  ctx.font = '500 30px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.fillText('oddsrabbit.com/games/rabbit-words', SIZE / 2, SIZE - 70);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('canvas.toBlob returned null'));
    }, 'image/png');
  });
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ---------- Bootstrap ----------

async function bootstrap(): Promise<void> {
  await window.OddsRabbit.whenReady();

  const [state, stats, streak, seenIntro] = await Promise.all([
    loadState(),
    readJson<Stats>('stats', DEFAULT_STATS),
    readJson<Streak>('streak', DEFAULT_STREAK),
    readJson<boolean>('seen_intro', false),
  ]);

  currentState = state;
  currentStats = stats;
  currentStreak = streak;

  if (state.status !== 'in_progress') {
    // Retry score submission in case the original game-over submit failed
    // silently (network blip, 5xx). 409s for already-submitted rounds are
    // expected here and ignored inside submitScoreToServer.
    await submitScoreToServer(state);

    [currentCommunity, currentFriends] = await Promise.all([
      loadCommunityData(state),
      loadFriends(state),
    ]);
  }

  window.OddsRabbit.lifecycle.on('pause', () => {
    void writeJson('today', state);
  });

  document.addEventListener('keydown', onPhysicalKey);

  render();

  if (!seenIntro) {
    showInstructions(() => void writeJson('seen_intro', true));
  }

  window.OddsRabbit.ready();
}

bootstrap().catch((error) => {
  root.textContent = `Failed to start: ${error instanceof Error ? error.message : String(error)}`;
});
