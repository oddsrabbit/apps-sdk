import assert from 'node:assert/strict';
import test from 'node:test';

import type { BridgeError, BridgeInit, MatchView } from '../schemas/messages';
import { MATCH_ERROR_CODES, OddsRabbitSDK } from './sdk';
import type { BridgeTransport, InitHandler, LifecycleHandler } from './transport';

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/**
 * A transport with no window behind it: `request` is answered by the test,
 * `init` is delivered by calling the captured handler, lifecycle events are
 * fired by hand. Cast to the class type because the SDK only ever calls these
 * three methods on it.
 */
function fakeTransport(
  answer: (type: string, payload: unknown) => Promise<unknown>
) {
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
        capabilities: ['matches.get', 'matches.list', 'matches.move'],
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

function wireView(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    matchUuid: UUID,
    game: 'connect4',
    status: 'active',
    version: 1,
    maxPlayers: 2,
    players: [
      { seat: 0, uuid: UUID, username: 'me', status: 'joined', isSelf: true },
      { seat: 1, uuid: OTHER, username: 'them', status: 'joined' },
    ],
    turnSeat: 0,
    mySeat: 0,
    isMyTurn: true,
    updatedAt: '2026-09-06T10:00:00Z',
    view: { board: [] },
    ...over,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('list resolves [] without a round trip when signed out', async () => {
  const t = fakeTransport(() => Promise.resolve([wireView()]));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init({ user: null, sessionToken: null });
  assert.deepEqual(await sdk.matches.list(), []);
  assert.equal(t.calls.length, 0);
});

test('list parses per match: one broken match drops itself, not the list', async () => {
  const t = fakeTransport(() =>
    Promise.resolve([
      wireView(),
      wireView({ matchUuid: 'garbage' }),
      wireView({ matchUuid: OTHER, status: 'lobby', turnSeat: null }),
    ])
  );
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  const rows = await sdk.matches.list({ status: 'all' });
  assert.deepEqual(
    rows.map((r) => r.matchUuid),
    [UUID, OTHER]
  );
  assert.deepEqual(t.calls[0], { type: 'matches.list', payload: { status: 'all' } });
});

test('list degrades to [] on a host without the verb and retires the capability', async () => {
  const t = fakeTransport(() => reject('bridge/unknown-action'));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  assert.equal(sdk.capabilities.has('matches.list'), true);
  assert.deepEqual(await sdk.matches.list(), []);
  assert.equal(sdk.capabilities.has('matches.list'), false);
});

test('get rejects on a malformed view rather than resolving something partial', async () => {
  const t = fakeTransport(() => Promise.resolve({ matchUuid: UUID }));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  await assert.rejects(sdk.matches.get({ matchUuid: UUID }), /malformed match view/);
});

test('a rejected move is a per-call outcome and does not retire the verb', async () => {
  const t = fakeTransport(() => reject(MATCH_ERROR_CODES.illegalMove));
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  await assert.rejects(
    sdk.matches.move({ matchUuid: UUID, version: 1, move: { col: 9 } }),
    (error: BridgeError) => error.code === 'match/illegal-move'
  );
  assert.equal(sdk.capabilities.has('matches.move'), true, 'still supported');
});

test('watch fires on version change only, and stops itself on a finished match', async () => {
  const versions = [1, 1, 2, 2];
  let served = 0;
  const t = fakeTransport(() => {
    const version = versions[served] ?? 3;
    served += 1;
    return Promise.resolve(
      wireView(
        version === 3
          ? { version, status: 'finished', turnSeat: null, winnerSeat: 1, isMyTurn: false }
          : { version }
      )
    );
  });
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();

  const seen: MatchView[] = [];
  const stop = sdk.matches.watch(UUID, (view) => seen.push(view), { intervalMs: 1000 });
  await tick();
  assert.deepEqual(seen.map((v) => v.version), [1], 'first poll always fires');

  // Drive the remaining polls by hand rather than waiting on real timers: the
  // interval floor is 1 s, and a suite that sleeps is a suite nobody runs.
  // Pausing clears the pending timer; resuming polls immediately.
  for (let i = 0; i < 4; i += 1) {
    t.fire('pause');
    t.fire('resume');
    await tick();
  }
  assert.deepEqual(seen.map((v) => v.version), [1, 2, 3]);
  assert.equal(seen.at(-1)!.status, 'finished');

  const before = t.calls.length;
  t.fire('pause');
  t.fire('resume');
  await tick();
  assert.equal(t.calls.length, before, 'no polls after the terminal view');
  stop();
});

test('watch keeps polling through a transient error and stops on an unsupported host', async () => {
  let n = 0;
  const t = fakeTransport(() => {
    n += 1;
    if (n === 1) return reject('network/offline');
    if (n === 2) return Promise.resolve(wireView({ version: 7 }));
    return reject('bridge/unsupported-request');
  });
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();

  const errors: unknown[] = [];
  const seen: number[] = [];
  sdk.matches.watch(UUID, (view) => seen.push(view.version), {
    intervalMs: 1000,
    onError: (error) => errors.push(error),
  });
  await tick();
  assert.equal(errors.length, 1, 'transient error reported');

  t.fire('pause');
  t.fire('resume');
  await tick();
  assert.deepEqual(seen, [7], 'still polling after the error');

  t.fire('pause');
  t.fire('resume');
  await tick();
  assert.equal(sdk.capabilities.has('matches.get'), false);

  const before = t.calls.length;
  t.fire('pause');
  t.fire('resume');
  await tick();
  assert.equal(t.calls.length, before, 'stopped after unsupported');
});

test('stop() prevents any further onChange, even for a poll already in flight', async () => {
  let resolveGet: ((v: unknown) => void) | null = null;
  const t = fakeTransport(
    () => new Promise((resolve) => { resolveGet = resolve; })
  );
  const sdk = new OddsRabbitSDK(t.transport);
  t.init();
  const seen: MatchView[] = [];
  const stop = sdk.matches.watch(UUID, (view) => seen.push(view));
  stop();
  resolveGet!(wireView());
  await tick();
  assert.equal(seen.length, 0);
});
