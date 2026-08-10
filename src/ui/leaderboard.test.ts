import assert from 'node:assert/strict';
import test from 'node:test';

import {
  medalsFor,
  pinnedFromRank,
  ranksFor,
  type LeaderboardRow,
} from './leaderboard';

function rows(...scores: number[]): LeaderboardRow[] {
  return scores.map((score, i) => ({
    uuid: `0000000${i}-0000-4000-8000-000000000000`,
    username: `p${i}`,
    score,
    createdAt: '',
    avatar: null,
    metadata: null,
  }));
}

test('shared ranks use standard competition ranking', () => {
  // 1, 2, 2, 4 — the position after a tie skips, it does not continue.
  assert.deepEqual(ranksFor(rows(100, 90, 90, 80), true), [1, 2, 2, 4]);
  assert.deepEqual(ranksFor(rows(100, 100, 100), true), [1, 1, 1]);
  assert.deepEqual(ranksFor(rows(5, 4, 3), true), [1, 2, 3]);
  assert.deepEqual(ranksFor([], true), []);
});

test('a tie only counts when it is adjacent', () => {
  // The list is pre-ordered by the server, so equal scores are always adjacent.
  // If one ever isn't, the later row must not inherit the earlier rank.
  assert.deepEqual(ranksFor(rows(10, 5, 10), true), [1, 2, 3]);
});

test('positional ranks never share', () => {
  // A hall of fame ordered by earliest submission, or a qualified_avg board
  // ordered by capped attendance: equal values are not a tie the ordering
  // expressed, so claiming one would be wrong.
  assert.deepEqual(ranksFor(rows(100, 100, 100), false), [1, 2, 3]);
  assert.deepEqual(ranksFor(rows(4.5, 4.5, 4.0), false), [1, 2, 3]);
});

test('a zero score ties like any other value', () => {
  // Guards the `prevScore !== null` sentinel: a first row scoring 0 must not
  // read as "no previous row".
  assert.deepEqual(ranksFor(rows(0, 0, 0), true), [1, 1, 1]);
});

test('a medal needs a place nobody else reached', () => {
  // The rabbit-words case: a whole daily board tied on first. Four gold medals
  // reads as a bug; four rows numbered 1 states the tie.
  assert.deepEqual(medalsFor([1, 1, 1, 1]), [null, null, null, null]);
  // A tie further down costs only its own medal.
  assert.deepEqual(medalsFor([1, 2, 2, 4]), ['🥇', null, null, null]);
  assert.deepEqual(medalsFor([1, 2, 3, 4]), ['🥇', '🥈', '🥉', null]);
  // Positional boards never share a rank, so they never lose a medal.
  assert.deepEqual(medalsFor([1, 2, 3]), ['🥇', '🥈', '🥉']);
  assert.deepEqual(medalsFor([]), []);
});

test('pinnedFromRank maps a rank answer, and null through', () => {
  const entry = rows(4200)[0]!;
  assert.deepEqual(pinnedFromRank({ rank: 412, total: 1203, entry }), {
    rank: 412,
    total: 1203,
    row: entry,
  });
  // Null is how "no session", "no rank verb" and "hasn't played" all arrive,
  // and all three mean the same thing to the caller: pin nothing.
  assert.equal(pinnedFromRank(null), null);
});
