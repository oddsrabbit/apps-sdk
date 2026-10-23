/**
 * The playground page: a stand-in for oddsrabbit.com around the real sandbox
 * host, so a developer can run a game from their own machine without
 * registering it.
 *
 * It frames `../host/?app=<slug>&gameUrl=<their url>` and does everything the
 * games page (`inc/js/pages/games.js`) and the mobile app (`AppHost.tsx`) do
 * from the outside: answers `host-ready` with `init`, answers every bridge
 * request, sends lifecycle events. The answers come from FakePlatform, which
 * copies the server's rules; this file owns the parts that need a person
 * (share sheets, the sign-in prompt), persistence, and the controls.
 *
 * Served from the same origin as the host, which is what lets it set the
 * mobile app's inset properties on the host's <html> for the phone frames.
 *
 * Everything a game sends is rendered with textContent, never as HTML: this
 * page runs on apps.oddsrabbit.com.
 */

import {
  BRIDGE_REQUEST_TYPES,
  CHAT_ERROR_CODES,
  CONTENT_ERROR_CODES,
  GIFT_ERROR_CODES,
  MATCH_ERROR_CODES,
  NOTIFICATION_ERROR_CODES,
  SOCIAL_ERROR_CODES,
  VISIT_ERROR_CODES,
} from '../schemas/messages';
import {
  DEFAULT_PLAYER,
  FRIENDS,
  FakePlatform,
  emptyState,
  visitLine,
  type DailyRound,
  type Outcome,
  type PlaygroundSettings,
  type PlaygroundState,
  type PlaygroundUser,
  type Reminder,
} from './fake-platform';

type Device = 'web' | 'iphone' | 'android';
type HostKind = 'web' | 'app';

interface Config {
  gameUrl: string;
  slug: string;
  device: Device;
  scheme: 'light' | 'dark';
  signedIn: boolean;
  username: string;
  supporter: boolean;
  host: HostKind;
  scopes: string[];
  fillBoards: boolean;
  pushReachable: boolean;
  delay: number;
  initialState: string;
  dailyContent: string;
  visitLines: string;
}

interface ErrorRule {
  verb: string;
  code: string;
  mode: 'once' | 'always';
}

interface LogEntry {
  at: number;
  direction: 'in' | 'out';
  verb: string;
  payload?: unknown;
  outcome?: Outcome;
  ms?: number;
}

/**
 * The phone frames: screen size, status bar and home-indicator insets in CSS
 * px. Approximate, and enough to see where the app's chrome lands. The 56px
 * row and the 12px/32px back button are the app's own numbers
 * (GamePlayScreen.tsx, docs/game-header-guidelines.md).
 */
const DEVICES: Record<Exclude<Device, 'web'>, { width: number; height: number; top: number; bottom: number }> = {
  iphone: { width: 393, height: 852, top: 59, bottom: 34 },
  android: { width: 412, height: 915, top: 28, bottom: 16 },
};
const CHROME_ROW_HEIGHT = 56;
const CHROME_ROW_START = 56;

const CONFIG_KEY = 'oddsrabbit:playground:v1';
const STATE_KEY = (slug: string) => `oddsrabbit:playground:v1:state:${slug}`;
const ERRORS_KEY = 'oddsrabbit:playground:v1:errors';
/** Must match DEV_GUEST_STORAGE_PREFIX in src/host/host.ts. */
const GUEST_PREFIX = (slug: string) => `oddsrabbit:apps-dev:${slug}:`;
const LOG_LIMIT = 300;

const DAILY_EXAMPLE = JSON.stringify(
  { '*': { content: { answer: 'CARROT' } }, '2026-10-22': { content: { answer: 'BUNNY' }, reveals: [{ hint: 'first' }] } },
  null,
  2
);

/** Multiplayer needs rules on our server, so neither preset offers it. */
const SIMULATED = BRIDGE_REQUEST_TYPES.filter((v) => !v.startsWith('matches.') && v !== 'ready');
const CAPABILITIES: Record<HostKind, string[]> = {
  web: SIMULATED,
  app: SIMULATED.filter((v) => v !== 'actions.requestSignIn'),
};

const KNOWN_CODES = [
  'bridge/unknown-type',
  'scores/already-submitted',
  'scores/unauthorized',
  'storage/tuple-size-exceeded',
  'storage/unauthorized',
  ...Object.values(CONTENT_ERROR_CODES),
  ...Object.values(CHAT_ERROR_CODES),
  ...Object.values(NOTIFICATION_ERROR_CODES),
  ...Object.values(SOCIAL_ERROR_CODES),
  ...Object.values(GIFT_ERROR_CODES),
  ...Object.values(VISIT_ERROR_CODES),
  ...Object.values(MATCH_ERROR_CODES),
];

// ---- small helpers ----------------------------------------------------------

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

function input(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string } = {},
  children: Node[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const child of children) node.appendChild(child);
  return node;
}

function button(text: string, onClick: () => void, className = 'btn small'): HTMLButtonElement {
  const b = el('button', { className, text });
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function readStore<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStore(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Long strings (picture data URLs) shortened for the log. */
function summarize(value: unknown): string {
  const text = JSON.stringify(
    value,
    (_key, v: unknown) => (typeof v === 'string' && v.length > 120 ? `${v.slice(0, 60)}… (${v.length} chars)` : v),
    2
  );
  return text ?? 'undefined';
}

function relative(iso: string): string {
  const diff = Date.parse(iso) - Date.now();
  const minutes = Math.round(Math.abs(diff) / 60_000);
  const span = minutes < 60 ? `${minutes} min` : minutes < 2880 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
  return diff >= 0 ? `in ${span}` : `${span} ago`;
}

function isPicture(url: unknown): url is string {
  return typeof url === 'string' && /^data:image\/(png|jpeg);base64,/.test(url);
}

// ---- state ------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const saved = readStore<Partial<Config>>(CONFIG_KEY) ?? {};
const config: Config = {
  gameUrl: '',
  slug: 'my-game',
  device: 'web',
  scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  signedIn: true,
  username: DEFAULT_PLAYER.username,
  supporter: false,
  host: 'web',
  scopes: ['bridge:notifications', 'bridge:social', 'bridge:submit'],
  fillBoards: true,
  pushReachable: true,
  delay: 0,
  initialState: '',
  dailyContent: DAILY_EXAMPLE,
  visitLines: '',
  ...saved,
};
if (params.get('gameUrl')) config.gameUrl = params.get('gameUrl')!;
if (params.get('app')) config.slug = params.get('app')!;

let errorRules: ErrorRule[] = readStore<ErrorRule[]>(ERRORS_KEY) ?? [];
const log: LogEntry[] = [];
/** The last daily content that parsed, kept in use while the editor holds a typo. */
let lastGoodDaily: Record<string, DailyRound> = {};
let platform = makePlatform();
let initialStateForNextLoad: Record<string, unknown> | null = null;

function player(): PlaygroundUser | null {
  if (!config.signedIn) return null;
  return { ...DEFAULT_PLAYER, username: config.username.trim() || DEFAULT_PLAYER.username, supporter: config.supporter };
}

function parseDaily(text: string): Record<string, DailyRound> {
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object of round keys.');
  for (const [key, round] of Object.entries(parsed as Record<string, unknown>)) {
    const content = (round as { content?: unknown } | null)?.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      throw new Error(`"${key}" needs a "content" object.`);
    }
  }
  return parsed as Record<string, DailyRound>;
}

function settings(): PlaygroundSettings {
  try {
    lastGoodDaily = parseDaily(config.dailyContent);
  } catch {
    // Shown next to the editor; the last good content stays in use.
  }
  return {
    user: player(),
    scopes: config.scopes,
    fillBoards: config.fillBoards,
    pushReachable: config.pushReachable,
    dailyContent: lastGoodDaily,
  };
}

function makePlatform(): FakePlatform {
  const state = { ...emptyState(), ...(readStore<PlaygroundState>(STATE_KEY(config.slug)) ?? {}) };
  return new FakePlatform(state, settings());
}

function saveConfig(): void {
  writeStore(CONFIG_KEY, config);
}

function saveState(): void {
  if (writeStore(STATE_KEY(config.slug), platform.state)) return;
  // Pictures are what fill the quota. Keep everything else.
  writeStore(STATE_KEY(config.slug), { ...platform.state, submissions: [] });
}

function visitLines(): Record<string, string> {
  try {
    const parsed = JSON.parse(config.visitLines || '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// ---- the host frame ---------------------------------------------------------

const hostFrame = $('host-frame') as HTMLIFrameElement;
const deviceFrame = $('device-frame');
const stage = $('stage');
let hostReady = false;

function hostWindow(): Window | null {
  return hostFrame.contentWindow;
}

function post(message: unknown): void {
  hostWindow()?.postMessage(message, location.origin);
}

function sessionToken(user: PlaygroundUser): string {
  // Shaped like the real token, signed by nothing: a backend that verifies it
  // against the JWKS, as it should, turns it away.
  const now = Math.floor(Date.now() / 1000);
  return [
    base64url({ alg: 'none', typ: 'JWT' }),
    base64url({ iss: 'https://oddsrabbit.com', aud: 'playground', sub: user.uuid, iat: now, exp: now + 3600, playground: true }),
    '',
  ].join('.');
}

function sendInit(): void {
  const user = player();
  const message: Record<string, unknown> = {
    type: 'init',
    user,
    sessionToken: user ? sessionToken(user) : null,
    expiresAt: user ? new Date(Date.now() + 3600_000).toISOString() : null,
    colorScheme: config.scheme,
    capabilities: CAPABILITIES[config.host],
  };
  if (initialStateForNextLoad) message.initialState = initialStateForNextLoad;
  initialStateForNextLoad = null;
  post(message);
  record({ at: Date.now(), direction: 'out', verb: 'init', payload: message });
}

function loadGame(): void {
  if (!config.gameUrl) return;
  hostReady = false;
  platform = makePlatform();
  try {
    const typed = config.initialState.trim() ? (JSON.parse(config.initialState) as Record<string, unknown>) : null;
    if (typed && !initialStateForNextLoad) initialStateForNextLoad = typed;
  } catch {
    toast('initialState is not valid JSON, so it was left out.');
  }
  $('empty').hidden = true;
  deviceFrame.hidden = false;
  applyDevice();
  const url = new URL('../host/', location.href);
  url.searchParams.set('app', config.slug);
  url.searchParams.set('gameUrl', config.gameUrl);
  url.searchParams.set('colorScheme', config.scheme);
  let previous: Document | null = null;
  try {
    previous = hostFrame.contentDocument;
  } catch {
    // Not ours to read; any document after this one is new.
  }
  hostFrame.src = url.toString();
  watchHostDocument(previous);
  renderData();
}

/**
 * Hand the host the app's inset properties as soon as its document exists,
 * as the app does by injecting a script. Polls because the document is
 * replaced when the frame navigates and there is no event for that.
 */
function watchHostDocument(previous: Document | null): void {
  const started = Date.now();
  const tick = () => {
    let doc: Document | null = null;
    try {
      doc = hostFrame.contentDocument;
    } catch {
      return;
    }
    if (doc && doc !== previous && doc.URL.includes('/host/') && doc.documentElement) {
      applyInsets(doc);
      return;
    }
    if (Date.now() - started < 5000) requestAnimationFrame(tick);
  };
  tick();
}

function applyInsets(doc: Document): void {
  const style = doc.documentElement.style;
  const names = ['--oddsrabbit-inset-top', '--oddsrabbit-inset-right', '--oddsrabbit-inset-bottom', '--oddsrabbit-inset-left', '--oddsrabbit-chrome-height', '--oddsrabbit-chrome-start'];
  if (config.device === 'web') {
    for (const name of names) style.removeProperty(name);
    return;
  }
  const d = DEVICES[config.device];
  style.setProperty('--oddsrabbit-inset-top', `${d.top + CHROME_ROW_HEIGHT}px`);
  style.setProperty('--oddsrabbit-inset-right', '0px');
  style.setProperty('--oddsrabbit-inset-bottom', `${d.bottom}px`);
  style.setProperty('--oddsrabbit-inset-left', '0px');
  style.setProperty('--oddsrabbit-chrome-height', `${CHROME_ROW_HEIGHT}px`);
  style.setProperty('--oddsrabbit-chrome-start', `${CHROME_ROW_START}px`);
}

// Backstop for the poll above, should a slow frame outlast it.
hostFrame.addEventListener('load', () => {
  try {
    if (hostFrame.contentDocument) applyInsets(hostFrame.contentDocument);
  } catch {
    // Not same-origin: nothing to set.
  }
});

function applyDevice(): void {
  deviceFrame.dataset.device = config.device;
  const chrome = $('chrome');
  chrome.hidden = config.device === 'web';
  if (config.device === 'web') {
    deviceFrame.style.width = '';
    deviceFrame.style.height = '';
    deviceFrame.style.transform = '';
    return;
  }
  const d = DEVICES[config.device];
  deviceFrame.style.width = `${d.width}px`;
  deviceFrame.style.height = `${d.height}px`;
  chrome.style.setProperty('--status', `${d.top}px`);
  chrome.style.setProperty('--home', `${d.bottom}px`);
  fitDevice();
}

function fitDevice(): void {
  if (config.device === 'web') return;
  const d = DEVICES[config.device];
  const scale = Math.min(1, (stage.clientWidth - 32) / d.width, (stage.clientHeight - 32) / d.height);
  deviceFrame.style.transform = `scale(${Math.max(scale, 0.3)})`;
}

/** Match the status bar text to the game's colour, as the app does. */
function syncStatusBar(): void {
  if (config.device === 'web') return;
  let color = '';
  try {
    const doc = hostFrame.contentDocument;
    if (doc) color = getComputedStyle(doc.documentElement).getPropertyValue('--bg').trim();
  } catch {
    return;
  }
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) return;
  const [r, g, b] = match.slice(1).map((h) => parseInt(h, 16)) as [number, number, number];
  $('chrome').dataset.tone = 0.299 * r + 0.587 * g + 0.114 * b < 140 ? 'dark' : 'light';
}

// ---- bridge -----------------------------------------------------------------

window.addEventListener('message', (event) => {
  if (event.source !== hostWindow() || event.origin !== location.origin) return;
  const data = event.data as { type?: unknown; correlationId?: unknown; payload?: unknown } | null;
  if (!data || typeof data.type !== 'string') return;
  if (data.type === 'host-ready') {
    hostReady = true;
    sendInit();
    return;
  }
  if (typeof data.correlationId !== 'string') return;
  void answer(data.type, data.correlationId, data.payload);
});

async function answer(verb: string, correlationId: string, payload: unknown): Promise<void> {
  const started = Date.now();
  platform.settings = settings();
  const outcome = forced(verb) ?? platform.handle(verb, payload) ?? (await pageOutcome(verb, payload));
  if (config.delay) await new Promise((resolve) => setTimeout(resolve, config.delay));
  post({ type: 'response', correlationId, ...outcome });
  record({ at: started, direction: 'in', verb, payload, outcome, ms: Date.now() - started });
  afterOutcome(verb, payload, outcome);
}

function forced(verb: string): Outcome | null {
  const rule = errorRules.find((r) => r.verb === verb);
  if (!rule) return null;
  if (rule.mode === 'once') {
    errorRules = errorRules.filter((r) => r !== rule);
    writeStore(ERRORS_KEY, errorRules);
    renderErrorRules();
  }
  return { ok: false, error: { code: rule.code, message: 'Forced by the playground.' } };
}

/** The verbs that need a person, and the ones the playground doesn't model. */
async function pageOutcome(verb: string, payload: unknown): Promise<Outcome> {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (verb) {
    case 'actions.share': {
      const parts = [p.title, p.text].filter((s): s is string => typeof s === 'string' && s !== '');
      toast(`Share sheet opened: ${parts.join(' — ') || '(nothing to share)'}`);
      return { ok: true };
    }
    case 'chat.sharePicture': {
      if (!player()) return { ok: false, error: { code: CHAT_ERROR_CODES.unauthorized, message: 'Not authenticated.' } };
      const choice = await pickChat(p.image, typeof p.caption === 'string' ? p.caption : '');
      if (choice) toast(`Picture sent to ${choice}.`);
      return { ok: true, result: { sent: choice !== null } };
    }
    case 'actions.requestSignIn':
      if (!player()) promptSignIn(typeof p.reason === 'string' ? p.reason : 'Sign in to save your progress.');
      return { ok: true };
    case 'session.refresh': {
      const user = player();
      if (!user) return { ok: false, error: { code: 'session/no-active', message: 'No active session to refresh.' } };
      setTimeout(sendInit, 0);
      return { ok: true, result: { sessionToken: sessionToken(user), expiresAt: new Date(Date.now() + 3600_000).toISOString() } };
    }
    default:
      return { ok: false, error: { code: 'bridge/unknown-type', message: `The playground doesn't simulate ${verb}.` } };
  }
}

/** What the player (or a friend) would see happen as a result of a call. */
function afterOutcome(verb: string, payload: unknown, outcome: Outcome): void {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (outcome.ok) {
    const friend = FRIENDS.find((f) => f.uuid === p.toUserUuid);
    const name = player()?.username ?? 'player';
    if (verb === 'gifts.send' && friend) toast(`${friend.username} gets a bell: ${name} sent you a gift.`);
    if (verb === 'visits.record' && friend) {
      toast(`${friend.username} gets a bell: ${visitLine(visitLines(), String(p.kind), name)}`);
    }
    if (verb === 'actions.haptic' && config.host === 'app') toast(`Haptic: ${String(p.type)}`);
    if (verb === 'content.submit') toast(`"${String(p.title)}" went to the review queue.`);
    if (verb === 'notifications.schedule') toast(`Reminder "${String(p.title)}" set for ${relative(String(p.fireAt))}.`);
  }
  if (verb !== 'ready' && verb !== 'time.now') {
    saveState();
    renderData();
  }
}

// ---- dialogs and toasts -------------------------------------------------------

const dialog = $('dialog') as HTMLDialogElement;

function openDialog(title: string, content: Node[], actions: Array<{ label: string; primary?: boolean; onClick: () => void }>): void {
  $('dialog-title').textContent = title;
  $('dialog-content').replaceChildren(...content);
  $('dialog-actions').replaceChildren(
    ...actions.map((action) =>
      button(
        action.label,
        () => {
          dialog.close();
          action.onClick();
        },
        action.primary ? 'btn primary' : 'btn'
      )
    )
  );
  dialog.showModal();
}

function pickChat(image: unknown, caption: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const content: Node[] = [];
    if (isPicture(image)) {
      const img = el('img', { className: 'dialog-picture' });
      img.src = image;
      img.alt = '';
      content.push(img);
    }
    if (caption) content.push(el('p', { text: caption }));
    content.push(el('p', { className: 'hint', text: "The host's own chat picker. The game never learns who it went to." }));
    dialog.addEventListener('close', () => settle(null), { once: true });
    openDialog('Send to a chat', content, [
      ...FRIENDS.slice(0, 3).map((f) => ({ label: f.username, onClick: () => settle(f.username) })),
      { label: 'Cancel', onClick: () => settle(null) },
    ]);
  });
}

function promptSignIn(reason: string): void {
  if (config.host === 'app') return;
  openDialog('Sign in to OddsRabbit', [el('p', { text: reason }), el('p', { className: 'hint', text: 'The prompt the games page shows. Signing in reloads the game as a signed-in player.' })], [
    { label: 'Not now', onClick: () => undefined },
    {
      label: 'Sign in',
      primary: true,
      onClick: () => {
        config.signedIn = true;
        saveConfig();
        syncControls();
        loadGame();
      },
    },
  ]);
}

function toast(text: string): void {
  const node = el('div', { className: 'toast', text });
  $('toasts').appendChild(node);
  setTimeout(() => node.remove(), 4000);
}

// ---- log ----------------------------------------------------------------------

function record(entry: LogEntry): void {
  log.unshift(entry);
  if (log.length > LOG_LIMIT) log.length = LOG_LIMIT;
  renderLog();
}

function renderLog(): void {
  $('log-count').textContent = String(log.length);
  const filter = input('log-filter').value.trim().toLowerCase();
  const items = log
    .filter((entry) => !filter || entry.verb.toLowerCase().includes(filter))
    .slice(0, 150)
    .map((entry) => {
      const failed = entry.outcome && !entry.outcome.ok;
      const status = entry.direction === 'out' ? 'sent' : failed ? (entry.outcome as { error: { code: string } }).error.code : 'ok';
      const summary = el('summary', {}, [
        el('span', { className: 'log-time', text: new Date(entry.at).toLocaleTimeString() }),
        el('span', { className: 'log-verb', text: entry.verb }),
        el('span', { className: `log-status ${failed ? 'bad' : entry.direction === 'out' ? 'muted' : 'good'}`, text: status }),
        el('span', { className: 'log-ms muted', text: entry.ms !== undefined ? `${entry.ms} ms` : '' }),
      ]);
      const body: Node[] = [el('pre', { text: `payload ${summarize(entry.payload)}` })];
      if (entry.outcome) {
        body.push(el('pre', { text: entry.outcome.ok ? `result ${summarize(entry.outcome.result)}` : `error ${summarize(entry.outcome.error)}` }));
      }
      return el('li', {}, [el('details', {}, [summary, ...body])]);
    });
  $('log').replaceChildren(...items);
}

// ---- data panel ---------------------------------------------------------------

function guestSaves(): Array<[string, string]> {
  const prefix = GUEST_PREFIX(config.slug);
  const rows: Array<[string, string]> = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) rows.push([key.slice(prefix.length), localStorage.getItem(key) ?? '']);
    }
  } catch {
    // Storage blocked; nothing to show.
  }
  return rows;
}

function renderData(): void {
  const signedIn = config.signedIn;
  const saves: Array<[string, string]> = signedIn ? Object.entries(platform.state.storage) : guestSaves();
  const bytes = saves.reduce((sum, [, v]) => sum + new TextEncoder().encode(v).length, 0);
  const used = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  $('saves-size').textContent = `${signedIn ? 'signed in' : 'guest, on this device'} · ${used} of 64 KB`;
  $('saves').replaceChildren(
    ...(saves.length
      ? saves.map(([key, value]) =>
          el('li', {}, [
            el('code', { text: key }),
            el('span', { className: 'muted grow', text: value.length > 80 ? `${value.slice(0, 80)}…` : value }),
            button('Delete', () => {
              if (signedIn) delete platform.state.storage[key];
              else localStorage.removeItem(GUEST_PREFIX(config.slug) + key);
              saveState();
              renderData();
            }),
          ])
        )
      : [el('li', { className: 'muted', text: 'No saves yet.' })])
  );

  const reminders = platform.state.reminders.map((r) =>
    el('li', {}, [
      el('span', { className: 'grow', text: `${r.title} · ${relative(r.fireAt)}` }),
      button('Deliver now', () => {
        r.fireAt = new Date(Date.now() - 1).toISOString();
        deliver();
      }),
    ])
  );
  const delivered = platform.state.delivered.slice(0, 5).map((r) =>
    el('li', {}, [
      el('span', { className: 'grow muted', text: `Delivered: ${r.title}` }),
      button('Open game from it', () => openFromReminder(r)),
    ])
  );
  $('reminders').replaceChildren(
    ...(reminders.length || delivered.length ? [...reminders, ...delivered] : [el('li', { className: 'muted', text: 'No reminders.' })])
  );

  const social = [
    ...platform.state.giftsInbox.slice(0, 5).map((g) =>
      el('li', { text: `Gift from ${g.from.username}: ${g.kind}${g.claimedAt ? ' (claimed)' : ''}` })
    ),
    ...platform.state.visitsInbox.slice(0, 5).map((v) =>
      el('li', { text: `Visit from ${v.from.username}: ${v.kind}${v.seenAt ? ' (seen)' : ''}` })
    ),
  ];
  $('social').replaceChildren(...social);

  $('submissions').replaceChildren(
    ...(platform.state.submissions.length
      ? platform.state.submissions.map((s) => {
          const children: Node[] = [];
          if (isPicture(s.image)) {
            const img = el('img');
            img.src = s.image;
            img.alt = '';
            children.push(img);
          }
          children.push(el('span', { className: 'grow', text: `${s.title} · ${s.kind}` }));
          return el('li', {}, children);
        })
      : [el('li', { className: 'muted', text: 'Nothing submitted yet.' })])
  );
}

function deliver(): void {
  for (const reminder of platform.deliverDue()) {
    toast(`Reminder delivered: ${reminder.title} — ${reminder.body}`);
  }
  saveState();
  renderData();
}

function openFromReminder(reminder: Reminder): void {
  // What a tap on the push does: the game opens on its play screen.
  initialStateForNextLoad = { target: 'play', reminderKey: reminder.key };
  loadGame();
}

function renderErrorRules(): void {
  $('error-rules').replaceChildren(
    ...errorRules.map((rule) =>
      el('li', {}, [
        el('code', { text: rule.verb }),
        el('span', { className: 'grow', text: `${rule.code} · ${rule.mode === 'once' ? 'next call' : 'every call'}` }),
        button('Remove', () => {
          errorRules = errorRules.filter((r) => r !== rule);
          writeStore(ERRORS_KEY, errorRules);
          renderErrorRules();
        }),
      ])
    )
  );
}

// ---- controls -------------------------------------------------------------------

function radios(name: string): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)];
}

function syncControls(): void {
  document.documentElement.dataset.colorScheme = config.scheme;
  input('game-url').value = config.gameUrl;
  input('app-slug').value = config.slug;
  ($('device') as HTMLSelectElement).value = config.device;
  ($('scheme') as HTMLSelectElement).value = config.scheme;
  for (const r of radios('signed-in')) r.checked = (r.value === 'yes') === config.signedIn;
  for (const r of radios('host')) r.checked = r.value === config.host;
  for (const r of radios('scope')) r.checked = config.scopes.includes(r.value);
  input('username').value = config.username;
  input('supporter').checked = config.supporter;
  input('fill-boards').checked = config.fillBoards;
  input('push-reachable').checked = config.pushReachable;
  ($('delay') as HTMLSelectElement).value = String(config.delay);
  input('initial-state').value = config.initialState;
  ($('daily-content') as HTMLTextAreaElement).value = config.dailyContent;
  ($('visit-lines') as HTMLTextAreaElement).value = config.visitLines;
}

function readControls(): void {
  config.gameUrl = input('game-url').value.trim();
  config.slug = input('app-slug').value.trim() || 'my-game';
  config.device = ($('device') as HTMLSelectElement).value as Device;
  config.scheme = ($('scheme') as HTMLSelectElement).value as Config['scheme'];
  config.signedIn = radios('signed-in').some((r) => r.checked && r.value === 'yes');
  config.host = (radios('host').find((r) => r.checked)?.value ?? 'web') as HostKind;
  config.scopes = radios('scope').filter((r) => r.checked).map((r) => r.value);
  config.username = input('username').value;
  config.supporter = input('supporter').checked;
  config.fillBoards = input('fill-boards').checked;
  config.pushReachable = input('push-reachable').checked;
  config.delay = Number(($('delay') as HTMLSelectElement).value) || 0;
  config.initialState = input('initial-state').value;
  config.visitLines = ($('visit-lines') as HTMLTextAreaElement).value;
  document.documentElement.dataset.colorScheme = config.scheme;
  saveConfig();
}

function bind(): void {
  $('load-form').addEventListener('submit', (event) => {
    event.preventDefault();
    readControls();
    loadGame();
  });
  $('reload').addEventListener('click', () => {
    readControls();
    loadGame();
  });
  for (const id of ['device', 'scheme']) {
    $(id).addEventListener('change', () => {
      readControls();
      if (hostFrame.src) loadGame();
    });
  }
  // Settings the fake reads on every call apply at once; the rest (who the
  // player is, the capability list) are in `init` and need a reload.
  for (const id of ['fill-boards', 'push-reachable', 'delay', 'visit-lines']) {
    $(id).addEventListener('change', readControls);
  }
  for (const r of radios('scope')) r.addEventListener('change', readControls);

  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-lifecycle]')) {
    b.addEventListener('click', () => {
      const event = b.dataset.lifecycle!;
      post({ type: 'lifecycle', event });
      record({ at: Date.now(), direction: 'out', verb: `lifecycle ${event}`, payload: { event } });
    });
  }

  for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll<HTMLButtonElement>('.tab')) {
        other.setAttribute('aria-selected', String(other === tab));
      }
      for (const panel of document.querySelectorAll<HTMLElement>('.tab-panel')) {
        panel.hidden = panel.dataset.panel !== tab.dataset.tab;
      }
    });
  }

  $('apply-content').addEventListener('click', () => {
    const text = ($('daily-content') as HTMLTextAreaElement).value;
    try {
      parseDaily(text);
      config.dailyContent = text;
      saveConfig();
      $('content-error').textContent = '';
      toast('Daily content updated.');
    } catch (error) {
      $('content-error').textContent = error instanceof Error ? error.message : String(error);
    }
  });

  const from = $('friend-from') as HTMLSelectElement;
  from.replaceChildren(...FRIENDS.map((f) => {
    const option = el('option', { text: f.username });
    option.value = f.uuid;
    return option;
  }));
  const friend = () => FRIENDS.find((f) => f.uuid === from.value) ?? FRIENDS[0]!;
  const kind = () => {
    const value = input('friend-kind').value.trim();
    if (!/^[a-z0-9-]{1,32}$/.test(value)) {
      toast('Kind must be 1–32 lowercase letters, digits or dashes.');
      return null;
    }
    return value;
  };
  $('receive-gift').addEventListener('click', () => {
    const k = kind();
    if (!k) return;
    const message = input('friend-message').value.trim();
    platform.receiveGift(friend(), k, message || null, input('friend-counts').checked);
    toast(`${friend().username} sent the player a ${k}. It's in gifts.inbox().`);
    saveState();
    renderData();
  });
  $('receive-visit').addEventListener('click', () => {
    const k = kind();
    if (!k) return;
    platform.receiveVisit(friend(), k, input('friend-counts').checked);
    toast(`The player's bell: ${visitLine(visitLines(), k, friend().username)}`);
    saveState();
    renderData();
  });

  $('clear-saves').addEventListener('click', () => {
    platform.state.storage = {};
    for (const [key] of guestSaves()) localStorage.removeItem(GUEST_PREFIX(config.slug) + key);
    saveState();
    renderData();
  });
  $('reset').addEventListener('click', () => {
    openDialog('Reset all test data?', [el('p', { text: `Saves, scores, reminders, gifts, visits and submissions for "${config.slug}" are removed.` })], [
      { label: 'Cancel', onClick: () => undefined },
      {
        label: 'Reset',
        primary: true,
        onClick: () => {
          platform.state = emptyState();
          for (const [key] of guestSaves()) localStorage.removeItem(GUEST_PREFIX(config.slug) + key);
          saveState();
          loadGame();
        },
      },
    ]);
  });

  const verbs = $('error-verb') as HTMLSelectElement;
  verbs.replaceChildren(...SIMULATED.map((v) => {
    const option = el('option', { text: v });
    option.value = v;
    return option;
  }));
  $('error-codes').replaceChildren(...[...new Set(KNOWN_CODES)].map((code) => {
    const option = el('option');
    option.value = code;
    return option;
  }));
  $('add-error').addEventListener('click', () => {
    const code = input('error-code').value.trim();
    if (!/^[a-z]+\/[a-z0-9-]+$/.test(code)) {
      toast('Codes look like area/name, e.g. gifts/too-many.');
      return;
    }
    errorRules = [
      ...errorRules.filter((r) => r.verb !== verbs.value),
      { verb: verbs.value, code, mode: ($('error-mode') as HTMLSelectElement).value as ErrorRule['mode'] },
    ];
    writeStore(ERRORS_KEY, errorRules);
    renderErrorRules();
  });

  input('log-filter').addEventListener('input', renderLog);
  $('clear-log').addEventListener('click', () => {
    log.length = 0;
    renderLog();
  });

  $('back-button').addEventListener('click', () => toast('The app would close the game here.'));
  window.addEventListener('resize', fitDevice);
}

syncControls();
bind();
renderErrorRules();
renderData();
setInterval(deliver, 15_000);
setInterval(syncStatusBar, 500);
if (config.gameUrl) loadGame();

// Exposed for a console session: `playground.platform.state`.
(window as unknown as { playground: unknown }).playground = {
  get platform() {
    return platform;
  },
  get hostReady() {
    return hostReady;
  },
};
