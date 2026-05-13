import {
  type BridgeUser,
  type AppColorScheme,
  type AppHapticType,
  type AppLifecycleEvent,
} from '../schemas/messages';
import { BridgeTransport, type LifecycleHandler } from './transport';

export interface OddsRabbitGlobal {
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

  readonly storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };

  readonly aggregate: {
    count(key: string, value: string): Promise<number | null>;
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

  ready(): void;

  whenReady(): Promise<void>;
}

class OddsRabbitSDK implements OddsRabbitGlobal {
  user: BridgeUser | null = null;
  sessionToken: string | null = null;
  expiresAt: string | null = null;
  colorScheme: AppColorScheme | null = null;

  private readonly transport: BridgeTransport;
  private readonly initPromise: Promise<void>;
  private resolveInit: (() => void) | null = null;

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
      this.resolveInit?.();
    });
  }

  readonly storage = {
    get: (key: string): Promise<string | null> =>
      this.transport
        .request<string | null>('storage.get', { key })
        .then((value) => (value as string | null) ?? null),
    set: (key: string, value: string): Promise<void> =>
      this.transport.request<void>('storage.set', { key, value }),
    delete: (key: string): Promise<void> =>
      this.transport.request<void>('storage.delete', { key }),
  };

  readonly aggregate = {
    count: (key: string, value: string): Promise<number | null> =>
      this.transport
        .request<number | null>('aggregate.count', { key, value })
        .then((count) => (count as number | null) ?? null),
  };

  readonly actions = {
    share: (payload?: { title?: string; text?: string }): Promise<void> =>
      this.transport.request<void>('actions.share', payload ?? {}),
    haptic: (type: AppHapticType): Promise<void> =>
      this.transport.request<void>('actions.haptic', { type }),
    requestSignIn: (reason?: string): Promise<void> => {
      if (this.user) return Promise.resolve();
      return this.transport.request<void>(
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
    this.transport.request('ready').catch(() => {
      // Best-effort signal; ignore failures.
    });
  }

  whenReady(): Promise<void> {
    return this.initPromise;
  }
}

export { OddsRabbitSDK };
