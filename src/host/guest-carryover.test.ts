import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARRY_OVER_MARKER_TTL_MS,
  carryOverGuestSaves,
  carryOverMarkerKey,
  isFreshCarryOverMarker,
  readGuestEntries,
  type CarryOverDeps,
} from './guest-carryover';

function fakeAccount(initial: Record<string, string> = {}) {
  const server = new Map(Object.entries(initial));
  const local = new Set<string>();
  const calls: string[] = [];
  let failSetOn: string | null = null;
  let failedSetLands = false;
  let failGet = false;
  const deps = (entries: Array<[string, string]>): CarryOverDeps => {
    for (const [key] of entries) local.add(key);
    return {
      entries,
      get: async (key) => {
        calls.push(`get:${key}`);
        if (failGet) throw new Error('offline');
        return server.get(key) ?? null;
      },
      set: async (key, value) => {
        calls.push(`set:${key}`);
        if (key === failSetOn) {
          if (failedSetLands) server.set(key, value);
          throw new Error(failedSetLands ? 'timed out' : 'too big');
        }
        server.set(key, value);
      },
      delete: async (key) => {
        calls.push(`delete:${key}`);
        server.delete(key);
      },
      clearLocal: (key) => {
        local.delete(key);
      },
    };
  };
  return {
    server,
    local,
    calls,
    deps,
    failSet(key: string, opts: { landed?: boolean } = {}) {
      failSetOn = key;
      failedSetLands = opts.landed ?? false;
    },
    failReads() { failGet = true; },
  };
}

test('no guest saves: nothing is asked of the server', async () => {
  const account = fakeAccount();
  assert.equal(await carryOverGuestSaves(account.deps([])), 'none');
  assert.deepEqual(account.calls, []);
});

test('an empty account gets every guest save, and the guest copies are cleared', async () => {
  const account = fakeAccount();
  const outcome = await carryOverGuestSaves(
    account.deps([['pet', '{"name":"Bun"}'], ['settings', '{}']])
  );
  assert.equal(outcome, 'copied');
  assert.equal(account.server.get('pet'), '{"name":"Bun"}');
  assert.equal(account.server.get('settings'), '{}');
  assert.equal(account.local.size, 0);
});

test('an account that already has any of the keys keeps its saves, and so does the guest', async () => {
  const account = fakeAccount({ settings: '{"sound":false}' });
  const outcome = await carryOverGuestSaves(
    account.deps([['pet', '{"name":"Bun"}'], ['settings', '{}']])
  );
  assert.equal(outcome, 'conflict');
  assert.equal(account.server.get('settings'), '{"sound":false}');
  assert.equal(account.server.has('pet'), false);
  assert.deepEqual([...account.local].sort(), ['pet', 'settings']);
  assert.ok(!account.calls.some((call) => call.startsWith('set:')));
});

test('keys the account has that the guest never wrote are no conflict', async () => {
  const account = fakeAccount({ unrelated: 'x' });
  assert.equal(await carryOverGuestSaves(account.deps([['pet', '1']])), 'copied');
  assert.equal(account.server.get('pet'), '1');
});

test('a failed write undoes the copy and keeps the guest saves for next time', async () => {
  const account = fakeAccount();
  account.failSet('b');
  const outcome = await carryOverGuestSaves(account.deps([['a', '1'], ['b', '2'], ['c', '3']]));
  assert.equal(outcome, 'failed');
  assert.equal(account.server.size, 0);
  assert.deepEqual([...account.local].sort(), ['a', 'b', 'c']);
  assert.ok(!account.calls.includes('set:c'), 'stops at the first failure');
});

test('a write that timed out but landed is undone too', async () => {
  const account = fakeAccount();
  account.failSet('b', { landed: true });
  const outcome = await carryOverGuestSaves(account.deps([['a', '1'], ['b', '2'], ['c', '3']]));
  assert.equal(outcome, 'failed');
  assert.equal(account.server.size, 0, 'no partial save is left on the account');
  assert.ok(account.calls.includes('delete:b'));
  assert.ok(!account.calls.includes('delete:c'), 'never sent, so not deleted');
  assert.deepEqual([...account.local].sort(), ['a', 'b', 'c']);
});

test('a failed read copies nothing', async () => {
  const account = fakeAccount();
  account.failReads();
  assert.equal(await carryOverGuestSaves(account.deps([['a', '1']])), 'failed');
  assert.equal(account.server.size, 0);
  assert.equal(account.local.size, 1);
});

test('readGuestEntries takes only this game, with the namespace stripped', () => {
  const items: Record<string, string> = {
    'oddsrabbit:apps:rabbit:best': '10',
    'oddsrabbit:apps:rabbit-words:best': '99',
    'oddsrabbit:apps-dev:rabbit:best': '5',
    'oddsrabbit:apps:rabbit:state': '{}',
    unrelated: 'x',
  };
  const names = Object.keys(items);
  const storage = {
    length: names.length,
    key: (i: number) => names[i] ?? null,
    getItem: (name: string) => items[name] ?? null,
  };
  assert.deepEqual(readGuestEntries(storage, 'oddsrabbit:apps:rabbit:'), [
    ['best', '10'],
    ['state', '{}'],
  ]);
});

test('a sign-up marker is fresh for an hour', () => {
  const now = 1_800_000_000_000;
  assert.equal(isFreshCarryOverMarker(String(now), now), true);
  assert.equal(isFreshCarryOverMarker(String(now - CARRY_OVER_MARKER_TTL_MS), now), true);
  assert.equal(isFreshCarryOverMarker(String(now - CARRY_OVER_MARKER_TTL_MS - 1), now), false);
});

test('a missing, garbled or future marker is not fresh', () => {
  const now = 1_800_000_000_000;
  assert.equal(isFreshCarryOverMarker(null, now), false);
  assert.equal(isFreshCarryOverMarker('', now), false);
  assert.equal(isFreshCarryOverMarker('soon', now), false);
  assert.equal(isFreshCarryOverMarker(String(now + 1), now), false);
});

test('the marker sits outside every guest save prefix', () => {
  const key = carryOverMarkerKey('rabbit');
  assert.ok(!key.startsWith('oddsrabbit:apps:'));
  assert.ok(!key.startsWith('oddsrabbit:apps-dev:'));
});
