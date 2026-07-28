import assert from 'node:assert/strict';
import test from 'node:test';

import type { SeasonBoard, SeasonEntry, SeasonRank } from '../schemas/messages';
import { createSeasonTab, currentPeriod, formatPeriod } from './season';

function entry(over: Partial<SeasonEntry> = {}): SeasonEntry {
  return {
    uuid: '11111111-1111-4111-8111-111111111111',
    username: 'player',
    avatar: null,
    value: 100,
    daysPlayed: 10,
    average: 10,
    streak: 0,
    isSelf: false,
    ...over,
  };
}

function board(over: Partial<SeasonBoard> = {}): SeasonBoard {
  return {
    period: '2026-07',
    metric: 'sum',
    puzzleDays: 31,
    qualifyingDays: null,
    entries: [entry()],
    ...over,
  };
}

/** Build the tab and run its `load()`, which is what populates its copy. */
async function loaded(b: SeasonBoard | null, options = {}) {
  const tab = createSeasonTab({ load: () => Promise.resolve(b), ...options });
  const rows = await tab.load();
  return { tab, rows };
}

test('currentPeriod reads the month in UTC, not local time', () => {
  // 23:30 UTC on July 31 is already August 1 in UTC+13. A local read would put
  // that player on next month's empty board with half a day of July left.
  assert.equal(currentPeriod(new Date('2026-07-31T23:30:00Z')), '2026-07');
  assert.equal(currentPeriod(new Date('2026-08-01T00:30:00Z')), '2026-08');
  // Single-digit months pad.
  assert.equal(currentPeriod(new Date('2026-01-05T12:00:00Z')), '2026-01');
});

test('formatPeriod falls back to the raw string on an impossible month', () => {
  assert.equal(formatPeriod('2026-07'), 'July 2026');
  // Not "January 2027" — a looser regex would roll 13 over into the next year
  // and print it with total confidence.
  assert.equal(formatPeriod('2026-13'), '2026-13');
  assert.equal(formatPeriod('2026-00'), '2026-00');
  assert.equal(formatPeriod('nonsense'), 'nonsense');
});

test('rows carry the metric value as the ranked score', async () => {
  const { rows } = await loaded(
    board({ entries: [entry({ value: 4321, daysPlayed: 12, streak: 5 })] })
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.score, 4321);
  assert.deepEqual(rows[0]!.metadata, {
    daysPlayed: 12,
    average: 10,
    streak: 5,
  });
});

test('sum boards share ranks, qualified_avg boards stay positional', async () => {
  const sum = await loaded(board({ metric: 'sum' }));
  assert.equal(sum.tab.rankTies, true);

  // Ordered by capped attendance first, so two equal averages are not a tie.
  const qualified = await loaded(
    board({ metric: 'qualified_avg', qualifyingDays: 21 })
  );
  assert.equal(qualified.tab.rankTies, false);

  // A metric this bundle predates is still ranked by the server on its value.
  const future = await loaded(board({ metric: 'best_n' }));
  assert.equal(future.tab.rankTies, true);
});

test('an unqualified row shows progress toward the qualifier, not a bare count', async () => {
  const b = board({
    metric: 'qualified_avg',
    puzzleDays: 31,
    qualifyingDays: 21,
    entries: [entry({ daysPlayed: 14 }), entry({ daysPlayed: 21 })],
  });
  const { tab, rows } = await loaded(b);
  // Below the threshold: "14/21 days" is the only thing on the row explaining
  // why it sits under a worse average.
  assert.deepEqual(tab.badges!(rows[0]!, 0), ['14/21 days']);
  // At the threshold: a plain count.
  assert.deepEqual(tab.badges!(rows[1]!, 1), ['21 days']);
});

test('average is a badge on points boards and suppressed where it is the value', async () => {
  const sum = await loaded(
    board({ metric: 'sum', entries: [entry({ daysPlayed: 12, average: 4823.6 })] })
  );
  assert.deepEqual(sum.tab.badges!(sum.rows[0]!, 0), ['12 days', 'avg 4,824']);

  // On qualified_avg the ranked value IS the average; a badge would repeat it.
  const avg = await loaded(
    board({
      metric: 'qualified_avg',
      qualifyingDays: 5,
      entries: [entry({ daysPlayed: 12, average: 4.5 })],
    })
  );
  assert.deepEqual(avg.tab.badges!(avg.rows[0]!, 0), ['12 days']);

  // A metric this bundle predates gets no badge either: it might itself rank on
  // an average, and the badge rounds — `avg 5` beside a value of `4.50` reads
  // as a contradiction, where a missing badge only reads as less information.
  const future = await loaded(
    board({ metric: 'best_n', entries: [entry({ daysPlayed: 12, average: 4.5 })] })
  );
  assert.deepEqual(future.tab.badges!(future.rows[0]!, 0), ['12 days']);

  // Explicit override wins in both directions.
  const off = await loaded(board({ metric: 'sum' }), { showAverage: false });
  assert.deepEqual(off.tab.badges!(off.rows[0]!, 0), ['10 days']);
  const on = await loaded(board({ metric: 'qualified_avg', qualifyingDays: 5 }), {
    showAverage: true,
  });
  assert.deepEqual(on.tab.badges!(on.rows[0]!, 0), ['10 days', 'avg 10']);
});

test('streak badges only once there is a streak to show', async () => {
  const none = await loaded(board({ entries: [entry({ streak: 1, average: null })] }));
  assert.deepEqual(none.tab.badges!(none.rows[0]!, 0), ['10 days']);

  const some = await loaded(board({ entries: [entry({ streak: 7, average: null })] }));
  assert.deepEqual(some.tab.badges!(some.rows[0]!, 0), ['10 days', '🔥 7']);
});

test('values format per metric', async () => {
  const sum = await loaded(board({ metric: 'sum', entries: [entry({ value: 12345 })] }));
  assert.equal(sum.tab.formatValue(sum.rows[0]!, 0), (12345).toLocaleString());

  const avg = await loaded(
    board({ metric: 'qualified_avg', qualifyingDays: 5, entries: [entry({ value: 4.5 })] })
  );
  assert.equal(avg.tab.formatValue(avg.rows[0]!, 0), '4.50');

  // Unknown metric: don't round away the decimals of something that turns out
  // to be an average.
  const future = await loaded(board({ metric: 'best_n', entries: [entry({ value: 4.5 })] }));
  assert.equal(future.tab.formatValue(future.rows[0]!, 0), '4.50');
});

test('the qualifier states what happens below the threshold', async () => {
  const { tab } = await loaded(
    board({ metric: 'qualified_avg', puzzleDays: 31, qualifyingDays: 21, entries: [] })
  );
  // The server returns sub-qualifier players rather than hiding them, so a
  // caption that stopped at "then your average ranks you" would contradict the
  // board's own ordering.
  assert.match(tab.emptyText, /Play 21 of 31 days in July 2026 to qualify/);
  assert.match(tab.emptyText, /Below that you rank under everyone who has/);
});

test('an unsupported host reads as unavailable, never as an empty month', async () => {
  const { tab, rows } = await loaded(null);
  assert.deepEqual(rows, []);
  // `null` means the host has no season board. Saying "no scores this month"
  // would report a fact about the players that nobody has established.
  assert.match(tab.emptyText, /aren't available/);
  assert.doesNotMatch(tab.emptyText, /this month/);
});

test('a real empty month keeps its own copy', async () => {
  const { tab } = await loaded(board({ entries: [] }), {
    emptyText: 'Nobody has played this month yet — be the first.',
  });
  assert.equal(tab.emptyText, 'Nobody has played this month yet — be the first.');
});

// ---- Pinned viewer rank ----

function seasonRank(over: Partial<SeasonRank> = {}): SeasonRank {
  return {
    period: '2026-07',
    metric: 'sum',
    puzzleDays: 31,
    qualifyingDays: null,
    rank: 412,
    total: 1203,
    entry: entry({ value: 4821, daysPlayed: 18, average: 268, streak: 4 }),
    ...over,
  };
}

test('a season rank becomes a pinned row carrying the same metadata', async () => {
  const tab = createSeasonTab({
    load: () => Promise.resolve(board()),
    loadRank: () => Promise.resolve(seasonRank()),
  });
  await tab.load();
  const pinned = await tab.loadPinned!();

  assert.ok(pinned);
  assert.equal(pinned.rank, 412);
  assert.equal(pinned.total, 1203);
  assert.equal(pinned.row.score, 4821);
  // Same shape the board's own rows use, so this row renders through the tab's
  // `badges` hook untouched — a second mapping that spelled a key differently
  // would drop badges from the viewer's row and nowhere else.
  assert.deepEqual(tab.badges!(pinned.row, 20), ['18 days', 'avg 268', '🔥 4']);
});

test('no pinned row when the viewer played nothing this month', async () => {
  const tab = createSeasonTab({
    load: () => Promise.resolve(board()),
    // The envelope still arrives — it carries the qualifier — but there is no
    // placement in it.
    loadRank: () => Promise.resolve(seasonRank({ rank: null, entry: null })),
  });
  await tab.load();
  assert.equal(await tab.loadPinned!(), null);
});

test('no pinned row on a host without the rank verb', async () => {
  const tab = createSeasonTab({
    load: () => Promise.resolve(board()),
    loadRank: () => Promise.resolve(null),
  });
  await tab.load();
  assert.equal(await tab.loadPinned!(), null);
});

test('a tab given no loadRank exposes no loadPinned at all', async () => {
  const tab = createSeasonTab({ load: () => Promise.resolve(board()) });
  // Not "a hook that always resolves null" — the panel checks for the hook's
  // presence to decide whether to fetch anything.
  assert.equal(tab.loadPinned, undefined);
});

test('an unqualified pinned row shows its progress toward the qualifier', async () => {
  const tab = createSeasonTab({
    load: () =>
      Promise.resolve(board({ metric: 'qualified_avg', qualifyingDays: 21 })),
    loadRank: () =>
      Promise.resolve(
        seasonRank({
          metric: 'qualified_avg',
          qualifyingDays: 21,
          rank: 88,
          entry: entry({ value: 5.5, daysPlayed: 9, average: 5.5 }),
        })
      ),
  });
  await tab.load();
  const pinned = await tab.loadPinned!();
  assert.ok(pinned);
  // The viewer's own row is exactly where this matters: a 5.50 average sitting
  // at #88 needs the "9/21 days" to explain itself.
  assert.deepEqual(tab.badges!(pinned.row, 20), ['9/21 days']);
});
