import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRIDGE_REQUEST_TYPES,
  BridgeRequestSchema,
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_TITLE_MAX,
  NotificationScheduleResultSchema,
} from './messages';
import { AppScopeSchema } from './manifest';

function request(type: string, payload?: unknown) {
  return BridgeRequestSchema.safeParse({
    type,
    correlationId: 'c1',
    ...(payload === undefined ? {} : { payload }),
  });
}

const base = {
  key: 'nap-done',
  fireAt: '2026-09-24T18:32:00.000Z',
  title: 'Rabbit Pets',
  body: 'Clover is awake and wants to play.',
};

test('time.now and the three notification verbs are bridge request types', () => {
  for (const verb of ['time.now', 'notifications.schedule', 'notifications.cancel', 'notifications.list']) {
    assert.ok(BRIDGE_REQUEST_TYPES.includes(verb as never), verb);
  }
  assert.ok(request('time.now').success);
  assert.ok(request('notifications.list').success);
});

test('schedule keys are lowercase slugs', () => {
  assert.ok(request('notifications.schedule', base).success);
  assert.ok(!request('notifications.schedule', { ...base, key: 'Nap' }).success);
  assert.ok(!request('notifications.schedule', { ...base, key: 'nap_done' }).success);
  assert.ok(!request('notifications.schedule', { ...base, key: 'a'.repeat(65) }).success);
  assert.ok(!request('notifications.cancel', { key: '' }).success);
});

test('schedule bounds title and body, and requires a real datetime', () => {
  assert.ok(!request('notifications.schedule', { ...base, title: '' }).success);
  assert.ok(!request('notifications.schedule', { ...base, title: 'a'.repeat(NOTIFICATION_TITLE_MAX + 1) }).success);
  assert.ok(!request('notifications.schedule', { ...base, body: 'a'.repeat(NOTIFICATION_BODY_MAX + 1) }).success);
  assert.ok(!request('notifications.schedule', { ...base, fireAt: 'in two hours' }).success);
  assert.ok(request('notifications.schedule', { ...base, fireAt: '2026-09-24T14:32:00-04:00' }).success);
  assert.ok(request('notifications.schedule', { ...base, tz: 'America/New_York' }).success);
});

test('the schedule result carries when it will really be delivered', () => {
  assert.ok(
    NotificationScheduleResultSchema.safeParse({
      key: 'nap-done',
      fireAt: '2026-09-25T03:00:00Z',
      deliverAt: '2026-09-25T12:00:00Z',
      serverTime: '2026-09-24T16:32:00Z',
    }).success
  );
});

test('bridge:notifications is a manifest scope', () => {
  assert.ok(AppScopeSchema.safeParse('bridge:notifications').success);
});
