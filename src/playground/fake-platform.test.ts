import assert from 'node:assert/strict';
import test from 'node:test';

import { BRIDGE_REQUEST_TYPES, BridgeRequestSchema, type BridgeError } from '../schemas/messages';
import { OddsRabbitSDK } from '../sdk/sdk';
import type { BridgeTransport, InitHandler } from '../sdk/transport';
import {
  DEFAULT_PLAYER,
  FRIENDS,
  FakePlatform,
  PLAYGROUND_SCOPES,
  emptyState,
  visitLine,
  type PlaygroundSettings,
} from './fake-platform';

// The real SDK talks to the fake through a transport that validates each
// request the way the sandbox host does. Every result therefore has to get
// through the SDK's own parsing, which is the point: a board whose rows fail
// the schema comes back shorter than the fake made it, and these tests count.

const NOW = Date.parse('2026-10-22T15:00:00.000Z');
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const MIKA = FRIENDS[0]!;
const STRANGER = '7b1c5e0a-1f0e-4c4b-9a51-999999999999';

function settings(over: Partial<PlaygroundSettings> = {}): PlaygroundSettings {
  return {
    user: DEFAULT_PLAYER,
    scopes: [...PLAYGROUND_SCOPES],
    fillBoards: true,
    pushReachable: true,
    dailyContent: {},
    ...over,
  };
}

function setup(over: Partial<PlaygroundSettings> = {}) {
  let clock = NOW;
  let n = 0;
  const platform = new FakePlatform(
    emptyState(),
    settings(over),
    () => clock,
    () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  );
  let initHandler: InitHandler | null = null;
  const transport = {
    request: (type: string, payload?: unknown) => {
      const message = payload === undefined ? { type, correlationId: 'c'.repeat(24) } : { type, correlationId: 'c'.repeat(24), payload };
      if (!BridgeRequestSchema.safeParse(message).success) {
        return Promise.reject({ code: 'bridge/invalid-request', message: type } satisfies BridgeError);
      }
      const outcome = platform.handle(type, payload);
      if (!outcome) return Promise.reject({ code: 'bridge/unknown-type', message: type } satisfies BridgeError);
      return outcome.ok ? Promise.resolve(outcome.result) : Promise.reject(outcome.error);
    },
    onInit: (handler: InitHandler) => {
      initHandler = handler;
      return () => undefined;
    },
    onLifecycle: () => () => undefined,
  };
  const sdk = new OddsRabbitSDK(transport as unknown as BridgeTransport);
  const user = platform.settings.user;
  initHandler!({
    type: 'init',
    user,
    sessionToken: user ? 'playground' : null,
    expiresAt: null,
    capabilities: [...BRIDGE_REQUEST_TYPES],
  });
  return { sdk, platform, tick: (ms: number) => (clock += ms) };
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: BridgeError) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('a first score fills the round with made-up players that parse as real rows', async () => {
  const { sdk } = setup();
  await sdk.scores.submit({ roundKey: '2026-10-22', score: 120 });
  const top = await sdk.scores.top({ roundKey: '2026-10-22', limit: 100 });
  assert.equal(top.length, 1 + FRIENDS.length + 16);
  assert.ok(top.some((row) => row.uuid === DEFAULT_PLAYER.uuid));
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1]!.score >= top[i]!.score);

  const friends = await sdk.scores.friends({ roundKey: '2026-10-22' });
  assert.equal(friends.length, 1 + FRIENDS.length);
  assert.equal(friends.filter((row) => row.isSelf).length, 1);

  const rank = await sdk.scores.rank({ roundKey: '2026-10-22' });
  assert.equal(rank?.total, top.length);
  assert.equal(rank?.entry.isSelf, true);

  const distribution = await sdk.scores.distribution({ roundKey: '2026-10-22' });
  assert.equal(distribution.reduce((sum, b) => sum + b.count, 0), top.length);
});

test('one score per round unless keepBest, which only ever rises', async () => {
  const { sdk } = setup({ fillBoards: false });
  await sdk.scores.submit({ roundKey: 'daily-1', score: 5 });
  await rejectsWith(sdk.scores.submit({ roundKey: 'daily-1', score: 9 }), 'scores/already-submitted');

  await sdk.scores.submit({ roundKey: 'best', score: 50, keepBest: true });
  await sdk.scores.submit({ roundKey: 'best', score: 20, keepBest: true });
  await sdk.scores.submit({ roundKey: 'best', score: 80, keepBest: true });
  const [row] = await sdk.scores.top({ roundKey: 'best' });
  assert.equal(row?.score, 80);
});

test('guests read public boards but cannot write', async () => {
  const { sdk } = setup({ user: null });
  assert.deepEqual(await sdk.scores.top({ roundKey: 'r' }), []);
  assert.deepEqual(await sdk.gifts.inbox(), []);
  await rejectsWith(sdk.scores.submit({ roundKey: 'r', score: 1 }), 'scores/unauthorized');
  await rejectsWith(
    sdk.content.submit({ kind: 'drawing', title: 'Cat', image: PNG, rights: true }),
    'content/unauthorized'
  );
  await rejectsWith(sdk.gifts.send({ toUserUuid: MIKA.uuid, kind: 'clover' }), 'gifts/unauthorized');
});

test('likes: not your own row, counts move both ways, myLikes fills hearts', async () => {
  const { sdk } = setup();
  await sdk.scores.submit({ roundKey: 'gallery', score: 3 });
  await rejectsWith(sdk.scores.like({ roundKey: 'gallery', uuid: DEFAULT_PLAYER.uuid, liked: true }), 'scores/own-entry');
  await rejectsWith(sdk.scores.like({ roundKey: 'gallery', uuid: STRANGER, liked: true }), 'scores/not-found');

  const before = (await sdk.scores.top({ roundKey: 'gallery', limit: 100 })).find((r) => r.uuid === MIKA.uuid)!.likes;
  const liked = await sdk.scores.like({ roundKey: 'gallery', uuid: MIKA.uuid, liked: true });
  assert.deepEqual(liked, { liked: true, likes: before + 1 });
  assert.deepEqual(await sdk.scores.myLikes({ roundKey: 'gallery' }), [MIKA.uuid]);
  const again = await sdk.scores.like({ roundKey: 'gallery', uuid: MIKA.uuid, liked: true });
  assert.equal(again.likes, before + 1);
  await sdk.scores.like({ roundKey: 'gallery', uuid: MIKA.uuid, liked: false });
  assert.deepEqual(await sdk.scores.myLikes({ roundKey: 'gallery' }), []);
});

test('season boards gather the month from date-keyed rounds', async () => {
  const { sdk } = setup();
  await sdk.scores.submit({ roundKey: '2026-10-20', score: 10 });
  await sdk.scores.submit({ roundKey: '2026-10-21', score: 30 });
  await sdk.scores.submit({ roundKey: '2026-09-30', score: 999 });

  const board = await sdk.scores.season({ period: '2026-10', metric: 'sum' });
  assert.equal(board?.puzzleDays, 22);
  assert.equal(board?.qualifyingDays, null);
  const me = board?.entries.find((e) => e.uuid === DEFAULT_PLAYER.uuid);
  assert.equal(me?.value, 40);
  assert.equal(me?.daysPlayed, 2);
  assert.equal(me?.streak, 2);

  const qualified = await sdk.scores.season({ period: '2026-10', metric: 'qualified_avg' });
  assert.equal(qualified?.qualifyingDays, 15);

  const rank = await sdk.scores.seasonRank({ period: '2026-10' });
  assert.equal(rank?.entry?.uuid, DEFAULT_PLAYER.uuid);
  const empty = await sdk.scores.seasonRank({ period: '2026-08' });
  assert.equal(empty?.rank, null);
  assert.equal(empty?.puzzleDays, 31);
});

test('daily content and reveals come from the editor, first guess wins', async () => {
  const { sdk } = setup({
    dailyContent: {
      '2026-10-22': { content: { answer: 'CARROT' }, reveals: [{ lat: 1 }, { lat: 2 }] },
      '*': { content: { answer: 'ANY' } },
    },
  });
  assert.deepEqual(await sdk.content.daily({ roundKey: '2026-10-22' }), { roundKey: '2026-10-22', content: { answer: 'CARROT' } });
  assert.deepEqual((await sdk.content.daily({ roundKey: 'other' }))?.content, { answer: 'ANY' });

  const first = await sdk.content.reveal({ roundKey: '2026-10-22', index: 1, guess: { pick: 'a' } });
  assert.deepEqual(first.reveal, { lat: 2 });
  const second = await sdk.content.reveal({ roundKey: '2026-10-22', index: 1, guess: { pick: 'b' } });
  assert.deepEqual(second.guess, { pick: 'a' });
  await rejectsWith(sdk.content.reveal({ roundKey: '2026-10-22', index: 5, guess: {} }), 'content/invalid-guess');
  await rejectsWith(sdk.content.reveal({ roundKey: 'other', index: 0, guess: {} }), 'content/no-reveal');
});

test('content.submit: scope, stripped titles and the daily cap', async () => {
  const { sdk, platform } = setup();
  const picture = { kind: 'coloring-page', image: PNG, rights: true as const };
  await rejectsWith(sdk.content.submit({ ...picture, title: '<b></b>' }), 'content/invalid');
  for (let i = 0; i < 5; i++) await sdk.content.submit({ ...picture, title: `Cat ${i}` });
  await rejectsWith(sdk.content.submit({ ...picture, title: 'One more' }), 'content/too-many');
  assert.equal(platform.state.submissions.length, 5);

  const unscoped = setup({ scopes: [] });
  await rejectsWith(unscoped.sdk.content.submit({ ...picture, title: 'Cat' }), 'content/forbidden');
});

test('reminders: scope, lead time, five pending, replace by key, then delivery', async () => {
  const { sdk, platform, tick } = setup();
  const at = (ms: number) => new Date(NOW + ms).toISOString();
  await rejectsWith(sdk.notifications.schedule({ key: 'soon', fireAt: at(10_000), title: 't', body: 'b' }), 'notifications/bad-time');
  for (let i = 0; i < 5; i++) {
    await sdk.notifications.schedule({ key: `k${i}`, fireAt: at(3600_000 * (i + 1)), title: 't', body: 'b' });
  }
  await rejectsWith(sdk.notifications.schedule({ key: 'k5', fireAt: at(3600_000), title: 't', body: 'b' }), 'notifications/too-many');
  await sdk.notifications.schedule({ key: 'k0', fireAt: at(7200_000), title: 'moved', body: 'b' });
  assert.equal((await sdk.notifications.list()).length, 5);

  tick(2 * 3600_000 + 1);
  assert.equal((await sdk.notifications.list()).length, 3);
  assert.deepEqual(platform.state.delivered.map((r) => r.key).sort(), ['k0', 'k1']);

  assert.deepEqual(await sdk.notifications.status(), { push: true, muted: false });
  await sdk.notifications.setMuted(true);
  assert.deepEqual(await sdk.notifications.status(), { push: false, muted: true });

  const unscoped = setup({ scopes: [] });
  await rejectsWith(unscoped.sdk.notifications.schedule({ key: 'x', fireAt: at(3600_000), title: 't', body: 'b' }), 'notifications/forbidden');
});

test("showcases: friends show a copy of the player's own snapshot", async () => {
  const { sdk } = setup();
  assert.deepEqual(await sdk.showcase.friends(), []);
  await sdk.showcase.publish({ pet: 'Clover' });
  const friends = await sdk.showcase.friends();
  assert.equal(friends.length, FRIENDS.length);
  assert.deepEqual(friends[0]?.data, { pet: 'Clover' });
  assert.equal((await sdk.showcase.get(MIKA.uuid))?.username, MIKA.username);
  await rejectsWith(sdk.showcase.get(STRANGER), 'social/not-connected');
  await rejectsWith(sdk.showcase.publish({ blob: 'x'.repeat(9000) }), 'social/too-large');
});

test('gifts: once per friend per day, claim once, received gifts land in the inbox', async () => {
  const { sdk, platform, tick } = setup();
  await rejectsWith(sdk.gifts.send({ toUserUuid: DEFAULT_PLAYER.uuid, kind: 'clover' }), 'gifts/invalid');
  await rejectsWith(sdk.gifts.send({ toUserUuid: STRANGER, kind: 'clover' }), 'gifts/not-connected');
  await sdk.gifts.send({ toUserUuid: MIKA.uuid, kind: 'clover', message: 'hi' });
  await rejectsWith(sdk.gifts.send({ toUserUuid: MIKA.uuid, kind: 'clover' }), 'gifts/already-sent-today');
  assert.deepEqual(await sdk.gifts.sentToday(), [MIKA.uuid]);

  const gift = platform.receiveGift(MIKA, 'carrot', 'for you');
  const inbox = await sdk.gifts.inbox();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]?.from.username, MIKA.username);
  assert.equal((await sdk.gifts.claim(gift.giftUuid)).kind, 'carrot');
  await rejectsWith(sdk.gifts.claim(gift.giftUuid), 'gifts/claimed');
  assert.deepEqual(await sdk.gifts.inbox(), []);

  tick(24 * 3600_000);
  assert.deepEqual(await sdk.gifts.sentToday(), []);
});

test('visits: seen reports only what this call moved, inbox carries the showcase', async () => {
  const { sdk, platform } = setup();
  await sdk.showcase.publish({ burrow: 'cosy' });
  await sdk.visits.record({ toUserUuid: MIKA.uuid, kind: 'snack' });
  await rejectsWith(sdk.visits.record({ toUserUuid: MIKA.uuid, kind: 'snack' }), 'visits/already-visited-today');

  const visit = platform.receiveVisit(MIKA, 'snack');
  const [row] = await sdk.visits.inbox();
  assert.deepEqual(row?.showcase, { burrow: 'cosy' });
  assert.deepEqual((await sdk.visits.seen([visit.visitUuid])).seen, [visit.visitUuid]);
  assert.deepEqual((await sdk.visits.seen([visit.visitUuid])).seen, []);

  assert.equal(visitLine({ snack: '{username} left a snack.' }, 'snack', 'mika'), 'mika left a snack.');
  assert.equal(visitLine({}, 'hug', 'mika'), 'mika came to visit.');
});

test('signed-in storage keeps the 64 KB total the server enforces', async () => {
  const { sdk } = setup();
  const value = 'x'.repeat(16 * 1024);
  for (let i = 0; i < 4; i++) await sdk.storage.set(`k${i}`, value);
  await rejectsWith(sdk.storage.set('k4', 'y'), 'storage/tuple-size-exceeded');
  await sdk.storage.set('k0', 'small');
  await sdk.storage.set('k4', 'y');
  assert.equal(await sdk.storage.get('k4'), 'y');
  await sdk.storage.delete('k4');
  assert.equal(await sdk.storage.get('k4'), null);
});

test('matches are left to the page, which answers them as unsupported', async () => {
  const { platform } = setup();
  assert.equal(platform.handle('matches.get', { matchUuid: MIKA.uuid }), null);
  assert.equal(platform.handle('actions.share', {}), null);
});

test('made-up scores spread out rather than bunching', async () => {
  const { sdk } = setup();
  await sdk.scores.submit({ roundKey: 'spread', score: 100 });
  const scores = (await sdk.scores.top({ roundKey: 'spread', limit: 100 })).map((r) => r.score);
  assert.ok(new Set(scores).size >= 15, `only ${new Set(scores).size} distinct scores`);
  assert.ok(Math.max(...scores) - Math.min(...scores) >= 60);
});
