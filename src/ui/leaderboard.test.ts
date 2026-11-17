import assert from 'node:assert/strict';
import test from 'node:test';

import {
  leaderboardAvatar,
  medalsFor,
  pinnedFromRank,
  rankLabelsFor,
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

test('an unranked row gets a dash and never a medal', () => {
  // One solver and one player who started but didn't finish: the second row
  // is the only holder of rank 2, and must not take silver for it.
  const unsolvedAtZero = { ranked: (row: LeaderboardRow) => row.score > 0 };
  assert.deepEqual(rankLabelsFor(rows(10, 0), unsolvedAtZero), ['🥇', '–']);
  assert.deepEqual(rankLabelsFor(rows(10, 9, 8, 7, 0, 0), unsolvedAtZero), [
    '🥇', '🥈', '🥉', '4', '–', '–',
  ]);
  // Without the hook every row places, as before.
  assert.deepEqual(rankLabelsFor(rows(10, 0), {}), ['🥇', '🥈']);
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

// Just enough of the DOM for leaderboardAvatar: elements with classes, a
// style, children, and listeners the test can fire.
type FakeEl = {
  tagName: string;
  className: string;
  textContent: string;
  style: Record<string, string>;
  children: FakeEl[];
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
  addEventListener(type: string, fn: () => void): void;
  appendChild(child: FakeEl): FakeEl;
  remove(): void;
  fire(type: string): void;
  [key: string]: unknown;
};

function fakeDocument(): { createElement(tag: string): FakeEl } {
  return {
    createElement(tag: string): FakeEl {
      const classes = new Set<string>();
      const listeners: Record<string, Array<() => void>> = {};
      const node: FakeEl = {
        tagName: tag.toUpperCase(),
        get className() { return [...classes].join(' '); },
        set className(v: string) { classes.clear(); v.split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
        textContent: '',
        style: {},
        children: [],
        classList: {
          add: (c) => { classes.add(c); },
          remove: (c) => { classes.delete(c); },
          contains: (c) => classes.has(c),
        },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        appendChild(child) { node.children.push(child); return child; },
        remove() {},
        fire(type) { (listeners[type] || []).forEach((fn) => fn()); },
      };
      return node;
    },
  };
}

test('an avatar photo that has loaded once shows at once when drawn again', () => {
  const g = globalThis as { document?: unknown };
  const saved = g.document;
  g.document = fakeDocument();
  try {
    const url = 'https://cdn.example/avatars/redraw-test.png';
    // First draw: the initial shows until the photo loads.
    const first = leaderboardAvatar('@ana', url) as unknown as FakeEl;
    assert.equal(first.classList.contains('lb-avatar-has-img'), false);
    assert.equal(first.children[0]!.loading, 'lazy');
    first.children[0]!.fire('load');
    assert.equal(first.classList.contains('lb-avatar-has-img'), true);

    // A redraw of the same list must not drop back to the initial.
    const again = leaderboardAvatar('@ana', url) as unknown as FakeEl;
    assert.equal(again.classList.contains('lb-avatar-has-img'), true);
    assert.notEqual(again.children[0]!.loading, 'lazy');

    // If the photo then fails, the initial comes back and the URL is forgotten.
    again.children[0]!.fire('error');
    assert.equal(again.classList.contains('lb-avatar-has-img'), false);
    const after = leaderboardAvatar('@ana', url) as unknown as FakeEl;
    assert.equal(after.classList.contains('lb-avatar-has-img'), false);
  } finally {
    g.document = saved;
  }
});
