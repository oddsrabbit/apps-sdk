// Build pipeline for @oddsrabbit/apps-sdk.
// Produces:
//   - dist/sdk-v1.js       IIFE bundle for CDN script tag (minified, auto-installs window.OddsRabbit)
//   - dist/sdk-v1.esm.js   ESM bundle for npm consumers
//   - dist/sdk-v1.cjs      CJS bundle for legacy Node consumers
//   - dist/schemas.*       Same three formats for the schemas-only export
//   - dist/host/           Sandbox host page (index.html, host.js, host.css)
//   - dist/**/*.d.ts       TypeScript declarations (via tsc) + thin wrappers for stable entry paths

import * as esbuild from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const watch = process.argv.includes('--watch');

// Cache-bust ID stamped into every HTML reference to JS/CSS. Each `npm run
// build` produces a fresh ID, so deployed HTML points at unique URLs and
// browsers can't serve stale JS/CSS even if the file paths haven't changed.
// The HTML files themselves still need a short cache TTL (configured at the
// CDN layer) so the new IDs reach clients.
const BUILD_ID = process.env.BUILD_ID || String(Date.now());

// Game files for the vanilla-JS 2048 port. Game logic JS is copied verbatim;
// only index.html carries the __BUILD_ID__ placeholder.
const GAME_2048_JS = [
  'keyboard_input_manager.js',
  'html_actuator.js',
  'grid.js',
  'tile.js',
  'storage_manager.js',
  'game_manager.js',
  'application.js',
];

// Game files for the vanilla-JS Snake game. Same shape as 2048 — vanilla JS
// copied verbatim, only index.html carries the __BUILD_ID__ placeholder.
const GAME_SNAKE_JS = [
  'input_manager.js',
  'storage_manager.js',
  'game.js',
  'renderer.js',
  'application.js',
];

// Match-3 (Fruit Match). Same drop-in pattern as snake: vanilla JS copied
// verbatim, only index.html carries the __BUILD_ID__ placeholder.
const GAME_MATCH3_JS = [
  'input_manager.js',
  'storage_manager.js',
  'game.js',
  'renderer.js',
  'sound_manager.js',
  'application.js',
];

// Solitaire. Original Klondike. Splits deck/rules out of game.js since
// solitaire has materially more rules logic than the action games.
const GAME_SOLITAIRE_JS = [
  'input_manager.js',
  'storage_manager.js',
  'sound_manager.js',
  'deck.js',
  'solver.js',
  'game.js',
  'renderer.js',
  'application.js',
];

await rm('dist', { recursive: true, force: true });
await mkdir('dist/host', { recursive: true });
await mkdir('dist/rabbit-words', { recursive: true });
await mkdir('dist/2048/js', { recursive: true });
await mkdir('dist/snake/js', { recursive: true });
await mkdir('dist/snake/fonts', { recursive: true });
await mkdir('dist/snake/images', { recursive: true });
await mkdir('dist/match3/js', { recursive: true });
await mkdir('dist/solitaire/js', { recursive: true });
await mkdir('dist/solitaire/fonts', { recursive: true });
await mkdir('dist/liquid/js', { recursive: true });

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
  // Schemas (single source of truth, exported separately for backend tooling / docs site)
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
  // Sandbox host page
  {
    ...browserOpts,
    entryPoints: ['src/host/host.ts'],
    outfile: 'dist/host/host.js',
    format: 'iife',
    minify: true,
  },
  // RabbitWords — reference game
  {
    ...browserOpts,
    entryPoints: ['rabbit-words/src/main.ts'],
    outfile: 'dist/rabbit-words/main.js',
    format: 'esm',
    minify: true,
  },
];

if (watch) {
  // Watch mode: rebuild on source change. TS declarations are NOT regenerated in watch
  // (run `npm run build` for a full release build).
  const contexts = await Promise.all(buildTargets.map((opts) => esbuild.context(opts)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  await copyHostAssets();
  console.log('Watching for changes (Ctrl+C to stop)...');
} else {
  await Promise.all(buildTargets.map((opts) => esbuild.build(opts)));
  await copyHostAssets();
  generateDeclarations();
  console.log('Build complete.');
}

async function copyHostAssets() {
  await Promise.all([
    copyHtmlWithBuildId('src/host/host.html', 'dist/host/index.html'),
    copyFile('src/host/host.css', 'dist/host/host.css'),
    copyHtmlWithBuildId('rabbit-words/index.html', 'dist/rabbit-words/index.html'),
    copyFile('rabbit-words/styles.css', 'dist/rabbit-words/styles.css'),
    copyHtmlWithBuildId('2048/index.html', 'dist/2048/index.html'),
    copyFile('2048/styles.css', 'dist/2048/styles.css'),
    ...GAME_2048_JS.map((name) =>
      copyFile(`2048/js/${name}`, `dist/2048/js/${name}`)
    ),
    // Snake — original implementation, vanilla JS, no bundling needed.
    copyHtmlWithBuildId('snake/index.html', 'dist/snake/index.html'),
    copyFile('snake/styles.css', 'dist/snake/styles.css'),
    ...GAME_SNAKE_JS.map((name) =>
      copyFile(`snake/js/${name}`, `dist/snake/js/${name}`)
    ),
    // Press Start 2P (OFL 1.1, latin subset). OFL.txt ships alongside the
    // woff2 so the redistributed font carries its license, as required.
    copyFile('snake/fonts/press-start-2p-latin.woff2', 'dist/snake/fonts/press-start-2p-latin.woff2'),
    copyFile('snake/fonts/OFL.txt', 'dist/snake/fonts/OFL.txt'),
    // Snake-head sprite — the OddsRabbit "karat" rabbit icon (the in-app
    // currency mark) reused as the snake's face. 32x32 PNG with palette
    // transparency so the green body shows through around the rabbit shape.
    copyFile('snake/images/head.png', 'dist/snake/images/head.png'),
    // Match-3 (Fruit Match). Same drop-in pattern as snake.
    copyHtmlWithBuildId('match3/index.html', 'dist/match3/index.html'),
    copyFile('match3/styles.css', 'dist/match3/styles.css'),
    ...GAME_MATCH3_JS.map((name) =>
      copyFile(`match3/js/${name}`, `dist/match3/js/${name}`)
    ),
    // Solitaire. Reuses snake's Press Start 2P font — the OFL.txt ships
    // alongside it so the redistributed font carries its license.
    copyHtmlWithBuildId('solitaire/index.html', 'dist/solitaire/index.html'),
    copyFile('solitaire/styles.css', 'dist/solitaire/styles.css'),
    ...GAME_SOLITAIRE_JS.map((name) =>
      copyFile(`solitaire/js/${name}`, `dist/solitaire/js/${name}`)
    ),
    copyFile('snake/fonts/press-start-2p-latin.woff2', 'dist/solitaire/fonts/press-start-2p-latin.woff2'),
    copyFile('snake/fonts/OFL.txt', 'dist/solitaire/fonts/OFL.txt'),
    // Liquid — WebGL fluid simulation. Vendored vanilla JS, no bundling needed.
    copyHtmlWithBuildId('liquid/index.html', 'dist/liquid/index.html'),
    copyFile('liquid/js/script.js', 'dist/liquid/js/script.js'),
    copyFile('liquid/js/dat.gui.min.js', 'dist/liquid/js/dat.gui.min.js'),
    copyFile('liquid/js/bootstrap.js', 'dist/liquid/js/bootstrap.js'),
  ]);
}

// Substitutes `__BUILD_ID__` placeholders so HTML references like
// `<script src="./host.js?v=__BUILD_ID__">` point at unique URLs per build.
async function copyHtmlWithBuildId(src, dest) {
  const content = await readFile(src, 'utf8');
  await writeFile(dest, content.replaceAll('__BUILD_ID__', BUILD_ID));
}

function generateDeclarations() {
  // tsc emits to dist/<rootDir-mirror>/, e.g. dist/sdk/index.d.ts. Wrap with stable entries.
  execSync('tsc --emitDeclarationOnly --outDir dist', { stdio: 'inherit' });
}

// After tsc, write thin wrappers so package.json `types` paths stay stable as the SDK evolves.
if (!watch) {
  await writeFile('dist/sdk-v1.d.ts', "export * from './sdk/index';\n");
  await writeFile('dist/schemas.d.ts', "export * from './schemas/index';\n");
}
