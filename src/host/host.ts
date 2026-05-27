import {
  BridgeOutboundSchema,
  BridgeRequestSchema,
  AppColorSchemeSchema,
  type BridgeOutbound,
  type BridgeRequest,
  type BridgeUser,
  type AppColorScheme,
} from '../schemas/messages';

const GUEST_STORAGE_PREFIX = 'oddsrabbit:apps';

type StorageRequest = Extract<
  BridgeRequest,
  { type: 'storage.get' | 'storage.set' | 'storage.delete' }
>;

function isStorageRequest(req: BridgeRequest): req is StorageRequest {
  return (
    req.type === 'storage.get' ||
    req.type === 'storage.set' ||
    req.type === 'storage.delete'
  );
}

interface ReactNativeWebViewBridge {
  postMessage(payload: string): void;
}

declare global {
  interface Window {
    ReactNativeWebView?: ReactNativeWebViewBridge;
  }
}

const params = new URLSearchParams(window.location.search);
const slug = params.get('app');
const devGameUrl = params.get('gameUrl');

// Parsed once at boot. The outer (WP page on web, RN host on mobile) appends
// `?colorScheme=` to the host URL so the host can style its own chrome AND
// forward the value to the inner game iframe URL — letting CSS-only games
// react via `[data-color-scheme="dark"]` selectors without loading the SDK.
// SDK consumers receive the same value via the `init` message's colorScheme
// field; both paths should always agree.
const colorSchemeParse = AppColorSchemeSchema.safeParse(params.get('colorScheme'));
const colorScheme: AppColorScheme = colorSchemeParse.success ? colorSchemeParse.data : 'light';
document.documentElement.dataset.colorScheme = colorScheme;

const isMobile = typeof window.ReactNativeWebView !== 'undefined';
const root = document.getElementById('root');
const status = document.getElementById('status');

function log(...args: unknown[]): void {
  // Filter in DevTools with: console = "apps:host"
  // eslint-disable-next-line no-console
  console.log('[apps:host]', ...args);
}

log('boot', { slug, isMobile, location: window.location.href });

bootstrap().catch((error) => {
  log('bootstrap rejected', formatError(error));
  showError(`Failed to start: ${formatError(error)}`);
});

async function bootstrap(): Promise<void> {
  if (!slug) {
    showError('Missing ?app= parameter.');
    return;
  }

  const gameUrl = await resolveGameUrl(slug, devGameUrl);
  if (!gameUrl) return;

  const iframe = createGameIframe(gameUrl);
  if (!root) return;

  root.removeAttribute('aria-busy');
  if (status) status.remove();

  // The bridge listener can be attached before load — but `host-ready` must
  // not fire until the inner iframe has finished loading, otherwise the
  // parent's `init` message races the SDK setup and gets dropped (no
  // listener yet means the message vanishes; postMessage doesn't queue).
  iframe.addEventListener('load', () => {
    log('inner iframe load fired');
    announceHostReady();
  }, { once: true });

  root.appendChild(iframe);
  setupBridge(iframe, slug);
  log('inner iframe mounted', { src: iframe.src });
}

function announceHostReady(): void {
  const ready = { type: 'host-ready' };
  if (isMobile) {
    log('post host-ready -> RN');
    window.ReactNativeWebView!.postMessage(JSON.stringify(ready));
  } else if (window.parent !== window) {
    log('post host-ready -> parent');
    window.parent.postMessage(ready, '*');
  } else {
    log('host-ready: no parent (standalone load)');
  }
}

async function resolveGameUrl(
  appSlug: string,
  override: string | null
): Promise<string | null> {
  if (override) {
    if (!isAllowedDevOverride(override)) {
      showError('Dev gameUrl override is only permitted in dev builds.');
      return null;
    }
    return override;
  }

  try {
    log('fetching manifest', appSlug);
    const response = await fetch(
      `https://www.oddsrabbit.com/api/oddsrabbit/v1/apps/${encodeURIComponent(appSlug)}`,
      { credentials: 'omit' }
    );
    if (!response.ok) {
      log('manifest not ok', response.status);
      showError(`App "${appSlug}" not found.`);
      return null;
    }
    const data = (await response.json()) as {
      manifest?: { appUrl?: string; updatedAt?: string };
    };
    const appUrl = data?.manifest?.appUrl;
    if (!appUrl) {
      log('manifest missing appUrl', data);
      showError('Manifest is missing appUrl.');
      return null;
    }
    // Append `updatedAt` to the inner iframe URL as a cache-bust value: when
    // the dev (or our setup tool) bumps the manifest, this changes, the
    // browser sees a new URL, and stale-cached app HTML stops being served.
    // Mirror of the outer-iframe bust applied by the WP page (games.js).
    const updatedAt = data?.manifest?.updatedAt;
    // Forward `colorScheme` to the inner game iframe so CSS-only games can
    // theme via `[data-color-scheme="dark"]` selectors with a one-line inline
    // script — no SDK dependency needed for static styling. SDK consumers get
    // the same value via init.colorScheme; both should always agree.
    const finalUrl = appendQueryParams(appUrl, {
      ...(updatedAt ? { v: updatedAt } : {}),
      colorScheme,
    });
    log('manifest ok', finalUrl);
    return finalUrl;
  } catch (error) {
    log('manifest fetch threw', formatError(error));
    showError(`Could not load manifest: ${formatError(error)}`);
    return null;
  }
}

function appendQueryParams(baseUrl: string, params: Record<string, string>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return baseUrl;
  const separator = baseUrl.includes('?') ? '&' : '?';
  const query = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${baseUrl}${separator}${query}`;
}

function isAllowedDevOverride(_url: string): boolean {
  // Phase 1 scaffolding: allow dev override on localhost / dev origins only.
  // Production builds replace this with a constant `false`.
  const host = window.location.hostname;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.endsWith('.local') ||
    host.endsWith('.dev')
  );
}

function createGameIframe(gameUrl: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.src = gameUrl;
  iframe.title = 'App';
  iframe.allow = 'fullscreen; clipboard-write';
  iframe.referrerPolicy = 'no-referrer';
  iframe.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-popups'
  );
  return iframe;
}

function setupBridge(iframe: HTMLIFrameElement, appSlug: string): void {
  const gameWindow = iframe.contentWindow;
  if (!gameWindow) return;

  // Guest mode: when the outer host's `init` carries `user: null`, storage
  // requests are short-circuited to localStorage on this (apps.oddsrabbit.com)
  // origin instead of being forwarded to the WP REST API. Lets games run
  // end-to-end for unauthenticated visitors so they can play first and convert
  // later, instead of gating signup before play. Aggregate, share, haptic, and
  // lifecycle keep flowing through the outer host — none of those need a
  // persistent user identity for the guest path to work.
  let currentUser: BridgeUser | null = null;

  // Game (child iframe) → host
  window.addEventListener('message', (event) => {
    if (event.source !== gameWindow) return;
    const parsed = BridgeRequestSchema.safeParse(event.data);
    if (!parsed.success) {
      log('msg from game: rejected by schema', event.data);
      return;
    }
    log('msg from game ok', parsed.data.type);

    if (currentUser === null && isStorageRequest(parsed.data)) {
      const response = handleGuestStorageRequest(parsed.data, appSlug);
      gameWindow.postMessage(response, '*');
      return;
    }

    forwardOutbound(parsed.data);
  });

  // Outer host → game: capture user state from `init`, then forward.
  const handleOuter = (source: string, data: unknown): void => {
    const parsed = parseFromOuter(data);
    if (!parsed) {
      log(`msg from ${source} rejected by schema`, data);
      return;
    }
    log(`msg from ${source} ok`, parsed.type);
    if (parsed.type === 'init') {
      currentUser = parsed.user;
      log('init received', currentUser ? `user:${currentUser.username}` : 'guest');
    }
    forwardInbound(gameWindow, parsed);
  };

  if (isMobile) {
    window.addEventListener(
      'oddsrabbit:bridge',
      (event) => handleOuter('RN', (event as MessageEvent).data),
      false
    );
  } else {
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return;
      handleOuter('parent', event.data);
    });
  }
}

function handleGuestStorageRequest(
  req: StorageRequest,
  appSlug: string
): BridgeOutbound {
  const correlationId = req.correlationId;
  const namespacedKey = `${GUEST_STORAGE_PREFIX}:${appSlug}:${req.payload.key}`;

  try {
    if (req.type === 'storage.get') {
      const value = window.localStorage.getItem(namespacedKey);
      return { type: 'response', correlationId, ok: true, result: value };
    }
    if (req.type === 'storage.set') {
      window.localStorage.setItem(namespacedKey, req.payload.value);
      return { type: 'response', correlationId, ok: true };
    }
    window.localStorage.removeItem(namespacedKey);
    return { type: 'response', correlationId, ok: true };
  } catch (error) {
    return {
      type: 'response',
      correlationId,
      ok: false,
      error: { code: 'storage/local-failed', message: formatError(error) },
    };
  }
}

function parseFromOuter(data: unknown): BridgeOutbound | null {
  const raw = typeof data === 'string' ? safeParseJson(data) : data;
  const parsed = BridgeOutboundSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function forwardOutbound(message: BridgeRequest): void {
  if (isMobile) {
    window.ReactNativeWebView!.postMessage(JSON.stringify(message));
  } else {
    window.parent.postMessage(message, '*');
  }
}

function forwardInbound(target: Window, message: BridgeOutbound): void {
  target.postMessage(message, '*');
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function showError(message: string): void {
  if (status) {
    status.textContent = message;
    status.dataset.state = 'error';
  }
  if (root) root.removeAttribute('aria-busy');
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
