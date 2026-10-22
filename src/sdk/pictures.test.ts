import assert from 'node:assert/strict';
import test from 'node:test';

import { BridgeRequestSchema, PICTURE_MAX_BYTES, type BridgeError, type BridgeInit } from '../schemas/messages';
import { AppScopeSchema } from '../schemas/manifest';
import { OddsRabbitSDK } from './sdk';
import type { BridgeTransport, InitHandler } from './transport';

const UUID = '11111111-1111-4111-8111-111111111111';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

/** Same shape as the fake in likes.test.ts: the test answers every request. */
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
    capabilities: ['content.submit', 'chat.sharePicture'],
    ...over,
  });
  return { sdk, calls };
}

function reject(code: string): Promise<never> {
  return Promise.reject({ code, message: code } satisfies BridgeError);
}

function request(type: string, payload?: unknown) {
  return BridgeRequestSchema.safeParse({ type, correlationId: 'c1', ...(payload === undefined ? {} : { payload }) });
}

const SUBMISSION = { kind: 'coloring-page', title: 'My cat', image: PNG, rights: true } as const;

test('content.submit sends the payload and parses the id', async () => {
  const { sdk, calls } = setup(async () => ({ id: 'sub-1' }));
  assert.deepEqual(await sdk.content.submit(SUBMISSION), { id: 'sub-1' });
  assert.deepEqual(calls[0], { type: 'content.submit', payload: SUBMISSION });
});

test('content.submit rejects on a malformed answer and passes errors through', async () => {
  await assert.rejects(setup(async () => ({})).sdk.content.submit(SUBMISSION));
  await assert.rejects(setup(() => reject('content/too-many')).sdk.content.submit(SUBMISSION), { code: 'content/too-many' });
});

test('content.submit errors do not retire the verb; an unknown verb does', async () => {
  const limited = setup(() => reject('content/too-many'));
  await assert.rejects(limited.sdk.content.submit(SUBMISSION));
  assert.equal(limited.sdk.capabilities.has('content.submit'), true);

  const old = setup(() => reject('bridge/unknown-type'));
  await assert.rejects(old.sdk.content.submit(SUBMISSION));
  assert.equal(old.sdk.capabilities.has('content.submit'), false);
});

test('chat.sharePicture parses sent, including a closed picker', async () => {
  const { sdk, calls } = setup(async () => ({ sent: false }));
  assert.deepEqual(await sdk.chat.sharePicture({ image: PNG, caption: 'look' }), { sent: false });
  assert.deepEqual(calls[0], { type: 'chat.sharePicture', payload: { image: PNG, caption: 'look' } });
  await assert.rejects(setup(async () => ({ sent: 'yes' })).sdk.chat.sharePicture({ image: PNG }));
  await assert.rejects(setup(() => reject('chat/unauthorized')).sdk.chat.sharePicture({ image: PNG }), { code: 'chat/unauthorized' });
});

test('the schema takes PNG and JPEG data URLs only, within the size cap', () => {
  assert.ok(request('chat.sharePicture', { image: PNG }).success);
  assert.ok(request('chat.sharePicture', { image: 'data:image/jpeg;base64,/9j/4AAQ' }).success);
  assert.ok(!request('chat.sharePicture', { image: 'data:image/gif;base64,R0lGOD' }).success);
  assert.ok(!request('chat.sharePicture', { image: 'https://example.com/a.png' }).success);
  assert.ok(!request('chat.sharePicture', { image: 'data:image/png;base64,<script>' }).success);
  assert.ok(!request('chat.sharePicture', { image: PNG, caption: 'x'.repeat(201) }).success);
  const big = 'data:image/png;base64,' + 'A'.repeat(Math.ceil(PICTURE_MAX_BYTES / 3) * 4 + 4);
  assert.ok(!request('chat.sharePicture', { image: big }).success);
});

test('content.submit needs a title, a kind and the rights box', () => {
  assert.ok(request('content.submit', SUBMISSION).success);
  assert.ok(!request('content.submit', { ...SUBMISSION, rights: false }).success);
  assert.ok(!request('content.submit', { ...SUBMISSION, title: '   ' }).success);
  assert.ok(!request('content.submit', { ...SUBMISSION, title: 'x'.repeat(41) }).success);
  assert.ok(!request('content.submit', { ...SUBMISSION, kind: 'Coloring Page' }).success);
  assert.ok(AppScopeSchema.safeParse('bridge:submit').success);
});
