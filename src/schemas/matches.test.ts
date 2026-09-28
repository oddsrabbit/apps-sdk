import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRIDGE_REQUEST_TYPES,
  BridgeRequestSchema,
  MATCH_ERROR_CODES,
  MATCH_MOVE_MAX_BYTES,
  MatchCheckResultSchema,
  MatchNudgeResultSchema,
  MatchSummarySchema,
  MatchViewSchema,
} from './messages';

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function request(type: string, payload: unknown) {
  return BridgeRequestSchema.safeParse({ type, correlationId: 'c1', payload });
}

test('every match verb is a bridge request type', () => {
  for (const verb of [
    'matches.create',
    'matches.join',
    'matches.list',
    'matches.get',
    'matches.move',
    'matches.resign',
    'matches.nudge',
    'matches.claim',
    'matches.check',
    'matches.quick',
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
  assert.equal(view.turnStartedAt, null, 'an older host without turnStartedAt still parses');
});

test('turnStartedAt passes through when the host sends it', () => {
  const parsed = MatchSummarySchema.safeParse({
    matchUuid: UUID,
    game: 'tiles',
    status: 'active',
    version: 9,
    maxPlayers: 2,
    players: [
      { seat: 0, uuid: UUID, username: 'me', status: 'joined', isSelf: true },
      { seat: 1, uuid: OTHER, username: 'them', status: 'joined' },
    ],
    turnSeat: 1,
    turnStartedAt: '2026-09-10T08:00:00Z',
    mySeat: 0,
    updatedAt: '2026-09-10T08:00:00Z',
  });
  assert.ok(parsed.success);
  assert.equal(parsed.data.turnStartedAt, '2026-09-10T08:00:00Z');
});

test('matches.nudge and matches.claim take exactly a match uuid', () => {
  for (const verb of ['matches.nudge', 'matches.claim']) {
    assert.ok(request(verb, { matchUuid: UUID }).success, verb);
    assert.ok(!request(verb, {}).success, `${verb} needs a uuid`);
    assert.ok(!request(verb, { matchUuid: 'not-a-uuid' }).success, `${verb} rejects a bad uuid`);
  }
});

test('a nudge result is an ISO timestamp', () => {
  assert.ok(MatchNudgeResultSchema.safeParse({ nudgedAt: '2026-09-26T10:00:00Z' }).success);
  assert.ok(!MatchNudgeResultSchema.safeParse({ nudgedAt: 'yesterday' }).success);
  assert.ok(!MatchNudgeResultSchema.safeParse({}).success);
});

test('match/too-soon is a match error code', () => {
  assert.equal(MATCH_ERROR_CODES.tooSoon, 'match/too-soon');
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

test('matches.check takes 1 to 16 words of 2 to 15 letters', () => {
  assert.ok(request('matches.check', { matchUuid: UUID, words: ['QUIZ'] }).success);
  assert.ok(request('matches.check', { matchUuid: UUID, words: ['quiz', 'At'] }).success, 'any case');
  assert.ok(!request('matches.check', { matchUuid: UUID, words: [] }).success, 'at least one');
  assert.ok(!request('matches.check', { matchUuid: UUID, words: new Array(17).fill('AT') }).success, 'at most 16');
  assert.ok(!request('matches.check', { matchUuid: UUID, words: ['A'] }).success, 'one letter is not a word');
  assert.ok(!request('matches.check', { matchUuid: UUID, words: ['A'.repeat(16)] }).success, 'wider than the board');
  assert.ok(!request('matches.check', { matchUuid: UUID, words: ['CAT5'] }).success, 'letters only');
  assert.ok(!request('matches.check', { words: ['CAT'] }).success, 'needs a match');
});

test('a check result is a list of words', () => {
  assert.ok(MatchCheckResultSchema.safeParse({ invalid: [] }).success);
  assert.ok(MatchCheckResultSchema.safeParse({ invalid: ['QZX'] }).success);
  assert.ok(!MatchCheckResultSchema.safeParse({}).success);
});

test('matches.quick takes a game', () => {
  assert.ok(request('matches.quick', { game: 'tiles' }).success);
  assert.ok(!request('matches.quick', {}).success);
  assert.ok(!request('matches.quick', { game: '' }).success);
});

test('a summary carries the last move, a recap and the matchmaking flag', () => {
  const base = {
    matchUuid: UUID,
    game: 'tiles',
    status: 'active',
    version: 9,
    maxPlayers: 2,
    players: [
      { seat: 0, uuid: UUID, username: 'me', status: 'joined', isSelf: true },
      { seat: 1, uuid: OTHER, username: 'them', status: 'joined' },
    ],
    turnSeat: 0,
    mySeat: 0,
    updatedAt: '2026-09-10T08:00:00Z',
  };
  const old = MatchSummarySchema.safeParse(base);
  assert.ok(old.success);
  assert.equal(old.data.lastMove, null, 'an older host without them still parses');
  assert.equal(old.data.recap, null);
  assert.equal(old.data.matchmaking, false);

  const full = MatchSummarySchema.safeParse({
    ...base,
    lastMove: { ply: 3, seat: 1, move: { type: 'place', tiles: [] }, scoreDelta: 22 },
    recap: { lastWords: [{ word: 'QUIZ', score: 22 }] },
    matchmaking: true,
  });
  assert.ok(full.success);
  assert.equal(full.data.lastMove?.scoreDelta, 22);
  assert.deepEqual(full.data.recap, { lastWords: [{ word: 'QUIZ', score: 22 }] });
  assert.equal(full.data.matchmaking, true);
});
