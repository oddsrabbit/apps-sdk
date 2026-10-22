import assert from 'node:assert/strict';
import test from 'node:test';

import type { BridgeError, BridgeInit } from '../schemas/messages';
import { OddsRabbitSDK } from './sdk';
import type { BridgeTransport, InitHandler } from './transport';

const UUID = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';

/** Same shape as the fake in social.test.ts: the test answers every request. */
function setup(answer: (type: string, payload: unknown) => Promise<unknown>, over: Partial<BridgeInit> = {}) {
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
  const sdk = new OddsRabbitSDK(transport as unknown as BridgeTransport);
  initHandler!({
    type: 'init',
    user: { uuid: UUID, username: 'me', avatar: null, createdAt: null, supporter: false },
    sessionToken: 'jwt',
    expiresAt: null,
    capabilities: ['scores.top', 'scores.like', 'scores.myLikes'],
    ...over,
  });
  return { sdk, calls };
}

function reject(code: string): Promise<never> {
  return Promise.reject({ code, message: code } satisfies BridgeError);
}

test('like sends the payload and parses the new count', async () => {
  const { sdk, calls } = setup(async () => ({ liked: true, likes: 3 }));
  const res = await sdk.scores.like({ roundKey: 'day-4', uuid: FRIEND, liked: true });
  assert.deepEqual(res, { liked: true, likes: 3 });
  assert.deepEqual(calls[0], { type: 'scores.like', payload: { roundKey: 'day-4', uuid: FRIEND, liked: true } });
});

test('like rejects on a malformed answer and passes errors through', async () => {
  await assert.rejects(setup(async () => ({ liked: 'yes' })).sdk.scores.like({ roundKey: 'day-4', uuid: FRIEND, liked: true }));
  await assert.rejects(
    setup(() => reject('scores/own-entry')).sdk.scores.like({ roundKey: 'day-4', uuid: UUID, liked: true }),
    { code: 'scores/own-entry' }
  );
});

test('like rejects on a host without the verb and narrows capabilities', async () => {
  const { sdk } = setup(() => reject('bridge/unknown-type'), { capabilities: undefined });
  assert.equal(sdk.capabilities.has('scores.like'), false);
  await assert.rejects(sdk.scores.like({ roundKey: 'day-4', uuid: FRIEND, liked: true }), {
    code: 'bridge/unknown-type',
  });

  const declared = setup(() => reject('bridge/unknown-type'));
  assert.equal(declared.sdk.capabilities.has('scores.like'), true);
  await assert.rejects(declared.sdk.scores.like({ roundKey: 'day-4', uuid: FRIEND, liked: true }));
  assert.equal(declared.sdk.capabilities.has('scores.like'), false);
});

test('myLikes keeps strings, and is empty signed out or on an older host', async () => {
  assert.deepEqual(await setup(async () => [FRIEND, 7]).sdk.scores.myLikes({ roundKey: 'day-4' }), [FRIEND]);

  const guest = setup(async () => [FRIEND], { user: null, sessionToken: null });
  assert.deepEqual(await guest.sdk.scores.myLikes({ roundKey: 'day-4' }), []);
  assert.equal(guest.calls.length, 0);

  assert.deepEqual(await setup(() => reject('bridge/unknown-type')).sdk.scores.myLikes({ roundKey: 'day-4' }), []);
});

test('board rows default likes to 0 from hosts that predate it', async () => {
  const row = { uuid: FRIEND, username: 'mika', score: 5, metadata: null, createdAt: '2026-10-21T00:00:00Z' };
  const { sdk } = setup(async () => [row, { ...row, likes: 4 }]);
  const rows = await sdk.scores.top({ roundKey: 'day-4', order: 'likes' });
  assert.deepEqual(rows.map((r) => r.likes), [0, 4]);
});

test('myLikes rejects on a failure that is not an unsupported host', async () => {
  await assert.rejects(setup(() => reject('scores/likes-failed')).sdk.scores.myLikes({ roundKey: 'day-4' }), {
    code: 'scores/likes-failed',
  });
});
