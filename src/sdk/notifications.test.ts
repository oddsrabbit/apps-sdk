import assert from 'node:assert/strict';
import test from 'node:test';

import type { BridgeError, BridgeInit } from '../schemas/messages';
import { NOTIFICATION_ERROR_CODES, OddsRabbitSDK } from './sdk';
import type { BridgeTransport, InitHandler, LifecycleHandler } from './transport';

const UUID = '11111111-1111-4111-8111-111111111111';
const HOUR = 60 * 60 * 1000;

/** Same shape as the fake in matches.test.ts: the test answers every request. */
function fakeTransport(answer: (type: string, payload: unknown) => Promise<unknown>) {
  const calls: Array<{ type: string; payload: unknown }> = [];
  let initHandler: InitHandler | null = null;
  const lifecycle = new Map<string, Set<LifecycleHandler>>();
  const transport = {
    request: (type: string, payload?: unknown) => {
      calls.push({ type, payload });
      return answer(type, payload);
    },
    onInit: (handler: InitHandler) => {
      initHandler = handler;
      return () => undefined;
    },
    onLifecycle: (event: string, handler: LifecycleHandler) => {
      let set = lifecycle.get(event);
      if (!set) lifecycle.set(event, (set = new Set()));
      set.add(handler);
      return () => set!.delete(handler);
    },
  };
  return {
    transport: transport as unknown as BridgeTransport,
    calls,
    init: (over: Partial<BridgeInit> = {}) =>
      initHandler!({
        type: 'init',
        user: { uuid: UUID, username: 'me', avatar: null, createdAt: null },
        sessionToken: 'jwt',
        expiresAt: null,
        capabilities: [
          'time.now',
          'notifications.schedule',
          'notifications.cancel',
          'notifications.list',
        ],
        ...over,
      }),
    fire: (event: string) => {
      for (const handler of lifecycle.get(event) ?? []) handler();
    },
  };
}

function reject(code: string): Promise<never> {
  return Promise.reject({ code, message: code } satisfies BridgeError);
}

/** A server whose clock runs an hour ahead of this process. */
const aheadByAnHour = () =>
  Promise.resolve({ serverTime: new Date(Date.now() + HOUR).toISOString() });

function near(actual: number, expected: number, slackMs = 2000): void {
  assert.ok(Math.abs(actual - expected) < slackMs, `${actual} not within ${slackMs}ms of ${expected}`);
}

// ─── time.now ────────────────────────────────────────────────────────────

test('time.now answers in server time and caches the offset', async () => {
  const t = fakeTransport(aheadByAnHour);
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  near(await sdk.time.now(), Date.now() + HOUR);
  near(await sdk.time.now(), Date.now() + HOUR);
  assert.equal(t.calls.length, 1, 'second call answered from the offset');
  assert.deepEqual(t.calls[0], { type: 'time.now', payload: undefined });
});

test('time.now shares one round trip between callers at boot', async () => {
  const t = fakeTransport(aheadByAnHour);
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  const [a, b] = await Promise.all([sdk.time.now(), sdk.time.now()]);
  near(a, b);
  assert.equal(t.calls.length, 1);
});

test('time.now asks again after the host resumes the page', async () => {
  const t = fakeTransport(aheadByAnHour);
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  await sdk.time.now();
  t.fire('resume');
  await sdk.time.now();
  assert.equal(t.calls.length, 2);
});

test('time.now works signed out', async () => {
  const t = fakeTransport(aheadByAnHour);
  const sdk = new OddsRabbitSDK(t.transport);
  t.init({ user: null, sessionToken: null });
  near(await sdk.time.now(), Date.now() + HOUR);
});

test('time.now falls back to the device clock without asking a host that lacks it', async () => {
  const t = fakeTransport(aheadByAnHour);
  const sdk = new OddsRabbitSDK(t.transport);
  t.init({ capabilities: undefined });
  near(await sdk.time.now(), Date.now());
  assert.equal(t.calls.length, 0, 'not in the pre-handshake baseline');
});

test('time.now never rejects, and backs off after a failure', async () => {
  const t = fakeTransport(() => Promise.reject(new Error('offline')));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  near(await sdk.time.now(), Date.now());
  near(await sdk.time.now(), Date.now());
  assert.equal(t.calls.length, 1, 'no retry inside the back-off window');
});

test('time.now treats a malformed answer as a failure', async () => {
  const t = fakeTransport(() => Promise.resolve({ serverTime: 'yesterday' }));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  near(await sdk.time.now(), Date.now());
});

test('time.now retires the verb on a host that rejects it as unknown', async () => {
  const t = fakeTransport(() => reject('bridge/unknown-action'));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  near(await sdk.time.now(), Date.now());
  assert.equal(sdk.capabilities.has('time.now'), false);
});

// ─── notifications ───────────────────────────────────────────────────────

const scheduled = {
  key: 'nap-done',
  fireAt: '2026-09-24T18:32:00.000Z',
  deliverAt: '2026-09-24T18:32:00.000Z',
  serverTime: '2026-09-24T16:32:00.000Z',
};

test('schedule sends an ISO fireAt and the device time zone', async () => {
  const t = fakeTransport(() => Promise.resolve(scheduled));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  const result = await sdk.notifications.schedule({
    key: 'nap-done',
    fireAt: Date.parse('2026-09-24T18:32:00Z'),
    title: 'Rabbit Pets',
    body: 'Clover is awake and wants to play.',
  });
  assert.deepEqual(result, scheduled);
  const payload = t.calls[0]!.payload as Record<string, unknown>;
  assert.equal(t.calls[0]!.type, 'notifications.schedule');
  assert.equal(payload.fireAt, '2026-09-24T18:32:00.000Z');
  assert.equal(typeof payload.tz, 'string');
});

test('schedule rejects a bad date without a round trip', async () => {
  const t = fakeTransport(() => Promise.resolve(scheduled));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  await assert.rejects(
    sdk.notifications.schedule({ key: 'nap-done', fireAt: 'soon', title: 't', body: 'b' }),
    TypeError
  );
  assert.equal(t.calls.length, 0);
});

test('a refused reminder is a per-call outcome and does not retire the verb', async () => {
  const t = fakeTransport(() => reject(NOTIFICATION_ERROR_CODES.tooMany));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  await assert.rejects(
    sdk.notifications.schedule({ key: 'nap-done', fireAt: new Date(Date.now() + HOUR), title: 't', body: 'b' }),
    (error: BridgeError) => error.code === 'notifications/too-many'
  );
  assert.equal(sdk.capabilities.has('notifications.schedule'), true);
});

test('schedule rejects a malformed result', async () => {
  const t = fakeTransport(() => Promise.resolve({ key: 'nap-done' }));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  await assert.rejects(
    sdk.notifications.schedule({ key: 'nap-done', fireAt: new Date(Date.now() + HOUR), title: 't', body: 'b' }),
    /malformed result/
  );
});

test('cancel resolves whether anything was pending', async () => {
  const t = fakeTransport((_type, payload) =>
    Promise.resolve({ key: (payload as { key: string }).key, cancelled: false })
  );
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  assert.equal(await sdk.notifications.cancel('treat-ready'), false);
  assert.deepEqual(t.calls[0], { type: 'notifications.cancel', payload: { key: 'treat-ready' } });
});

test('list resolves [] without a round trip when signed out', async () => {
  const t = fakeTransport(() => Promise.resolve({ pending: [], serverTime: scheduled.serverTime }));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init({ user: null, sessionToken: null });
  assert.deepEqual(await sdk.notifications.list(), []);
  assert.equal(t.calls.length, 0);
});

test('list parses per row: one broken reminder drops itself', async () => {
  const good = { key: 'nap-done', fireAt: scheduled.fireAt, deliverAt: scheduled.deliverAt };
  const t = fakeTransport(() =>
    Promise.resolve({
      pending: [good, { key: 'Bad Key', fireAt: 'x', deliverAt: 'y' }],
      serverTime: scheduled.serverTime,
    })
  );
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  assert.deepEqual(await sdk.notifications.list(), [good]);
});

test('list degrades to [] on a host without the verb', async () => {
  const t = fakeTransport(() => reject('bridge/unknown-type'));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  assert.deepEqual(await sdk.notifications.list(), []);
  assert.equal(sdk.capabilities.has('notifications.list'), false);
});
