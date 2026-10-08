import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRIDGE_REQUEST_TYPES,
  BridgeRequestSchema,
  CONTENT_REVEAL_MAX_INDEX,
  type BridgeError,
  type BridgeInit,
} from '../schemas/messages';
import { CONTENT_ERROR_CODES, OddsRabbitSDK } from './sdk';
import type { BridgeTransport, InitHandler } from './transport';

const UUID = '11111111-1111-4111-8111-111111111111';

/** Same shape as the fake in notifications.test.ts, trimmed to what reveal needs. */
function fakeTransport(answer: (type: string, payload: unknown) => Promise<unknown>) {
  const calls: Array<{ type: string; payload: unknown }> = [];
  let initHandler: InitHandler | null = null;
  const transport = {
    request: (type: string, payload?: unknown) => {
      calls.push({ type, payload });
      return answer(type, payload);
    },
    onInit: (handler: InitHandler) => {
      initHandler = handler;
      return () => undefined;
    },
    onLifecycle: () => () => undefined,
  };
  return {
    transport: transport as unknown as BridgeTransport,
    calls,
    init: (over: Partial<BridgeInit> = {}) =>
      initHandler!({
        type: 'init',
        user: { uuid: UUID, username: 'me', avatar: null, createdAt: null, supporter: false },
        sessionToken: 'jwt',
        expiresAt: null,
        capabilities: ['content.daily', 'content.reveal'],
        ...over,
      }),
  };
}

function reject(code: string): Promise<never> {
  return Promise.reject({ code, message: code } satisfies BridgeError);
}

function request(payload: unknown) {
  return BridgeRequestSchema.safeParse({ type: 'content.reveal', correlationId: 'c1', payload });
}

const PAYLOAD = { roundKey: 'puzzle-5', index: 1, guess: { lat: 35.6, lng: 139.8 } };

// ─── schema ──────────────────────────────────────────────────────────────

test('content.reveal is a bridge request type', () => {
  assert.ok(BRIDGE_REQUEST_TYPES.includes('content.reveal'));
  assert.ok(request(PAYLOAD).success);
});

test('reveal takes a bounded integer index and an object guess', () => {
  assert.ok(request({ ...PAYLOAD, index: 0 }).success);
  assert.ok(request({ ...PAYLOAD, index: CONTENT_REVEAL_MAX_INDEX }).success);
  assert.ok(!request({ ...PAYLOAD, index: CONTENT_REVEAL_MAX_INDEX + 1 }).success);
  assert.ok(!request({ ...PAYLOAD, index: -1 }).success);
  assert.ok(!request({ ...PAYLOAD, index: 1.5 }).success);
  assert.ok(!request({ ...PAYLOAD, guess: [35.6, 139.8] }).success);
  assert.ok(!request({ ...PAYLOAD, roundKey: '' }).success);
});

// ─── sdk ─────────────────────────────────────────────────────────────────

test('reveal sends the guess and resolves with the server-held guess and the answer', async () => {
  const held = {
    roundKey: 'puzzle-5',
    index: 1,
    // Already locked in from another device: not what this call sent.
    guess: { lat: 10, lng: 20 },
    reveal: { lat: 35.68, lng: 139.69, place: 'Tokyo, Japan' },
  };
  const t = fakeTransport(() => Promise.resolve(held));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  assert.deepEqual(await sdk.content.reveal(PAYLOAD), held);
  assert.deepEqual(t.calls[0], { type: 'content.reveal', payload: PAYLOAD });
});

test('reveal works for a guest: the server decides what to record', async () => {
  const t = fakeTransport((_type, payload) =>
    Promise.resolve({ ...(payload as object), reveal: { lat: 1, lng: 2, place: 'x' } })
  );
  const sdk = new OddsRabbitSDK(t.transport);
  t.init({ user: null, sessionToken: null });
  const result = await sdk.content.reveal(PAYLOAD);
  assert.deepEqual(result.guess, PAYLOAD.guess);
  assert.equal(t.calls.length, 1);
});

test('reveal rejects with the host code rather than resolving something unscorable', async () => {
  const t = fakeTransport(() => reject(CONTENT_ERROR_CODES.notAvailable));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  await assert.rejects(sdk.content.reveal(PAYLOAD), { code: CONTENT_ERROR_CODES.notAvailable });
  // A content/* code describes the call, not the host: the verb stays available.
  assert.equal(sdk.capabilities.has('content.reveal'), true);
});

test('reveal rejects on a malformed result', async () => {
  const t = fakeTransport(() => Promise.resolve({ roundKey: 'puzzle-5', index: 1, guess: {} }));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  await assert.rejects(sdk.content.reveal(PAYLOAD), /malformed result/);
});

test('a host without the verb retires it', async () => {
  const t = fakeTransport(() => reject('bridge/unknown-type'));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  await assert.rejects(sdk.content.reveal(PAYLOAD));
  assert.equal(sdk.capabilities.has('content.reveal'), false);
});
