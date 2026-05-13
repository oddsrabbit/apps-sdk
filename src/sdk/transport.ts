import {
  BridgeOutboundSchema,
  type BridgeError,
  type BridgeOutbound,
  type BridgeRequest,
} from '../schemas/messages';

const CORRELATION_ID_BYTES = 12;

export interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: BridgeError) => void;
}

export type LifecycleHandler = () => void;
export type InitHandler = (
  payload: Extract<BridgeOutbound, { type: 'init' }>
) => void;

function randomCorrelationId(): string {
  const bytes = new Uint8Array(CORRELATION_ID_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * RPC transport for the bridge SDK.
 *
 * The SDK runs inside the dev's game iframe; its parent is the sandbox host.
 * Outgoing messages always go to `window.parent.postMessage`. Incoming
 * messages are validated against the BridgeOutboundSchema before dispatch.
 */
export class BridgeTransport {
  private readonly parent: Window;
  private readonly pending = new Map<string, PendingCall>();
  private readonly lifecycleHandlers = new Map<string, Set<LifecycleHandler>>();
  private readonly initHandlers = new Set<InitHandler>();

  constructor(parent: Window = window.parent) {
    this.parent = parent;
    window.addEventListener('message', this.onMessage);
    window.addEventListener('oddsrabbit:bridge', this.onCustomEvent as EventListener);
  }

  request<T = unknown>(
    type: BridgeRequest['type'],
    payload?: unknown
  ): Promise<T> {
    const correlationId = randomCorrelationId();
    const message =
      payload === undefined
        ? { type, correlationId }
        : { type, correlationId, payload };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(correlationId, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.parent.postMessage(message, '*');
    });
  }

  onLifecycle(event: string, handler: LifecycleHandler): () => void {
    let handlers = this.lifecycleHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.lifecycleHandlers.set(event, handlers);
    }
    handlers.add(handler);
    return () => handlers!.delete(handler);
  }

  onInit(handler: InitHandler): () => void {
    this.initHandlers.add(handler);
    return () => this.initHandlers.delete(handler);
  }

  private readonly onMessage = (event: MessageEvent): void => {
    this.handleData(event.data);
  };

  private readonly onCustomEvent = (event: MessageEvent): void => {
    this.handleData(event.data);
  };

  private handleData(raw: unknown): void {
    const data = typeof raw === 'string' ? safeParseJson(raw) : raw;
    if (data === undefined) return;

    const parsed = BridgeOutboundSchema.safeParse(data);
    if (!parsed.success) return;

    const message = parsed.data;
    switch (message.type) {
      case 'response': {
        const call = this.pending.get(message.correlationId);
        if (!call) return;
        this.pending.delete(message.correlationId);
        if (message.ok) {
          call.resolve(message.result);
        } else {
          call.reject(
            message.error ?? { code: 'bridge/unknown', message: 'Bridge error' }
          );
        }
        return;
      }
      case 'lifecycle': {
        const handlers = this.lifecycleHandlers.get(message.event);
        if (!handlers) return;
        handlers.forEach((h) => {
          try {
            h();
          } catch {
            // Game-side handler errors must not crash the bridge.
          }
        });
        return;
      }
      case 'init': {
        this.initHandlers.forEach((h) => {
          try {
            h(message);
          } catch {
            // Game-side handler errors must not crash the bridge.
          }
        });
        return;
      }
    }
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
