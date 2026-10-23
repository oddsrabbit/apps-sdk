// Build pipeline for @oddsrabbit/apps-sdk.
// Produces:
//   - dist/sdk-v1.js       IIFE bundle for CDN script tag (minified, auto-installs window.OddsRabbit)
//   - dist/sdk-v1.esm.js   ESM bundle for npm consumers
//   - dist/sdk-v1.cjs      CJS bundle for legacy Node consumers
//   - dist/schemas.*       ESM + CJS for the schemas-only export
//   - dist/leaderboard-v1.js   IIFE bundle for CDN script tag (installs window.OddsRabbitUI)
//   - dist/leaderboard-v1.esm.js + .css   Shared leaderboard UI for bundler consumers
//   - dist/host/           Sandbox host page (index.html, host.js, host.css)
//   - dist/playground/     Local-development playground around the host (open /playground/)
//   - dist/2048/           Example game, servable next to the SDK bundles it loads
//   - dist/**/*.d.ts       TypeScript declarations (via tsc) + thin wrappers for stable entry paths

import * as esbuild from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const watch = process.argv.includes('--watch');

// Cache-bust ID stamped into the host page's references to its own JS/CSS.
const BUILD_ID = process.env.BUILD_ID || String(Date.now());

// 2048 example game. Its JS is copied verbatim; only index.html carries
// cache-bust placeholders.
const GAME_2048_JS = [
  'keyboard_input_manager.js',
  'html_actuator.js',
  'grid.js',
  'tile.js',
  'storage_manager.js',
  'game_manager.js',
  'application.js',
  'leaderboard.js',
];

await rm('dist', { recursive: true, force: true });
await mkdir('dist/host', { recursive: true });
await mkdir('dist/playground', { recursive: true });
await mkdir('dist/2048/js', { recursive: true });

const baseOpts = {
  bundle: true,
  target: ['es2020'],
  sourcemap: true,
  logLevel: 'info',
};

const browserOpts = { ...baseOpts, platform: 'browser' };
const neutralOpts = { ...baseOpts, platform: 'neutral' };

const buildTargets = [
  // Bridge SDK
  {
    ...browserOpts,
    entryPoints: ['src/sdk/index.ts'],
    outfile: 'dist/sdk-v1.js',
    format: 'iife',
    globalName: '__OddsRabbitSDK',
    minify: true,
  },
  {
    ...browserOpts,
    entryPoints: ['src/sdk/index.ts'],
    outfile: 'dist/sdk-v1.esm.js',
    format: 'esm',
  },
  {
    ...neutralOpts,
    entryPoints: ['src/sdk/index.ts'],
    outfile: 'dist/sdk-v1.cjs',
    format: 'cjs',
  },
  // Schemas (single source of truth, exported separately for backend tooling)
  {
    ...browserOpts,
    entryPoints: ['src/schemas/index.ts'],
    outfile: 'dist/schemas.esm.js',
    format: 'esm',
  },
  {
    ...neutralOpts,
    entryPoints: ['src/schemas/index.ts'],
    outfile: 'dist/schemas.cjs',
    format: 'cjs',
  },
  // Shared leaderboard UI. A separate bundle rather than part of sdk-v1.js:
  // only games with boards need it, and a transport library should not carry
  // DOM rendering.
  {
    ...browserOpts,
    entryPoints: ['src/ui/index.ts'],
    outfile: 'dist/leaderboard-v1.js',
    format: 'iife',
    globalName: '__OddsRabbitUI',
    minify: true,
  },
  {
    ...browserOpts,
    entryPoints: ['src/ui/index.ts'],
    outfile: 'dist/leaderboard-v1.esm.js',
    format: 'esm',
  },
  // Sandbox host page
  {
    ...browserOpts,
    entryPoints: ['src/host/host.ts'],
    outfile: 'dist/host/host.js',
    format: 'iife',
    minify: true,
  },
  // Playground: plays oddsrabbit.com around the host for local development
  {
    ...browserOpts,
    entryPoints: ['src/playground/playground.ts'],
    outfile: 'dist/playground/playground.js',
    format: 'iife',
    minify: true,
  },
];

if (watch) {
  // Watch mode: rebuild on source change. TS declarations are NOT regenerated in watch
  // (run `npm run build` for a full release build).
  const contexts = await Promise.all(buildTargets.map((opts) => esbuild.context(opts)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  await copyStaticAssets();
  console.log('Watching for changes (Ctrl+C to stop)...');
} else {
  await Promise.all(buildTargets.map((opts) => esbuild.build(opts)));
  await copyStaticAssets();
  generateDeclarations();
  await writeFile('dist/sdk-v1.d.ts', "export * from './sdk/index';\n");
  await writeFile('dist/schemas.d.ts', "export * from './schemas/index';\n");
  await writeFile('dist/leaderboard-v1.d.ts', "export * from './ui/index';\n");
  console.log('Build complete.');
}

async function copyStaticAssets() {
  const html = await readFile('src/host/host.html', 'utf8');
  const playground = await readFile('src/playground/playground.html', 'utf8');
  await Promise.all([
    writeFile('dist/host/index.html', html.replaceAll('__BUILD_ID__', BUILD_ID)),
    copyFile('src/host/host.css', 'dist/host/host.css'),
    writeFile('dist/playground/index.html', playground.replaceAll('__BUILD_ID__', BUILD_ID)),
    copyFile('src/playground/playground.css', 'dist/playground/playground.css'),
    copyFile('src/ui/leaderboard.css', 'dist/leaderboard-v1.css'),
    // The private repo stamps the SDK and UI references with content hashes
    // for the CDN; locally the build ID is enough.
    readFile('2048/index.html', 'utf8').then((game) =>
      writeFile(
        'dist/2048/index.html',
        game.replace(/__(BUILD_ID|SDK_VERSION|UI_VERSION)__/g, BUILD_ID)
      )
    ),
    copyFile('2048/styles.css', 'dist/2048/styles.css'),
    ...GAME_2048_JS.map((name) => copyFile(`2048/js/${name}`, `dist/2048/js/${name}`)),
  ]);
}

function generateDeclarations() {
  // tsconfig.build.json rather than the root config: the root one includes
  // `src/**/*` so `npm run type-check` covers the tests, and emitting from it
  // would publish a `.d.ts` for every `*.test.ts` alongside the real ones.
  execSync('tsc -p tsconfig.build.json --emitDeclarationOnly --outDir dist', {
    stdio: 'inherit',
  });
}
