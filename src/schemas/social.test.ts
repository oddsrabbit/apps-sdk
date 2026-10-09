import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRIDGE_REQUEST_TYPES,
  BridgeInitSchema,
  BridgeRequestSchema,
  GIFT_MESSAGE_MAX,
  GiftSchema,
  ShowcaseSchema,
  VISIT_ERROR_CODES,
  VISITS_SEEN_MAX,
  VisitSchema,
  VisitSeenResultSchema,
} from './messages';
import { AppManifestSchema, AppScopeSchema, VISIT_LINE_MAX, VisitLinesSchema } from './manifest';

const FRIEND = '22222222-2222-4222-8222-222222222222';
const GIFT = '33333333-3333-4333-8333-333333333333';
const VISIT = '44444444-4444-4444-8444-444444444444';
const WHEN = '2026-09-25T16:32:00Z';

function request(type: string, payload?: unknown) {
  return BridgeRequestSchema.safeParse({
    type,
    correlationId: 'c1',
    ...(payload === undefined ? {} : { payload }),
  });
}

test('the showcase and gift verbs are bridge request types', () => {
  for (const verb of [
    'showcase.publish',
    'showcase.friends',
    'showcase.get',
    'gifts.send',
    'gifts.inbox',
    'gifts.claim',
    'gifts.sentToday',
  ]) {
    assert.ok(BRIDGE_REQUEST_TYPES.includes(verb as never), verb);
  }
  assert.ok(request('gifts.inbox').success);
  assert.ok(request('gifts.sentToday').success);
  assert.ok(request('showcase.friends').success);
});

test('showcase.publish takes an object, not an array or a string', () => {
  assert.ok(request('showcase.publish', { data: { name: 'Clover', coat: 'cream' } }).success);
  assert.ok(request('showcase.publish', { data: {} }).success);
  assert.ok(!request('showcase.publish', { data: ['Clover'] }).success);
  assert.ok(!request('showcase.publish', { data: 'Clover' }).success);
});

test('showcase.friends limits to 1..100 and showcase.get needs a uuid', () => {
  assert.ok(request('showcase.friends', { limit: 100 }).success);
  assert.ok(!request('showcase.friends', { limit: 0 }).success);
  assert.ok(!request('showcase.friends', { limit: 101 }).success);
  assert.ok(request('showcase.get', { userUuid: FRIEND }).success);
  assert.ok(!request('showcase.get', { userUuid: 'clover' }).success);
});

test('gifts.send checks kind and message shape', () => {
  const base = { toUserUuid: FRIEND, kind: 'clover' };
  assert.ok(request('gifts.send', base).success);
  assert.ok(request('gifts.send', { ...base, message: 'For you!' }).success);
  assert.ok(!request('gifts.send', { ...base, kind: 'Clover' }).success);
  assert.ok(!request('gifts.send', { ...base, kind: 'a'.repeat(33) }).success);
  assert.ok(!request('gifts.send', { ...base, message: 'a'.repeat(GIFT_MESSAGE_MAX + 1) }).success);
  assert.ok(!request('gifts.send', { ...base, toUserUuid: 'me' }).success);
  assert.ok(request('gifts.claim', { giftUuid: GIFT }).success);
  assert.ok(!request('gifts.claim', {}).success);
});

test('rows default a missing avatar and message to null', () => {
  const showcase = ShowcaseSchema.parse({
    uuid: FRIEND,
    username: 'mika',
    data: { name: 'Pip' },
    updatedAt: '2026-09-24T16:32:00Z',
  });
  assert.equal(showcase.avatar, null);
  const gift = GiftSchema.parse({
    giftUuid: GIFT,
    from: { uuid: FRIEND, username: 'mika' },
    kind: 'clover',
    sentAt: '2026-09-24T16:32:00Z',
  });
  assert.equal(gift.message, null);
  assert.equal(gift.from.avatar, null);
});

test('bridge:social is a manifest scope', () => {
  assert.ok(AppScopeSchema.safeParse('bridge:social').success);
});

// ─── visits ──────────────────────────────────────────────────────────────

test('the visit verbs are bridge request types', () => {
  for (const verb of ['visits.record', 'visits.inbox', 'visits.seen', 'visits.sentToday']) {
    assert.ok(BRIDGE_REQUEST_TYPES.includes(verb as never), verb);
  }
  assert.ok(request('visits.inbox').success);
  assert.ok(request('visits.sentToday').success);
});

test('visits.record checks the friend and the kind', () => {
  assert.ok(request('visits.record', { toUserUuid: FRIEND, kind: 'snack' }).success);
  assert.ok(!request('visits.record', { toUserUuid: FRIEND, kind: 'Snack' }).success);
  assert.ok(!request('visits.record', { toUserUuid: FRIEND, kind: 'a'.repeat(33) }).success);
  assert.ok(!request('visits.record', { toUserUuid: 'me', kind: 'snack' }).success);
  assert.ok(!request('visits.record', { toUserUuid: FRIEND }).success);
});

test('visits.seen takes 1 to 50 visit uuids', () => {
  assert.ok(request('visits.seen', { visitUuids: [VISIT] }).success);
  assert.ok(request('visits.seen', { visitUuids: Array(VISITS_SEEN_MAX).fill(VISIT) }).success);
  assert.ok(!request('visits.seen', { visitUuids: [] }).success);
  assert.ok(!request('visits.seen', { visitUuids: Array(VISITS_SEEN_MAX + 1).fill(VISIT) }).success);
  assert.ok(!request('visits.seen', { visitUuids: ['nope'] }).success);
  assert.ok(!request('visits.seen', { visitUuids: VISIT }).success);
});

test('a visit row defaults seenAt, avatar and showcase to null, and counts to true', () => {
  const visit = VisitSchema.parse({
    visitUuid: VISIT,
    kind: 'pat',
    visitedAt: WHEN,
    from: { uuid: FRIEND, username: 'mika' },
  });
  assert.equal(visit.seenAt, null);
  assert.equal(visit.from.avatar, null);
  assert.equal(visit.showcase, null);
  assert.equal(visit.counts, true);
  const full = VisitSchema.parse({
    ...visit,
    seenAt: WHEN,
    showcase: { name: 'Pip', coat: 'grey' },
    counts: false,
  });
  assert.deepEqual(full.showcase, { name: 'Pip', coat: 'grey' });
  assert.equal(full.counts, false);
  assert.ok(!VisitSchema.safeParse({ ...visit, showcase: ['Pip'] }).success);
});

test('visits.seen results list uuids and a time', () => {
  assert.ok(VisitSeenResultSchema.safeParse({ seen: [VISIT], seenAt: WHEN }).success);
  assert.ok(VisitSeenResultSchema.safeParse({ seen: [], seenAt: WHEN }).success);
  assert.ok(!VisitSeenResultSchema.safeParse({ seen: ['x'], seenAt: WHEN }).success);
});

test('visit error codes live under visits/*', () => {
  assert.deepEqual(Object.values(VISIT_ERROR_CODES).sort(), [
    'visits/already-visited-today',
    'visits/invalid',
    'visits/not-connected',
    'visits/rate-limited',
    'visits/too-many',
  ]);
});

test('gift rows gain counts, defaulting to true for older hosts', () => {
  const base = { giftUuid: GIFT, from: { uuid: FRIEND, username: 'mika' }, kind: 'clover', sentAt: WHEN };
  assert.equal(GiftSchema.parse(base).counts, true);
  assert.equal(GiftSchema.parse({ ...base, counts: false }).counts, false);
});

test('the init user carries supporter, false on older hosts', () => {
  const init = (user: Record<string, unknown>) =>
    BridgeInitSchema.parse({ type: 'init', user, sessionToken: null, expiresAt: null });
  assert.equal(init({ uuid: FRIEND, username: 'mika' }).user?.supporter, false);
  assert.equal(init({ uuid: FRIEND, username: 'mika', supporter: true }).user?.supporter, true);
});

test('the manifest may carry visit lines with one {username} each', () => {
  const lines = {
    pat: '{username} came by and gave her a pat.',
    snack: '{username} came by and left a snack.',
    brush: '{username} came by and brushed her.',
  };
  assert.ok(VisitLinesSchema.safeParse(lines).success);
  assert.ok(!VisitLinesSchema.safeParse({ pat: 'Someone came by.' }).success);
  assert.ok(!VisitLinesSchema.safeParse({ pat: '{username} and {username}' }).success);
  assert.ok(!VisitLinesSchema.safeParse({ Pat: '{username} came by.' }).success);
  assert.ok(!VisitLinesSchema.safeParse({ pat: '{username}' + 'a'.repeat(VISIT_LINE_MAX) }).success);
  assert.ok(!VisitLinesSchema.safeParse({ pat: '{username}\ncame by.' }).success);
  const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['k' + i, '{username} came by.']));
  assert.ok(!VisitLinesSchema.safeParse(many).success);

  const manifest = {
    id: 'rabbit-pets',
    name: 'Rabbit Pets',
    developer: 'OddsRabbit',
    surface: 'games',
    appUrl: 'https://apps.oddsrabbit.com/rabbit-pets/',
    sdkVersion: '1',
    scopes: ['bridge:social'],
    version: '1.0.0',
    updatedAt: WHEN,
  };
  assert.ok(AppManifestSchema.safeParse(manifest).success);
  assert.ok(AppManifestSchema.safeParse({ ...manifest, social: { visitLines: lines } }).success);
  assert.ok(!AppManifestSchema.safeParse({ ...manifest, social: { visitLines: { pat: 'hi' } } }).success);
});
