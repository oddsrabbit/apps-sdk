import assert from 'node:assert/strict';
import test from 'node:test';

import type { BridgeError, BridgeInit } from '../schemas/messages';
import { GIFT_ERROR_CODES, OddsRabbitSDK, SOCIAL_ERROR_CODES, VISIT_ERROR_CODES } from './sdk';
import type { BridgeTransport, InitHandler } from './transport';

const UUID = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const GIFT = '33333333-3333-4333-8333-333333333333';
const VISIT = '44444444-4444-4444-8444-444444444444';
const WHEN = '2026-09-24T16:32:00Z';

/** Same shape as the fake in notifications.test.ts: the test answers every request. */
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
        capabilities: [
          'showcase.publish',
          'showcase.friends',
          'showcase.get',
          'gifts.send',
          'gifts.inbox',
          'gifts.claim',
          'gifts.sentToday',
          'visits.record',
          'visits.inbox',
          'visits.seen',
          'visits.sentToday',
        ],
        ...over,
      }),
  };
}

function reject(code: string): Promise<never> {
  return Promise.reject({ code, message: code } satisfies BridgeError);
}

function setup(answer: (type: string, payload: unknown) => Promise<unknown>, over: Partial<BridgeInit> = {}) {
  const t = fakeTransport(answer);
  const sdk = new OddsRabbitSDK(t.transport);
  t.init(over);
  return { t, sdk };
}

const showcaseRow = { uuid: FRIEND, username: 'mika', avatar: null, data: { name: 'Pip' }, updatedAt: WHEN };
const giftRow = {
  giftUuid: GIFT,
  from: { uuid: FRIEND, username: 'mika', avatar: null },
  kind: 'clover',
  message: 'For Clover',
  sentAt: WHEN,
  counts: true,
};
const visitRow = {
  visitUuid: VISIT,
  kind: 'snack',
  visitedAt: WHEN,
  seenAt: null,
  from: { uuid: FRIEND, username: 'mika', avatar: null },
  showcase: { name: 'Pip' },
  counts: false,
};

// ─── showcase ────────────────────────────────────────────────────────────

test('publish sends the snapshot and resolves updatedAt', async () => {
  const { t, sdk } = setup(() => Promise.resolve({ updatedAt: WHEN }));
  assert.deepEqual(await sdk.showcase.publish({ name: 'Clover' }), { updatedAt: WHEN });
  assert.deepEqual(t.calls[0], { type: 'showcase.publish', payload: { data: { name: 'Clover' } } });
});

test('publish rejects with a social code that does not retire the verb', async () => {
  const { sdk } = setup(() => reject(SOCIAL_ERROR_CODES.tooLarge));
  await assert.rejects(sdk.showcase.publish({ big: 'x' }), (e: BridgeError) => e.code === 'social/too-large');
  assert.equal(sdk.capabilities.has('showcase.publish'), true);
});

test('publish rejects on a host without the verb', async () => {
  const { sdk } = setup(() => reject('bridge/unknown-action'));
  await assert.rejects(sdk.showcase.publish({}));
  assert.equal(sdk.capabilities.has('showcase.publish'), false);
});

test('friends parses rows one at a time and passes the limit', async () => {
  const { t, sdk } = setup(() => Promise.resolve([showcaseRow, { uuid: 'nope' }]));
  assert.deepEqual(await sdk.showcase.friends({ limit: 10 }), [showcaseRow]);
  assert.deepEqual(t.calls[0], { type: 'showcase.friends', payload: { limit: 10 } });
});

test('friends is [] signed out, without a round trip', async () => {
  const { t, sdk } = setup(() => Promise.resolve([showcaseRow]), { user: null, sessionToken: null });
  assert.deepEqual(await sdk.showcase.friends(), []);
  assert.equal(t.calls.length, 0);
});

test('friends degrades to [] on a host without the verb', async () => {
  const { sdk } = setup(() => reject('bridge/unknown-action'));
  assert.deepEqual(await sdk.showcase.friends(), []);
});

test('get resolves a row, null when unpublished, and null when unsupported', async () => {
  let answer: () => Promise<unknown> = () => Promise.resolve(showcaseRow);
  const { t, sdk } = setup(() => answer());
  assert.deepEqual(await sdk.showcase.get(FRIEND), showcaseRow);
  assert.deepEqual(t.calls[0], { type: 'showcase.get', payload: { userUuid: FRIEND } });
  answer = () => Promise.resolve(null);
  assert.equal(await sdk.showcase.get(FRIEND), null);
  answer = () => reject('bridge/unknown-action');
  assert.equal(await sdk.showcase.get(FRIEND), null);
});

test('get rejects for someone the viewer is not connected to', async () => {
  const { sdk } = setup(() => reject(SOCIAL_ERROR_CODES.notConnected));
  await assert.rejects(sdk.showcase.get(FRIEND), (e: BridgeError) => e.code === 'social/not-connected');
  assert.equal(sdk.capabilities.has('showcase.get'), true);
});

// ─── gifts ───────────────────────────────────────────────────────────────

test('send passes the gift and omits an absent message', async () => {
  const { t, sdk } = setup(() => Promise.resolve({ giftUuid: GIFT, sentAt: WHEN }));
  assert.deepEqual(await sdk.gifts.send({ toUserUuid: FRIEND, kind: 'clover' }), { giftUuid: GIFT, sentAt: WHEN });
  assert.deepEqual(t.calls[0]!.payload, { toUserUuid: FRIEND, kind: 'clover' });
  await sdk.gifts.send({ toUserUuid: FRIEND, kind: 'clover', message: 'hi' });
  assert.deepEqual(t.calls[1]!.payload, { toUserUuid: FRIEND, kind: 'clover', message: 'hi' });
});

test('a refused gift is a per-call outcome', async () => {
  for (const code of Object.values(GIFT_ERROR_CODES)) {
    const { sdk } = setup(() => reject(code));
    await assert.rejects(sdk.gifts.send({ toUserUuid: FRIEND, kind: 'clover' }), (e: BridgeError) => e.code === code);
    assert.equal(sdk.capabilities.has('gifts.send'), true, code);
  }
});

test('send rejects a malformed result', async () => {
  const { sdk } = setup(() => Promise.resolve({ giftUuid: 'x' }));
  await assert.rejects(sdk.gifts.send({ toUserUuid: FRIEND, kind: 'clover' }), /malformed result/);
});

test('inbox parses rows one at a time and is [] signed out or unsupported', async () => {
  const { sdk } = setup(() => Promise.resolve([giftRow, { giftUuid: GIFT }]));
  assert.deepEqual(await sdk.gifts.inbox(), [giftRow]);

  const out = setup(() => Promise.resolve([giftRow]), { user: null, sessionToken: null });
  assert.deepEqual(await out.sdk.gifts.inbox(), []);
  assert.equal(out.t.calls.length, 0);

  const old = setup(() => reject('bridge/unknown-action'));
  assert.deepEqual(await old.sdk.gifts.inbox(), []);
});

test('claim resolves the kind to pay out, and rejects the second time', async () => {
  let claimed = false;
  const { sdk } = setup(() => {
    if (claimed) return reject(GIFT_ERROR_CODES.claimed);
    claimed = true;
    return Promise.resolve({ giftUuid: GIFT, kind: 'clover', claimedAt: WHEN });
  });
  assert.deepEqual(await sdk.gifts.claim(GIFT), { giftUuid: GIFT, kind: 'clover', claimedAt: WHEN });
  await assert.rejects(sdk.gifts.claim(GIFT), (e: BridgeError) => e.code === 'gifts/claimed');
});

test('sentToday keeps strings, and is [] signed out or unsupported', async () => {
  const { sdk } = setup(() => Promise.resolve([FRIEND, 7]));
  assert.deepEqual(await sdk.gifts.sentToday(), [FRIEND]);

  const out = setup(() => Promise.resolve([FRIEND]), { user: null, sessionToken: null });
  assert.deepEqual(await out.sdk.gifts.sentToday(), []);
  assert.equal(out.t.calls.length, 0);

  const old = setup(() => reject('bridge/unknown-action'));
  assert.deepEqual(await old.sdk.gifts.sentToday(), []);
});

test('gift rows from an older host count by default', async () => {
  const { counts: _counts, ...old } = giftRow;
  const { sdk } = setup(() => Promise.resolve([old]));
  assert.deepEqual(await sdk.gifts.inbox(), [{ ...old, counts: true }]);
});

// ─── visits ──────────────────────────────────────────────────────────────

test('record passes only the friend and kind, and resolves the visit', async () => {
  const { t, sdk } = setup(() => Promise.resolve({ visitUuid: VISIT, visitedAt: WHEN }));
  const extra = { toUserUuid: FRIEND, kind: 'snack', message: 'runtime text' } as { toUserUuid: string; kind: string };
  assert.deepEqual(await sdk.visits.record(extra), { visitUuid: VISIT, visitedAt: WHEN });
  assert.deepEqual(t.calls[0], { type: 'visits.record', payload: { toUserUuid: FRIEND, kind: 'snack' } });
});

test('a refused visit is a per-call outcome', async () => {
  for (const code of Object.values(VISIT_ERROR_CODES)) {
    const { sdk } = setup(() => reject(code));
    await assert.rejects(sdk.visits.record({ toUserUuid: FRIEND, kind: 'pat' }), (e: BridgeError) => e.code === code);
    assert.equal(sdk.capabilities.has('visits.record'), true, code);
  }
});

test('record rejects a malformed result, and on a host without the verb', async () => {
  const bad = setup(() => Promise.resolve({ visitUuid: 'x' }));
  await assert.rejects(bad.sdk.visits.record({ toUserUuid: FRIEND, kind: 'pat' }), /malformed result/);

  const old = setup(() => reject('bridge/unknown-action'));
  await assert.rejects(old.sdk.visits.record({ toUserUuid: FRIEND, kind: 'pat' }));
  assert.equal(old.sdk.capabilities.has('visits.record'), false);
});

test('inbox parses rows one at a time and is [] signed out or unsupported', async () => {
  const { t, sdk } = setup(() => Promise.resolve([visitRow, { visitUuid: VISIT }]));
  assert.deepEqual(await sdk.visits.inbox(), [visitRow]);
  assert.deepEqual(t.calls[0], { type: 'visits.inbox', payload: undefined });

  const out = setup(() => Promise.resolve([visitRow]), { user: null, sessionToken: null });
  assert.deepEqual(await out.sdk.visits.inbox(), []);
  assert.equal(out.t.calls.length, 0);

  const old = setup(() => reject('bridge/unknown-action'));
  assert.deepEqual(await old.sdk.visits.inbox(), []);
});

test('seen sends the uuids and resolves only what this call changed', async () => {
  let first = true;
  const { t, sdk } = setup(() => {
    const seen = first ? [VISIT] : [];
    first = false;
    return Promise.resolve({ seen, seenAt: WHEN });
  });
  assert.deepEqual(await sdk.visits.seen([VISIT]), { seen: [VISIT], seenAt: WHEN });
  assert.deepEqual(t.calls[0], { type: 'visits.seen', payload: { visitUuids: [VISIT] } });
  assert.deepEqual(await sdk.visits.seen([VISIT]), { seen: [], seenAt: WHEN });
});

test('seen([]) resolves nothing seen without asking the host', async () => {
  const { t, sdk } = setup(() => Promise.reject(new Error('should not be called')));
  const result = await sdk.visits.seen([]);
  assert.deepEqual(result.seen, []);
  assert.ok(!Number.isNaN(Date.parse(result.seenAt)));
  assert.equal(t.calls.length, 0);
});

test('seen rejects with a visits code and on a malformed result', async () => {
  const refused = setup(() => reject(VISIT_ERROR_CODES.invalid));
  await assert.rejects(refused.sdk.visits.seen([VISIT]), (e: BridgeError) => e.code === 'visits/invalid');
  assert.equal(refused.sdk.capabilities.has('visits.seen'), true);

  const bad = setup(() => Promise.resolve({ seen: 'all' }));
  await assert.rejects(bad.sdk.visits.seen([VISIT]), /malformed result/);
});

test('visits.sentToday keeps strings, and is [] signed out or unsupported', async () => {
  const { sdk } = setup(() => Promise.resolve([FRIEND, null]));
  assert.deepEqual(await sdk.visits.sentToday(), [FRIEND]);

  const out = setup(() => Promise.resolve([FRIEND]), { user: null, sessionToken: null });
  assert.deepEqual(await out.sdk.visits.sentToday(), []);
  assert.equal(out.t.calls.length, 0);

  const old = setup(() => reject('bridge/unknown-action'));
  assert.deepEqual(await old.sdk.visits.sentToday(), []);
});

test('user.supporter comes from init', async () => {
  const { sdk } = setup(() => Promise.resolve(null), {
    user: { uuid: UUID, username: 'me', avatar: null, createdAt: null, supporter: true },
  });
  assert.equal(sdk.user?.supporter, true);
});
