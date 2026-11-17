import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BridgeRequestSchema,
  GALLERY_COMMENT_MAX_CHARS,
  GALLERY_DATA_MAX_CHARS,
  type BridgeError,
  type BridgeInit,
} from '../schemas/messages';
import { AppScopeSchema } from '../schemas/manifest';
import { OddsRabbitSDK } from './sdk';
import type { BridgeTransport, InitHandler } from './transport';

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

/** Same shape as the fake in pictures.test.ts: the test answers every request. */
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
    capabilities: ['gallery.post', 'gallery.comments', 'gallery.commentCounts', 'gallery.hidden'],
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

const POST = { roundKey: 'draw-3', image: PNG, data: 'abc', metadata: { day: 3 } };
const COMMENT = { id: '42', uuid: OTHER, username: 'sam', avatar: null, text: 'love it', createdAt: '2026-10-25T10:00:00Z', isSelf: false, canDelete: true };

test('gallery.post sends the payload and parses the entry', async () => {
  const result = { uuid: UUID, image: 'https://cdn.example.com/d.png', postedAt: '2026-10-25T10:00:00Z' };
  const { sdk, calls } = setup(async () => result);
  assert.deepEqual(await sdk.gallery.post(POST), result);
  assert.deepEqual(calls[0], { type: 'gallery.post', payload: POST });
  await assert.rejects(setup(async () => ({ uuid: UUID })).sdk.gallery.post(POST));
  await assert.rejects(setup(() => reject('gallery/already-posted')).sdk.gallery.post(POST), { code: 'gallery/already-posted' });
});

test('gallery errors do not retire the verb; an unknown verb does', async () => {
  const limited = setup(() => reject('gallery/rate-limited'));
  await assert.rejects(limited.sdk.gallery.post(POST));
  assert.equal(limited.sdk.capabilities.has('gallery.post'), true);

  const old = setup(() => reject('bridge/unknown-type'));
  await assert.rejects(old.sdk.gallery.post(POST));
  assert.equal(old.sdk.capabilities.has('gallery.post'), false);
});

test('gallery.comments parses rows one at a time and passes before', async () => {
  const { sdk, calls } = setup(async () => ({ comments: [COMMENT, { id: 'x' }], more: true }));
  const page = await sdk.gallery.comments('draw-3', OTHER, '99');
  assert.deepEqual(page, { comments: [COMMENT], more: true });
  assert.deepEqual(calls[0], { type: 'gallery.comments', payload: { roundKey: 'draw-3', uuid: OTHER, before: '99' } });
});

test('gallery.hidden degrades to nothing hidden; signed out it does not ask', async () => {
  assert.deepEqual(await setup(() => reject('bridge/error')).sdk.gallery.hidden('draw-3'), []);
  assert.deepEqual(await setup(async () => ({ uuids: [OTHER] })).sdk.gallery.hidden('draw-3'), [OTHER]);
  const guest = setup(async () => ({ uuids: [OTHER] }), { user: null });
  assert.deepEqual(await guest.sdk.gallery.hidden('draw-3'), []);
  assert.equal(guest.calls.length, 0);
});

test('gallery.commentCounts is empty on an old host and rejects other failures', async () => {
  assert.deepEqual(await setup(() => reject('bridge/unknown-type')).sdk.gallery.commentCounts('draw-3'), {});
  assert.deepEqual(await setup(async () => ({ counts: { [OTHER]: 3 } })).sdk.gallery.commentCounts('draw-3'), { [OTHER]: 3 });
  await assert.rejects(setup(() => reject('bridge/error')).sdk.gallery.commentCounts('draw-3'));
});

test('the small gallery verbs unwrap their answers', async () => {
  const answers: Record<string, unknown> = {
    'gallery.data': { data: null },
    'gallery.remove': { removed: true },
    'gallery.report': { reported: true },
    'gallery.deleteComment': { deleted: true },
    'gallery.reportComment': { reported: true },
    'gallery.comment': COMMENT,
  };
  const { sdk, calls } = setup(async (type) => answers[type]);
  assert.equal(await sdk.gallery.data('draw-3', OTHER), null);
  assert.equal(await sdk.gallery.remove('draw-3'), true);
  assert.equal(await sdk.gallery.report('draw-3', OTHER, 'spam'), true);
  assert.equal(await sdk.gallery.deleteComment('42'), true);
  assert.equal(await sdk.gallery.reportComment('42', 'other'), true);
  assert.deepEqual(await sdk.gallery.comment({ roundKey: 'draw-3', uuid: OTHER, text: 'love it' }), COMMENT);
  assert.deepEqual(calls.map((c) => c.type), Object.keys(answers));
});

test('notifications kind mutes: null when unknown, rejects a failed write', async () => {
  const { sdk, calls } = setup(async () => ({ kinds: ['friends'] }));
  assert.deepEqual(await sdk.notifications.mutedKinds(), ['friends']);
  assert.deepEqual(await sdk.notifications.setKindMuted('friends', true), ['friends']);
  assert.deepEqual(calls[1], { type: 'notifications.setKindMuted', payload: { kind: 'friends', muted: true } });
  assert.equal(await setup(() => reject('bridge/unknown-type')).sdk.notifications.mutedKinds(), null);
  await assert.rejects(setup(() => reject('notifications/rate-limited')).sdk.notifications.setKindMuted('friends', false));
  assert.ok(!request('notifications.setKindMuted', { kind: 'Friends!', muted: true }).success);
});

test('the gallery schema bounds data, metadata, comments and ids', () => {
  assert.ok(request('gallery.post', POST).success);
  assert.ok(request('gallery.post', { roundKey: 'draw-3', image: PNG }).success);
  assert.ok(!request('gallery.post', { ...POST, image: 'https://example.com/a.png' }).success);
  assert.ok(!request('gallery.post', { ...POST, data: 'x'.repeat(GALLERY_DATA_MAX_CHARS + 1) }).success);
  assert.ok(!request('gallery.post', { ...POST, metadata: { pad: 'x'.repeat(1100) } }).success);
  assert.ok(request('gallery.comment', { roundKey: 'draw-3', uuid: OTHER, text: 'hi' }).success);
  assert.ok(!request('gallery.comment', { roundKey: 'draw-3', uuid: OTHER, text: '   ' }).success);
  assert.ok(!request('gallery.comment', { roundKey: 'draw-3', uuid: OTHER, text: 'x'.repeat(GALLERY_COMMENT_MAX_CHARS + 1) }).success);
  assert.ok(!request('gallery.deleteComment', { id: 'abc' }).success);
  assert.ok(!request('gallery.report', { roundKey: 'draw-3', uuid: OTHER, reason: 'ugly' }).success);
  assert.ok(AppScopeSchema.safeParse('bridge:gallery').success);
});
