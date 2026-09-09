import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRIDGE_REQUEST_TYPES,
  BridgeRequestSchema,
  MATCH_MOVE_MAX_BYTES,
  MatchSummarySchema,
  MatchViewSchema,
} from './messages';

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function request(type: string, payload: unknown) {
  return BridgeRequestSchema.safeParse({ type, correlationId: 'c1', payload });
}

test('all six match verbs are bridge request types', () => {
  for (const verb of [
    'matches.create',
    'matches.join',
    'matches.list',
    'matches.get',
    'matches.move',
    'matches.resign',
  ]) {
    assert.ok(BRIDGE_REQUEST_TYPES.includes(verb as never), verb);
  }
});

test('matches.create bounds the table at 2..4 and invitees at maxPlayers - 1', () => {
  assert.ok(request('matches.create', { game: 'connect4', maxPlayers: 2 }).success);
  assert.ok(request('matches.create', { game: 'connect4', maxPlayers: 4, open: true }).success);
  assert.ok(!request('matches.create', { game: 'connect4', maxPlayers: 1 }).success);
  assert.ok(!request('matches.create', { game: 'connect4', maxPlayers: 5 }).success);
  assert.ok(
    !request('matches.create', {
      game: 'connect4',
      maxPlayers: 2,
      invitees: [UUID, OTHER, UUID, OTHER],
    }).success,
    'four invitees can never fit'
  );
});

test('matches.join takes a match uuid or a join code, never neither', () => {
  assert.ok(request('matches.join', { matchUuid: UUID }).success);
  assert.ok(request('matches.join', { joinCode: 'ABC234' }).success);
  assert.ok(!request('matches.join', {}).success);
  // 0, O, 1 and I are not in the alphabet — they are the characters a friend
  // misreads off a phone screen.
  assert.ok(!request('matches.join', { joinCode: 'ABC01O' }).success);
  assert.ok(!request('matches.join', { joinCode: 'abc234' }).success);
});

test('matches.move carries a version and caps the move at 2 KB', () => {
  assert.ok(request('matches.move', { matchUuid: UUID, version: 3, move: { col: 2 } }).success);
  assert.ok(!request('matches.move', { matchUuid: UUID, move: { col: 2 } }).success, 'version required');
  assert.ok(!request('matches.move', { matchUuid: UUID, version: -1, move: {} }).success);
  const huge = { tiles: 'x'.repeat(MATCH_MOVE_MAX_BYTES) };
  assert.ok(!request('matches.move', { matchUuid: UUID, version: 0, move: huge }).success);
});

test('a match view parses with wire defaults filled in', () => {
  const parsed = MatchViewSchema.safeParse({
    matchUuid: UUID,
    game: 'connect4',
    status: 'active',
    version: 4,
    maxPlayers: 2,
    players: [
      { seat: 0, uuid: UUID, username: 'me', status: 'joined', isSelf: true },
      { seat: 1, uuid: OTHER, username: 'them', status: 'joined' },
    ],
    turnSeat: 1,
    mySeat: 0,
    updatedAt: '2026-09-06T10:00:00Z',
    view: { board: [] },
  });
  assert.ok(parsed.success);
  const view = parsed.data;
  assert.equal(view.joinCode, null);
  assert.equal(view.lastMove, null);
  assert.equal(view.winnerSeat, null);
  assert.equal(view.isMyTurn, false);
  assert.equal(view.players[1]!.avatar, null);
  assert.equal(view.players[1]!.score, 0);
  assert.equal(view.players[1]!.isSelf, false);
});

test('a match with a malformed seat fails as a whole, not by dropping the seat', () => {
  // Losing a player from a match misreports whose turn it is; the match hides
  // itself instead. The LIST is parsed per match in the SDK.
  const parsed = MatchSummarySchema.safeParse({
    matchUuid: UUID,
    game: 'connect4',
    status: 'active',
    version: 1,
    maxPlayers: 2,
    players: [
      { seat: 0, uuid: UUID, username: 'me', status: 'joined' },
      { seat: 1, uuid: 'not-a-uuid', username: 'them', status: 'joined' },
    ],
    mySeat: 0,
    updatedAt: '2026-09-06T10:00:00Z',
  });
  assert.ok(!parsed.success);
});
