import type {
  FriendScore,
  OddsRabbitGlobal,
  ScoreDistributionEntry,
} from '../../src/sdk/sdk';
import {
  createLeaderboardPanel,
  pinnedFromRank,
  type LeaderboardPanel,
  type LeaderboardRow,
  type LeaderboardTab,
} from '../../src/ui/leaderboard';
import { createSeasonTab, currentPeriod } from '../../src/ui/season';
import * as L from 'leaflet';

declare global {
  interface Window {
    OddsRabbit: OddsRabbitGlobal;
  }
}

/**
 * One round's location. Served only by the platform via `content.daily` — the
 * coordinates ARE the answer, so there is no bundled set (an unavailable round
 * shows a holding screen rather than a spoiler-readable local answer). Always
 * render `attribution` with the photo.
 */
export interface GeoLocation {
  image: string;
  lat: number;
  lng: number;
  place: string;
  attribution: string;
}

// ---------- Constants ----------

const ROUNDS_PER_DAY = 3;
const MAX_ROUND_SCORE = 5000;
const MAX_TOTAL = MAX_ROUND_SCORE * ROUNDS_PER_DAY; // 15000
// Score decay: score = MAX_ROUND_SCORE * e^(-km / SCALE_KM). Larger = gentler.
// ~2000km half-ish-life keeps continental guesses rewarding without trivializing.
const SCALE_KM = 2000;

// 2026-06-20 UTC midnight is `puzzleIndex` 0; we display it as #1.
const EPOCH_MS = Date.UTC(2026, 5, 20);
const DAY_MS = 86_400_000;

// Community distribution bands, best → worst (total score). Geo scores are
// near-continuous, so we fold the raw `scores.distribution` histogram into these
// five bands (same best→worst ordering the "you beat X%" headline depends on).
const DISTRIBUTION_BUCKETS = ['elite', 'great', 'good', 'ok', 'low'] as const;
type DistributionBucket = (typeof DISTRIBUTION_BUCKETS)[number];

const BUCKET_LABEL: Record<DistributionBucket, string> = {
  elite: '12k+',
  great: '9k+',
  good: '6k+',
  ok: '3k+',
  low: '<3k',
};

type CommunityData = {
  buckets: Record<DistributionBucket, number | null>;
  // Raw per-score histogram, kept so the headline can show a TRUE percentile
  // (count scoring below you ÷ total) instead of a coarse bucket-based one.
  entries: ScoreDistributionEntry[];
};

// ---------- Types ----------

interface GuessResult {
  lat: number;
  lng: number;
  km: number;
  score: number;
}

interface State {
  puzzleIndex: number;
  locations: GeoLocation[]; // exactly ROUNDS_PER_DAY
  guesses: (GuessResult | null)[]; // parallel to locations
  current: number; // round index in view
  status: 'in_progress' | 'complete';
}

interface Stats {
  played: number;
  bestTotal: number;
  // Plays bucketed by total-score band, same order as DISTRIBUTION_BUCKETS.
  distribution: [number, number, number, number, number];
}

interface Streak {
  current: number;
  max: number;
  lastPlayedPuzzleIndex: number | null;
}

const DEFAULT_STATS: Stats = { played: 0, bestTotal: 0, distribution: [0, 0, 0, 0, 0] };
const DEFAULT_STREAK: Streak = { current: 0, max: 0, lastPlayedPuzzleIndex: null };

// ---------- Module-level UI state ----------

let currentState: State;
let currentStats: Stats = DEFAULT_STATS;
let currentStreak: Streak = DEFAULT_STREAK;
let currentFriends: FriendScore[] | undefined;
let currentCommunity: CommunityData | null = null;

// The player's not-yet-submitted pin for the current round. Ephemeral — a reload
// mid-guess starts with no pin, which is expected.
let pendingPin: { lat: number; lng: number } | null = null;

// Which pane of the round is visible: the photo or the map. The two share the
// full area (and toggle) instead of stacking, so neither is cramped on small
// screens. Reset per phase in render(); the player can flip freely after.
let roundView: 'photo' | 'map' = 'photo';

// Live Leaflet instance for the current round; torn down before each re-render.
let mapInstance: L.Map | null = null;
let resetTimeInterval: number | undefined;

// ---------- Pure helpers ----------

function todayPuzzleIndex(): number {
  return Math.floor((Date.now() - EPOCH_MS) / DAY_MS);
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two lat/lng points, in kilometres. */
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function scoreForKm(km: number): number {
  return Math.round(MAX_ROUND_SCORE * Math.exp(-km / SCALE_KM));
}

function totalScore(state: State): number {
  return state.guesses.reduce((sum, g) => sum + (g ? g.score : 0), 0);
}

function bucketForTotal(total: number): DistributionBucket {
  if (total >= 12000) return 'elite';
  if (total >= 9000) return 'great';
  if (total >= 6000) return 'good';
  if (total >= 3000) return 'ok';
  return 'low';
}

function formatKm(km: number): string {
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString()} km`;
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

// ---------- Daily content + persistence ----------

/** True when `loc` is a structurally valid GeoLocation. */
function isLocation(v: unknown): v is GeoLocation {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<GeoLocation>;
  return (
    typeof o.image === 'string' &&
    typeof o.lat === 'number' &&
    typeof o.lng === 'number' &&
    typeof o.place === 'string' &&
    typeof o.attribution === 'string'
  );
}

function parseLocations(raw: unknown): GeoLocation[] | null {
  if (!Array.isArray(raw) || raw.length !== ROUNDS_PER_DAY) return null;
  return raw.every(isLocation) ? (raw as GeoLocation[]) : null;
}

/**
 * Fetch today's locations from the server (bridge `content.daily`). Returns null
 * when the host has no content endpoint, the round isn't published, or the
 * payload is malformed — there is no bundled fallback, so that means no playable
 * game. Guests included (content is public).
 */
async function loadDailyLocations(puzzleIndex: number): Promise<GeoLocation[] | null> {
  const daily = await window.OddsRabbit.content.daily({
    roundKey: `puzzle-${puzzleIndex}`,
  });
  return parseLocations(daily?.content?.['locations']);
}

function freshState(locations: GeoLocation[]): State {
  return {
    puzzleIndex: todayPuzzleIndex(),
    locations,
    guesses: Array.from({ length: ROUNDS_PER_DAY }, () => null),
    current: 0,
    status: 'in_progress',
  };
}

function isValidState(s: unknown): s is State {
  if (!s || typeof s !== 'object') return false;
  const v = s as Partial<State>;
  return (
    typeof v.puzzleIndex === 'number' &&
    Array.isArray(v.locations) &&
    v.locations.length === ROUNDS_PER_DAY &&
    v.locations.every(isLocation) &&
    Array.isArray(v.guesses) &&
    v.guesses.length === ROUNDS_PER_DAY &&
    typeof v.current === 'number' &&
    (v.status === 'in_progress' || v.status === 'complete')
  );
}

async function readStoredState(): Promise<State | null> {
  try {
    const raw = await window.OddsRabbit.storage.get('today');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidState(parsed)) return null;
    if (parsed.puzzleIndex !== todayPuzzleIndex()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Today's game, or null when it can't be played — no stored game AND the server
 * has no published locations for today (old/unsupported host, unseeded round,
 * offline). Null drives the "unavailable" screen; there's no local fallback.
 */
async function loadState(): Promise<State | null> {
  const stored = await readStoredState();
  if (stored) return stored;
  const locations = await loadDailyLocations(todayPuzzleIndex());
  return locations ? freshState(locations) : null;
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
  try {
    await window.OddsRabbit.storage.set(key, JSON.stringify(value));
  } catch {
    /* best-effort */
  }
}

function applyResultToStats(stats: Stats, total: number): Stats {
  const i = DISTRIBUTION_BUCKETS.indexOf(bucketForTotal(total));
  const distribution = [...stats.distribution] as Stats['distribution'];
  if (i >= 0) distribution[i] = (distribution[i] ?? 0) + 1;
  return {
    played: stats.played + 1,
    bestTotal: Math.max(stats.bestTotal, total),
    distribution,
  };
}

function applyResultToStreak(streak: Streak, puzzleIndex: number): Streak {
  const consecutive =
    streak.lastPlayedPuzzleIndex === puzzleIndex - 1 ? streak.current + 1 : 1;
  return {
    current: consecutive,
    max: Math.max(streak.max, consecutive),
    lastPlayedPuzzleIndex: puzzleIndex,
  };
}

// ---------- Scores bridge ----------

async function submitScoreToServer(state: State): Promise<void> {
  if (!window.OddsRabbit.user) return;
  if (state.status !== 'complete') return;
  const kmTotal = state.guesses.reduce((s, g) => s + (g ? g.km : 0), 0);
  try {
    await window.OddsRabbit.scores.submit({
      roundKey: `puzzle-${state.puzzleIndex}`,
      score: totalScore(state),
      metadata: { total: totalScore(state), kmTotal: Math.round(kmTotal) },
    });
  } catch {
    /* best-effort: 409 on replay, network failures leave panels empty */
  }
}

async function loadFriends(puzzleIndex: number): Promise<FriendScore[]> {
  if (!window.OddsRabbit.user) return [];
  try {
    return await window.OddsRabbit.scores.friends({ roundKey: `puzzle-${puzzleIndex}` });
  } catch {
    return [];
  }
}

async function loadCommunityData(puzzleIndex: number): Promise<CommunityData> {
  const buckets = Object.fromEntries(
    DISTRIBUTION_BUCKETS.map((b) => [b, null])
  ) as Record<DistributionBucket, number | null>;

  let entries: ScoreDistributionEntry[];
  try {
    entries = await window.OddsRabbit.scores.distribution({
      roundKey: `puzzle-${puzzleIndex}`,
    });
  } catch {
    return { buckets, entries: [] };
  }
  // Fold the near-continuous raw scores into our five bands (for the chart);
  // keep the raw entries for the true-percentile headline.
  for (const { score, count } of entries) {
    const bucket = bucketForTotal(score);
    buckets[bucket] = (buckets[bucket] ?? 0) + count;
  }
  return { buckets, entries };
}

/**
 * True percentile: the share of community plays scoring strictly below the
 * viewer's total. Far more accurate (and less deflating) than the bucket-based
 * version — a 4,300 mid-pack score reflects everyone it actually beat, not just
 * the whole worst bucket. Returns null when there's no data or no one below.
 */
function truePercentileBelow(entries: ScoreDistributionEntry[], viewerTotal: number): number | null {
  const total = entries.reduce((sum, e) => sum + e.count, 0);
  if (total === 0) return null;
  const below = entries.reduce((sum, e) => sum + (e.score < viewerTotal ? e.count : 0), 0);
  const pct = Math.round((below / total) * 100);
  return pct > 0 ? pct : null;
}

// ---------- Rendering ----------

const root = document.getElementById('root')!;

function render(): void {
  // Tear down any live map before we blow away its container.
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }
  root.innerHTML = '';
  root.appendChild(renderHeader(currentState));

  if (currentState.status === 'in_progress') {
    const guess = currentState.guesses[currentState.current] ?? null;
    // Default pane per phase (render only runs on real transitions, not on
    // toggles): look at the photo first while guessing, see the result on the
    // map after. The player can still flip either way.
    roundView = guess ? 'map' : 'photo';
    root.appendChild(renderRound(currentState, guess));
    // The map container is now in the DOM; mount Leaflet onto it.
    mountRoundMap(currentState, guess);
  } else {
    root.appendChild(
      renderEndGame(currentState, currentStats, currentStreak, currentFriends, currentCommunity)
    );
    runEndGameAnimations(root);
  }
  root.appendChild(renderResetTime());
}

function renderHeader(state: State): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'puzzle-header';
  const meta = document.createElement('div');
  meta.className = 'puzzle-meta';
  meta.innerHTML = `
    <span class="puzzle-number">Puzzle #${state.puzzleIndex + 1}</span>
    <span class="puzzle-date">${escapeHtml(formatPuzzleDate(state.puzzleIndex))}</span>
  `;

  const actions = document.createElement('div');
  actions.className = 'puzzle-header-actions';

  // Yesterday's leaderboard — hidden on day 0. Today's scores are held back to
  // the end screen since they shift as the day's plays land.
  if (state.puzzleIndex > 0) {
    const lb = document.createElement('button');
    lb.type = 'button';
    lb.className = 'header-icon-btn leaderboard-btn';
    lb.setAttribute('aria-label', "Yesterday's leaderboard");
    lb.textContent = '🏆';
    lb.addEventListener('click', () => void showLeaderboardModal(state.puzzleIndex - 1));
    actions.appendChild(lb);
  }

  const help = document.createElement('button');
  help.type = 'button';
  help.className = 'header-icon-btn help-btn';
  help.setAttribute('aria-label', 'How to play');
  help.textContent = '?';
  help.addEventListener('click', () => showInstructions());
  actions.appendChild(help);

  wrap.appendChild(meta);
  wrap.appendChild(actions);
  return wrap;
}

/** Switch the visible pane without re-rendering (keeps the Leaflet map mounted). */
function setRoundView(view: 'photo' | 'map'): void {
  roundView = view;
  const stage = root.querySelector<HTMLElement>('.round-stage');
  if (stage) stage.dataset.view = view;
  root.querySelectorAll<HTMLElement>('[data-view-btn]').forEach((b) => {
    b.classList.toggle('view-tab-active', b.dataset.viewBtn === view);
  });
  // Leaflet sizes to its container; a pane hidden at mount time has 0 size, so
  // recompute when it becomes visible.
  if (view === 'map') {
    setTimeout(() => {
      if (mapInstance) mapInstance.invalidateSize();
    }, 0);
  }
}

function renderRound(state: State, guess: GuessResult | null): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'round';
  const location = state.locations[state.current]!;

  // Progress dots.
  const progress = document.createElement('div');
  progress.className = 'round-progress';
  for (let i = 0; i < ROUNDS_PER_DAY; i++) {
    const dot = document.createElement('span');
    dot.className = 'round-dot';
    if (state.guesses[i]) dot.classList.add('round-dot-done');
    if (i === state.current) dot.classList.add('round-dot-current');
    progress.appendChild(dot);
  }
  wrap.appendChild(progress);

  // Photo / Map toggle.
  const toggle = document.createElement('div');
  toggle.className = 'view-toggle';
  (['photo', 'map'] as const).forEach((v) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.viewBtn = v;
    btn.textContent = v === 'photo' ? 'Photo' : 'Map';
    if (v === roundView) btn.classList.add('view-tab-active');
    btn.addEventListener('click', () => setRoundView(v));
    toggle.appendChild(btn);
  });
  wrap.appendChild(toggle);

  // Stage holds both panes; CSS shows the one matching [data-view].
  const stage = document.createElement('div');
  stage.className = 'round-stage';
  stage.dataset.view = roundView;

  // --- Photo pane ---
  const photoPane = document.createElement('div');
  photoPane.className = 'pane pane-photo';
  const figure = document.createElement('figure');
  figure.className = 'clue';
  const img = document.createElement('img');
  img.className = 'clue-photo';
  img.alt = 'Where was this photo taken?';
  img.src = location.image;
  img.addEventListener('error', () => figure.classList.add('clue-photo-failed'));
  const cap = document.createElement('figcaption');
  cap.className = 'clue-attribution';
  cap.textContent = location.attribution;
  figure.appendChild(img);
  figure.appendChild(cap);
  photoPane.appendChild(figure);
  if (!guess) {
    const toMap = document.createElement('button');
    toMap.type = 'button';
    toMap.className = 'control-btn control-btn-primary';
    toMap.textContent = 'Place your pin →';
    toMap.addEventListener('click', () => setRoundView('map'));
    photoPane.appendChild(toMap);
  }
  stage.appendChild(photoPane);

  // --- Map pane ---
  const mapPane = document.createElement('div');
  mapPane.className = 'pane pane-map';
  const mapEl = document.createElement('div');
  mapEl.className = 'geo-map';
  mapEl.id = 'geo-map';
  mapPane.appendChild(mapEl);

  if (guess) {
    const result = document.createElement('div');
    result.className = 'round-result';
    result.innerHTML = `
      <p class="round-distance"><strong>${escapeHtml(formatKm(guess.km))}</strong> away · ${guess.score.toLocaleString()} / ${MAX_ROUND_SCORE}</p>
      <p class="round-place">${escapeHtml(location.place)}</p>
    `;
    mapPane.appendChild(result);

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'control-btn control-btn-primary';
    next.textContent = state.current < ROUNDS_PER_DAY - 1 ? 'Next round' : 'See results';
    next.addEventListener('click', () => void advanceRound());
    mapPane.appendChild(next);
  } else {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'view-back';
    back.textContent = '‹ Back to photo';
    back.addEventListener('click', () => setRoundView('photo'));
    mapPane.appendChild(back);

    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'control-btn control-btn-primary';
    submit.id = 'guess-btn';
    submit.textContent = 'Guess';
    submit.disabled = pendingPin === null;
    submit.addEventListener('click', () => void submitGuess());
    mapPane.appendChild(submit);
  }
  stage.appendChild(mapPane);

  wrap.appendChild(stage);
  return wrap;
}

/** Create the Leaflet map for the current round and wire interactions. */
function mountRoundMap(state: State, guess: GuessResult | null): void {
  const location = state.locations[state.current]!;
  const map = L.map('geo-map', {
    worldCopyJump: true,
    minZoom: 1,
    maxZoom: 18,
  }).setView([20, 0], 1);
  mapInstance = map;

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(map);

  // Leaflet's default marker uses bundled PNGs whose paths break under esbuild;
  // CSS-only divIcons sidestep that entirely.
  const pinIcon = (cls: string, glyph: string): L.DivIcon =>
    L.divIcon({ className: `map-pin ${cls}`, html: glyph, iconSize: [24, 24], iconAnchor: [12, 24] });

  if (guess) {
    // Revealed: show guess + truth + the line between them, framed to both.
    const guessLatLng: L.LatLngExpression = [guess.lat, guess.lng];
    const truthLatLng: L.LatLngExpression = [location.lat, location.lng];
    L.marker(guessLatLng, { icon: pinIcon('map-pin-guess', '📍') }).addTo(map);
    L.marker(truthLatLng, { icon: pinIcon('map-pin-truth', '✓') }).addTo(map);
    L.polyline([guessLatLng, truthLatLng], { className: 'guess-line', weight: 2 }).addTo(map);
    map.fitBounds(L.latLngBounds([guessLatLng, truthLatLng]).pad(0.3));
    map.dragging.disable();
    map.scrollWheelZoom.disable();
  } else {
    let marker: L.Marker | null = null;
    map.on('click', (e: L.LeafletMouseEvent) => {
      pendingPin = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (marker) marker.setLatLng(e.latlng);
      else marker = L.marker(e.latlng, { icon: pinIcon('map-pin-guess', '📍') }).addTo(map);
      const btn = document.getElementById('guess-btn') as HTMLButtonElement | null;
      if (btn) btn.disabled = false;
      void window.OddsRabbit.actions.haptic('light');
    });
  }

  // Containers sized by CSS after mount need a nudge so tiles fill correctly.
  setTimeout(() => map.invalidateSize(), 0);
}

function renderEndGame(
  state: State,
  stats: Stats,
  streak: Streak,
  friends?: FriendScore[],
  community?: CommunityData | null
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'end-game';
  wrap.setAttribute('role', 'status');
  const total = totalScore(state);

  const verdict = document.createElement('p');
  verdict.className = 'verdict';
  // The big total counts up from 0 on reveal (see runEndGameAnimations).
  const totalEl = document.createElement('strong');
  totalEl.dataset.countTo = String(total);
  totalEl.textContent = '0';
  verdict.append(totalEl, ` / ${MAX_TOTAL.toLocaleString()}`);
  wrap.appendChild(verdict);

  // Per-round recap.
  const recap = document.createElement('div');
  recap.className = 'recap';
  state.locations.forEach((loc, i) => {
    const g = state.guesses[i];
    const row = document.createElement('div');
    row.className = 'recap-row';
    row.innerHTML = `
      <span class="recap-place">${escapeHtml(loc.place)}</span>
      <span class="recap-score">${g ? `${formatKm(g.km)} · ${g.score.toLocaleString()}` : '—'}</span>
    `;
    recap.appendChild(row);
  });
  wrap.appendChild(recap);

  if (community) {
    wrap.appendChild(renderCommunityDistribution(community, total));
  }
  wrap.appendChild(
    renderLeaderboardPanel(endGamePanelSlot, state.puzzleIndex, friends, { total })
  );

  // Personal stats.
  const statsRow = document.createElement('div');
  statsRow.className = 'stats-row';
  const cells: [string, string][] = [
    ['Played', String(stats.played)],
    ['Best', stats.bestTotal.toLocaleString()],
    ['Streak', String(streak.current)],
    ['Max', String(streak.max)],
  ];
  for (const [label, value] of cells) {
    const cell = document.createElement('div');
    cell.className = 'stat-cell';
    cell.innerHTML = `<div class="stat-value">${escapeHtml(value)}</div><div class="stat-label">${escapeHtml(label)}</div>`;
    statsRow.appendChild(cell);
  }
  wrap.appendChild(statsRow);

  const share = document.createElement('button');
  share.type = 'button';
  share.className = 'share-btn';
  share.textContent = 'Share result';
  share.addEventListener('click', () => void shareResult(state));
  wrap.appendChild(share);

  return wrap;
}

function renderCommunityDistribution(
  community: CommunityData,
  viewerTotal: number | null,
  title = "Today's Scores"
): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'community-distribution';
  const titleEl = document.createElement('h3');
  titleEl.className = 'hist-title';
  titleEl.textContent = title;
  wrap.appendChild(titleEl);

  const counts = DISTRIBUTION_BUCKETS.map((b) => community.buckets[b] ?? 0);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) {
    const empty = document.createElement('p');
    empty.className = 'community-empty';
    empty.textContent = 'Not enough plays yet to show the distribution.';
    wrap.appendChild(empty);
    return wrap;
  }

  const userBucket = viewerTotal !== null ? bucketForTotal(viewerTotal) : null;

  // TRUE percentile from the raw scores, not the coarse buckets — so it never
  // contradicts the bar the viewer is standing in.
  if (viewerTotal !== null) {
    const beatPct = truePercentileBelow(community.entries, viewerTotal);
    if (beatPct !== null) {
      const headline = document.createElement('p');
      headline.className = 'dist-headline';
      const strong = document.createElement('strong');
      strong.dataset.countTo = String(beatPct);
      strong.textContent = '0%';
      headline.append('You did better than ', strong, ' of players');
      wrap.appendChild(headline);
    }
  }

  const max = Math.max(1, ...counts);
  const hist = document.createElement('div');
  hist.className = 'histogram community-hist';
  DISTRIBUTION_BUCKETS.forEach((bucket, i) => {
    const count = counts[i] ?? 0;
    if (count === 0) return;
    const pct = Math.round((count / total) * 100);
    const isCurrent = userBucket !== null && bucket === userBucket;
    const bar = document.createElement('div');
    bar.className = isCurrent ? 'hist-bar hist-bar-current' : 'hist-bar';
    const label = document.createElement('span');
    label.className = 'hist-label';
    label.textContent = BUCKET_LABEL[bucket];
    const fill = document.createElement('div');
    fill.className = 'hist-fill';
    // Animate from 0 → target on next frame (CSS transitions width).
    fill.style.width = '0%';
    fill.dataset.fillTo = String(Math.max(8, (count / max) * 100));
    fill.textContent = `${pct}%`;
    bar.appendChild(label);
    bar.appendChild(fill);
    if (isCurrent) {
      const you = document.createElement('span');
      you.className = 'hist-you';
      you.textContent = 'You';
      bar.appendChild(you);
    }
    hist.appendChild(bar);
  });
  wrap.appendChild(hist);
  return wrap;
}

/**
 * A place a leaderboard panel lives. Globe mounts panels in two independent
 * spots — the end-game screen and the past-round modal, which are on screen at
 * the same time when the modal is opened over a finished game — so each holds
 * its own slot rather than sharing one "current panel" that would tear down the
 * other's board.
 *
 * Mounting destroys whatever the slot held, which is what stops the Global
 * tab's `scores.top` from painting into detached nodes after the modal has been
 * paged to another puzzle or closed.
 */
/**
 * Rows to fetch for a public board. The REST route and the SDK schema both cap
 * this at 100, so it is "everyone the server will hand over".
 *
 * Was 20 through Phase 2/3, which was a placeholder rather than a decision and
 * had started cutting real players off: 32 people held a rabbit-words season
 * row in August 2026 and 51 held a 2048 all-time score, so a third to a half of
 * each field sat below a fold nobody chose. The panel bounds its own height and
 * scrolls (`.lb-list`), so a deeper board costs rows the player can reach
 * instead of rows they can't.
 */
const BOARD_LIMIT = 100;

interface PanelSlot {
  mount(panel: LeaderboardPanel): HTMLElement;
  clear(): void;
}

function panelSlot(): PanelSlot {
  let live: LeaderboardPanel | null = null;
  return {
    mount(panel) {
      live?.destroy();
      live = panel;
      return panel.element;
    },
    clear() {
      live?.destroy();
      live = null;
    },
  };
}

/** The end-game screen's slot; `renderEndGame` rebuilds the screen wholesale. */
const endGamePanelSlot = panelSlot();

/**
 * Friends + Global boards for one puzzle, rendered by the shared leaderboard UI
 * (`src/ui/leaderboard.ts`).
 *
 * This used to be `renderFriendsPanel` + `rowAvatar` here, duplicated almost
 * verbatim in `2048/js/leaderboard.js`. Row markup, the avatar hash, medals and
 * competition ranking now live in one place; what stays here is the part that is
 * genuinely globe's — which rows exist, and how a score is formatted.
 */
function renderLeaderboardPanel(
  slot: PanelSlot,
  puzzleIndex: number,
  friends: FriendScore[] | undefined,
  viewerResult: { total: number } | null
): HTMLElement {
  const OR = window.OddsRabbit;
  const signedIn = Boolean(OR.user);
  const friendRows = signedIn ? friendsRows(friends, viewerResult) : [];
  const formatScore = (row: LeaderboardRow): string => row.score.toLocaleString();

  const tabs: LeaderboardTab[] = [
    {
      id: 'friends',
      label: 'Friends',
      emptyText: 'Follow other players on OddsRabbit to compare scores here.',
      load: () => Promise.resolve(friendRows),
      formatValue: formatScore,
      signInPrompt: signedIn
        ? null
        : {
            blurb: 'Sign in to see how people you follow are doing today.',
            label: 'Sign in',
            onClick: () => {
              void OR.actions.requestSignIn('See how your friends did today');
            },
          },
    },
  ];

  // Public read, so guests get this board too — but only where the host
  // implements the verb. Gate on the capability rather than on the method
  // existing: every SDK bundle has `scores.top`, hosts are what differ.
  if (OR.capabilities.has('scores.top')) {
    // One key for both reads. A rank fetched against a different round than
    // the board describes a different set of players entirely — the same class
    // of mistake the `order` argument invites, and worth removing the chance of.
    const globalRound = `puzzle-${puzzleIndex}`;
    tabs.push({
      id: 'global',
      label: 'Global',
      emptyText: 'No scores yet — be the first on the board.',
      load: () => OR.scores.top({ roundKey: globalRound, order: 'top', limit: BOARD_LIMIT }),
      // The viewer's own placement when they're outside the top 20. Separately
      // gated: `scores.rank` ships after `scores.top`, so a host can have the
      // board and not the rank. The panel only calls this when the viewer is
      // absent from the rows above, and a failure costs the pinned row alone.
      ...(OR.capabilities.has('scores.rank')
        ? {
            loadPinned: () =>
              OR.scores.rank({ roundKey: globalRound, order: 'top' }).then(pinnedFromRank),
          }
        : {}),
      formatValue: formatScore,
    });
  }

  // Monthly board — total points, since globe's 0–15,000 range separates
  // players on its own and needs no qualifier rule to explain (§3.7). Unlike
  // the daily boards this one accumulates, which is the point: a daily game
  // whose leaderboard wipes at midnight never remembers that you came back.
  if (OR.capabilities.has('scores.season')) {
    tabs.push(
      createSeasonTab({
        load: () => OR.scores.season({ period: currentPeriod(), limit: BOARD_LIMIT }),
        ...(OR.capabilities.has('scores.seasonRank')
          ? { loadRank: () => OR.scores.seasonRank({ period: currentPeriod() }) }
          : {}),
      })
    );
  }

  const wrap = document.createElement('section');
  wrap.className = 'friends-panel';
  wrap.appendChild(
    slot.mount(
      createLeaderboardPanel({
        tabs,
        viewerUuid: OR.user?.uuid ?? null,
        // Naming the tab explicitly matters for more than preference: the
        // friends rows are already in hand, so this paints immediately instead
        // of waiting on the global board's fetch. Falling back to Global when
        // the viewer follows nobody (or isn't signed in) is the §3.4 rule —
        // land on a populated board rather than on a prompt to go make friends.
        defaultTab:
          friendRows.length > 0 || tabs.length === 1 ? 'friends' : 'global',
      })
    )
  );
  return wrap;
}

/**
 * The viewer plus the friends they follow, ranked by score descending.
 *
 * The viewer's own entry has two sources, in priority order: `viewerResult` from
 * the live end-of-game flow, which is available before the `scores.friends`
 * round-trip returns, and the backend's own `isSelf` row for the past-round
 * modal, where local state isn't archived. Whichever wins, the other branch is
 * filtered out, so the viewer never renders twice.
 */
function friendsRows(
  friends: FriendScore[] | undefined,
  viewerResult: { total: number } | null
): LeaderboardRow[] {
  const all = friends ?? [];
  const selfFromBackend = all.find((f) => f.isSelf) ?? null;
  const rows: LeaderboardRow[] = all.filter((f) => !f.isSelf);

  const user = window.OddsRabbit.user;
  if (viewerResult && user) {
    rows.push({
      uuid: user.uuid,
      username: user.username,
      score: viewerResult.total,
      // Not rendered by either board here; the live result has no server
      // timestamp to quote and inventing one would be worse than an empty
      // string, which `formatScore` never reads.
      createdAt: '',
      avatar: user.avatar,
      metadata: null,
      isSelf: true,
    });
  } else if (selfFromBackend) {
    rows.push(selfFromBackend);
  }

  // A list holding nobody but the viewer isn't a comparison — hand back an
  // empty board so the "follow someone" copy shows instead of a leaderboard of
  // one.
  if (rows.every((row) => row.isSelf)) return [];

  // Ties: the viewer sorts first, so they can find themselves.
  rows.sort((a, b) => b.score - a.score || (a.isSelf ? -1 : b.isSelf ? 1 : 0));
  return rows;
}

/**
 * Run the end-screen reveal animations on a freshly-rendered subtree:
 *  - count up any `[data-count-to]` number (verdict total, percentile)
 *  - grow any `[data-fill-to]` distribution bar from 0 to its width
 * Idempotent per element (cleared after running). Respects reduced-motion.
 */
function runEndGameAnimations(root: HTMLElement): void {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  root.querySelectorAll<HTMLElement>('[data-fill-to]').forEach((el) => {
    const to = el.dataset.fillTo!;
    delete el.dataset.fillTo;
    if (reduce) {
      el.style.width = `${to}%`;
      return;
    }
    requestAnimationFrame(() => {
      el.style.width = `${to}%`;
    });
  });

  root.querySelectorAll<HTMLElement>('[data-count-to]').forEach((el) => {
    const target = Number(el.dataset.countTo);
    const suffix = el.textContent?.includes('%') ? '%' : '';
    delete el.dataset.countTo;
    if (reduce || !Number.isFinite(target)) {
      el.textContent = target.toLocaleString() + suffix;
      return;
    }
    const durationMs = 800;
    let startTs: number | null = null;
    const step = (ts: number): void => {
      if (startTs === null) startTs = ts;
      const p = Math.min(1, (ts - startTs) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      el.textContent = Math.round(target * eased).toLocaleString() + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function nextResetMs(): number {
  const now = new Date();
  return (
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) -
    now.getTime()
  );
}

function formatTimeUntilReset(): string {
  const ms = Math.max(0, nextResetMs());
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `Next puzzle in ${hours}h ${minutes}m` : `Next puzzle in ${minutes}m`;
}

function renderResetTime(): HTMLElement {
  const el = document.createElement('p');
  el.className = 'reset-time';
  el.textContent = formatTimeUntilReset();
  if (resetTimeInterval !== undefined) window.clearInterval(resetTimeInterval);
  resetTimeInterval = window.setInterval(() => {
    if (!el.isConnected) {
      window.clearInterval(resetTimeInterval);
      resetTimeInterval = undefined;
      return;
    }
    el.textContent = formatTimeUntilReset();
  }, 60_000);
  return el;
}

// ---------- Toast / modal ----------

function showToast(message: string): void {
  document.querySelector('.toast')?.remove();
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

function showInstructions(onClose?: () => void): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', 'modal-title');
  backdrop.innerHTML = `
    <div class="modal">
      <h2 id="modal-title">How to play</h2>
      <p>Each day brings <strong>three photos</strong> from somewhere in the world. For each one, tap the map to drop a pin where you think it was taken, then hit <strong>Guess</strong>.</p>
      <p class="legend-note">The closer your pin, the more of the 5,000 points you keep — so a perfect guess is 15,000 across the three rounds. A new puzzle drops every day at midnight UTC.</p>
      <button type="button" class="modal-close">Got it</button>
    </div>
  `;
  document.body.appendChild(backdrop);
  const close = (): void => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (onClose) onClose();
  };
  backdrop.querySelector<HTMLButtonElement>('.modal-close')!.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
}

// ---------- Game flow ----------

async function submitGuess(): Promise<void> {
  const state = currentState;
  if (state.status !== 'in_progress' || pendingPin === null) return;
  const location = state.locations[state.current]!;
  const km = haversineKm(pendingPin.lat, pendingPin.lng, location.lat, location.lng);
  state.guesses[state.current] = {
    lat: pendingPin.lat,
    lng: pendingPin.lng,
    km,
    score: scoreForKm(km),
  };
  pendingPin = null;
  void window.OddsRabbit.actions.haptic('success');
  await writeJson('today', state);
  render();
}

async function advanceRound(): Promise<void> {
  const state = currentState;
  if (state.current < ROUNDS_PER_DAY - 1) {
    state.current += 1;
    pendingPin = null;
    await writeJson('today', state);
    render();
    return;
  }
  // Last round done — finalize the day.
  state.status = 'complete';
  await writeJson('today', state);

  const total = totalScore(state);
  const [stats, streak] = await Promise.all([
    readJson<Stats>('stats', DEFAULT_STATS),
    readJson<Streak>('streak', DEFAULT_STREAK),
  ]);
  currentStats = applyResultToStats(stats, total);
  currentStreak = applyResultToStreak(streak, state.puzzleIndex);
  await Promise.all([
    writeJson('stats', currentStats),
    writeJson('streak', currentStreak),
    submitScoreToServer(state),
  ]);
  const [friends, community] = await Promise.all([
    loadFriends(state.puzzleIndex),
    loadCommunityData(state.puzzleIndex),
  ]);
  currentFriends = friends;
  currentCommunity = community;
  render();
}

// ---------- Share ----------

const SHARE_LANDING_URL = 'https://www.oddsrabbit.com/games/rabbit-globe/';

// Per-round closeness tier by great-circle distance: 0 = nailed it … 4 = wrong
// side of the world. Drives both the share emoji and the image colors so the
// two always agree.
function closenessTier(km: number): number {
  return km < 50 ? 0 : km < 500 ? 1 : km < 2000 ? 2 : km < 8000 ? 3 : 4;
}
const TIER_EMOJI = ['🟩', '🟨', '🟧', '🟥', '⬛'];
const TIER_COLOR = ['#4a9d54', '#e0b93a', '#e0843a', '#d6543f', '#3a3a3a'];

/**
 * Exact distance — the precise number is the competitive brag. Mirrors the
 * in-game `formatKm`: one decimal under 10 km so a near-perfect guess keeps its
 * tiebreaker (3.4 km, not "3 km"), whole kilometres with grouping above.
 */
function shareKm(km: number): string {
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString()} km`;
}

/**
 * One line per round: closeness color + actual distance — the distance is the
 * real brag in a geo game, and it's spoiler-safe (your error, not the location).
 */
function buildShareGrid(state: State): string {
  return state.guesses
    .map((g) => (g ? `${TIER_EMOJI[closenessTier(g.km)]} ${shareKm(g.km)}` : '⬜ —'))
    .join('\n');
}

function buildShareTitle(state: State): string {
  return `RabbitGlobe #${state.puzzleIndex + 1} — ${totalScore(state).toLocaleString()} / ${MAX_TOTAL.toLocaleString()}`;
}

function buildShareText(state: State): string {
  return `${buildShareTitle(state)}\n\n${buildShareGrid(state)}\n\nPlay at ${SHARE_LANDING_URL}`;
}

async function shareResult(state: State): Promise<void> {
  showShareModal(state);
}

function showShareModal(state: State): void {
  const title = buildShareTitle(state);
  const grid = buildShareGrid(state);
  const text = buildShareText(state);

  // Native share is gated to touch devices: desktop OS share sheets are anemic and
  // the unique value (send to a specific chat in one tap) is mobile-only.
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
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
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
      // Route through the SDK so the call runs in the outer host's context where
      // Permissions Policy doesn't gate navigator.share.
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
      openShareUrl(
        `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(SHARE_LANDING_URL)}`
      );
      return;
    case 'download-image':
      try {
        const blob = await buildShareImage(state);
        triggerDownload(blob, `rabbitglobe-${state.puzzleIndex + 1}.png`);
      } catch {
        showToast('Could not generate image');
      }
      return;
    case 'share-image':
      try {
        const blob = await buildShareImage(state);
        const file = new File([blob], `rabbitglobe-${state.puzzleIndex + 1}.png`, {
          type: 'image/png',
        });
        await navigator.share({ title, text, files: [file] });
      } catch {
        /* user-cancelled or unavailable */
      }
      return;
  }
}

function openShareUrl(url: string): void {
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
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const SQUARE_EMPTY = '#d4d6db';

/** Load a cross-origin image for canvas compositing. `crossOrigin` keeps the
 * canvas un-tainted so toBlob works (images.oddsrabbit.com sends ACAO:*). */
function loadShareImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('share image load failed'));
    img.src = url;
  });
}

/** Draw `img` into the target rect with object-fit: cover (center-crop). */
function drawImageCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

// Renders the result as a 1080×1080 PNG: today's first clue photo on top (the
// question, not the answer — no location is ever shown), then one tile per round
// colored by closeness with the exact distance under each.
async function buildShareImage(state: State): Promise<Blob> {
  const SIZE = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Title + subtitle.
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 64px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('RabbitGlobe', SIZE / 2, 64);

  ctx.fillStyle = '#666666';
  ctx.font = '500 38px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText(
    `Puzzle #${state.puzzleIndex + 1} · ${totalScore(state).toLocaleString()} / ${MAX_TOTAL.toLocaleString()}`,
    SIZE / 2,
    150
  );

  // Clue photo band (best-effort — skipped if it fails to load). Shows today's
  // FIRST photo: the prompt, never the location.
  let tilesTop = 250;
  const firstImage = state.locations[0]?.image;
  if (firstImage) {
    try {
      const img = await loadShareImage(firstImage);
      const px = 90;
      const pw = SIZE - 2 * px;
      const py = 220;
      const ph = 430;
      ctx.save();
      drawRoundedRect(ctx, px, py, pw, ph, 24);
      ctx.clip();
      drawImageCover(ctx, img, px, py, pw, ph);
      ctx.restore();
      tilesTop = py + ph + 50;
    } catch {
      /* no photo — fall back to the tiles-only layout below */
    }
  }

  // One tile per round, colored by closeness, exact distance underneath.
  const COLS = ROUNDS_PER_DAY;
  const TILE = 180;
  const GAP = 30;
  const gridW = COLS * TILE + (COLS - 1) * GAP;
  const startX = (SIZE - gridW) / 2;
  const footerTop = SIZE - 130;
  const blockH = TILE + 64;
  const startY = tilesTop + Math.max(0, (footerTop - tilesTop - blockH) / 2);
  const RADIUS = 18;
  state.guesses.forEach((g, i) => {
    const x = startX + i * (TILE + GAP);
    ctx.fillStyle = g ? TIER_COLOR[closenessTier(g.km)]! : SQUARE_EMPTY;
    drawRoundedRect(ctx, x, startY, TILE, TILE, RADIUS);
    ctx.fill();
    ctx.fillStyle = '#333333';
    ctx.font = '600 36px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(g ? shareKm(g.km) : '—', x + TILE / 2, startY + TILE + 14);
  });

  ctx.fillStyle = '#999999';
  ctx.font = '500 30px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.fillText('oddsrabbit.com/games/rabbit-globe', SIZE / 2, SIZE - 60);

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

// ---------- Past-day leaderboard modal + deep-link ----------

/**
 * Parse an opaque initialState payload into a leaderboard intent (a past puzzle
 * index), or null. The shell forwards initialState verbatim (push tap, etc.) so
 * validate defensively. Expected: `{ target: 'leaderboard', roundKey: 'puzzle-N' }`.
 */
function parseLeaderboardIntent(initialState: Record<string, unknown> | null): number | null {
  if (!initialState) return null;
  if (initialState.target !== 'leaderboard') return null;
  const roundKey = initialState.roundKey;
  if (typeof roundKey !== 'string') return null;
  const match = /^puzzle-(\d+)$/.exec(roundKey);
  return match ? parseInt(match[1]!, 10) : null;
}

/**
 * Results overlay for a past puzzle (header 🏆 or a push deep-link): the viewed
 * round's community distribution + friends, with prev/next across the last 7 days.
 * The viewer's own bucket comes from the backend `isSelf` row (we don't archive
 * past boards locally).
 */
async function showLeaderboardModal(puzzleIndex: number): Promise<void> {
  document.querySelector('.leaderboard-modal-backdrop')?.remove();

  const today = todayPuzzleIndex();
  const lowerBound = Math.max(0, today - 7);
  const upperBound = today - 1;
  let viewIndex = puzzleIndex;
  let requestToken = 0; // stale-response guard for rapid prev/next
  // Own slot, not the end-game screen's: this modal opens over a finished game
  // whose board is still mounted behind it.
  const modalPanelSlot = panelSlot();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop leaderboard-modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', 'leaderboard-modal-title');

  const modal = document.createElement('div');
  modal.className = 'modal leaderboard-modal';

  const titleRow = document.createElement('div');
  titleRow.className = 'leaderboard-title-row';
  const chevron = (dir: 'left' | 'right'): string => {
    const points = dir === 'left' ? '15 6 9 12 15 18' : '9 6 15 12 9 18';
    return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="${points}"/></svg>`;
  };
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'leaderboard-nav-btn';
  prevBtn.setAttribute('aria-label', 'Previous day');
  prevBtn.innerHTML = chevron('left');
  const title = document.createElement('h2');
  title.id = 'leaderboard-modal-title';
  title.className = 'leaderboard-title';
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'leaderboard-nav-btn';
  nextBtn.setAttribute('aria-label', 'Next day');
  nextBtn.innerHTML = chevron('right');
  titleRow.append(prevBtn, title, nextBtn);
  modal.appendChild(titleRow);

  const subtitle = document.createElement('p');
  subtitle.className = 'leaderboard-modal-subtitle';
  modal.appendChild(subtitle);

  const body = document.createElement('div');
  body.className = 'leaderboard-modal-body';
  modal.appendChild(body);

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'share-action share-action-primary';
  playBtn.dataset.action = 'play';
  playBtn.textContent = "Play today's puzzle";
  modal.appendChild(playBtn);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const load = async (): Promise<void> => {
    const myToken = ++requestToken;
    title.textContent = `Puzzle #${viewIndex + 1} results`;
    subtitle.textContent = formatPuzzleDate(viewIndex);
    prevBtn.disabled = viewIndex <= lowerBound;
    nextBtn.disabled = viewIndex >= upperBound;
    body.innerHTML = '<p class="leaderboard-loading">Loading…</p>';

    const [friends, community] = await Promise.all([
      loadFriends(viewIndex),
      loadCommunityData(viewIndex),
    ]);
    if (myToken !== requestToken) return;

    const self = friends.find((f) => f.isSelf);
    const viewerTotal = self ? self.score : null;
    body.innerHTML = '';
    body.appendChild(renderCommunityDistribution(community, viewerTotal, 'How everyone did'));
    body.appendChild(renderLeaderboardPanel(modalPanelSlot, viewIndex, friends, null));
    runEndGameAnimations(body);
  };

  prevBtn.addEventListener('click', () => {
    if (viewIndex > lowerBound) {
      viewIndex -= 1;
      void load();
    }
  });
  nextBtn.addEventListener('click', () => {
    if (viewIndex < upperBound) {
      viewIndex += 1;
      void load();
    }
  });

  const close = (): void => {
    document.removeEventListener('keydown', onKey);
    modalPanelSlot.clear();
    backdrop.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      close();
      return;
    }
    const target = (e.target as HTMLElement).closest('[data-action]') as HTMLButtonElement | null;
    if (target && (target.dataset.action === 'close' || target.dataset.action === 'play')) close();
  });

  await load();
}

// ---------- Bootstrap ----------

/** Holding screen when today's server locations aren't available (no fallback). */
function renderUnavailable(): void {
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'end-game';
  wrap.setAttribute('role', 'status');
  const verdict = document.createElement('p');
  verdict.className = 'verdict';
  verdict.textContent = "Today's puzzle isn't available yet.";
  const sub = document.createElement('p');
  sub.textContent = 'Check back in a moment, or make sure you have a connection.';
  wrap.appendChild(verdict);
  wrap.appendChild(sub);
  wrap.appendChild(renderResetTime());
  root.appendChild(wrap);
}

async function bootstrap(): Promise<void> {
  await window.OddsRabbit.whenReady();

  const [state, stats, streak, seenIntro] = await Promise.all([
    loadState(),
    readJson<Stats>('stats', DEFAULT_STATS),
    readJson<Streak>('streak', DEFAULT_STREAK),
    readJson<boolean>('seen_intro', false),
  ]);
  currentStats = stats;
  currentStreak = streak;

  // No playable game: locations are server-only and today's aren't available
  // (unsupported host, unseeded round, or offline). Show a holding screen.
  if (!state) {
    renderUnavailable();
    window.OddsRabbit.ready();
    return;
  }

  currentState = state;

  if (state.status === 'complete') {
    await submitScoreToServer(state);
    const [friends, community] = await Promise.all([
      loadFriends(state.puzzleIndex),
      loadCommunityData(state.puzzleIndex),
    ]);
    currentFriends = friends;
    currentCommunity = community;
  }

  window.OddsRabbit.lifecycle.on('pause', () => {
    void writeJson('today', currentState);
  });

  render();

  // Deep-link from a push tap: overlay a past round's results on today's game.
  const leaderboardPuzzleIndex = parseLeaderboardIntent(window.OddsRabbit.initialState);
  const shouldShowLeaderboard =
    leaderboardPuzzleIndex !== null && leaderboardPuzzleIndex !== state.puzzleIndex;

  if (!seenIntro) {
    showInstructions(() => {
      void writeJson('seen_intro', true);
      if (shouldShowLeaderboard) void showLeaderboardModal(leaderboardPuzzleIndex);
    });
  } else if (shouldShowLeaderboard) {
    void showLeaderboardModal(leaderboardPuzzleIndex);
  }

  window.OddsRabbit.ready();
}

bootstrap().catch((error) => {
  root.textContent = `Failed to start: ${error instanceof Error ? error.message : String(error)}`;
});
