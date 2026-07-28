// Test runner.
//
// Node 20 has `node --test` but no TypeScript, and this repo deliberately has
// no test framework — so esbuild (already a dependency, already how the games
// are built) compiles the `*.test.ts` files to ESM in a temp directory and the
// built-in runner takes it from there. No new dependency, one script.
//
// Scope is the pure logic: ranking, period arithmetic, metric formatting, the
// season tab's row mapping and copy. The DOM-rendering half of
// `src/ui/leaderboard.ts` is not covered here — that needs a DOM, which needs a
// dependency, and the parts that actually encode decisions (which rank a row
// gets, what the qualifier says, when a board counts as unsupported) are all
// reachable without one.
//
//   npm test

import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as esbuild from 'esbuild';

const OUT_DIR = '.test-build';

/** Every `*.test.ts` under `src/`. */
async function findTests(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findTests(path)));
    else if (entry.name.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

const entryPoints = await findTests('src');
if (entryPoints.length === 0) {
  console.error('No *.test.ts files found under src/.');
  process.exit(1);
}

await rm(OUT_DIR, { recursive: true, force: true });

await esbuild.build({
  entryPoints,
  outdir: OUT_DIR,
  outbase: 'src',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  // `node:test` and `node:assert` are resolved by the runtime, not bundled.
  external: ['node:*'],
  // Paired with `--enable-source-maps` below: without it a failed assertion
  // reports `.test-build/ui/season.test.js:179`, and the reader has to go find
  // which line of the `.ts` that was.
  sourcemap: 'inline',
  logLevel: 'warning',
});

const child = spawn(process.execPath, ['--enable-source-maps', '--test', OUT_DIR], {
  stdio: 'inherit',
  // Pin the locale. `formatPeriod` and the average badge deliberately render in
  // the viewer's locale (`toLocaleDateString(undefined, …)`), so the copy
  // assertions are only stable if the runner fixes one — otherwise the suite
  // passes here and fails on a machine with a German `LANG`.
  env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
});
// `exit` alone leaves a spawn failure as an unhandled `error` event.
child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
