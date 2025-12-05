/**
 * Build script for sandbox-container using Bun's bundler.
 * Produces:
 * - dist/sandbox: Standalone binary for /sandbox entrypoint
 * - dist/index.js: Legacy JS bundle for backwards compatibility
 * - dist/runtime/executors/javascript/node_executor.js: JS executor
 */

import { mkdir } from 'node:fs/promises';

// Ensure output directories exist
await mkdir('dist/runtime/executors/javascript', { recursive: true });

// Build legacy JS bundle for backwards compatibility
// Users with custom startup scripts that call `bun /container-server/dist/index.js` need this
console.log('Building legacy JS bundle...');

const legacyResult = await Bun.build({
  entrypoints: ['src/legacy.ts'],
  outdir: 'dist',
  target: 'bun',
  minify: true,
  sourcemap: 'external',
  naming: 'index.js'
});

if (!legacyResult.success) {
  console.error('Legacy bundle build failed:');
  for (const log of legacyResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(
  `  dist/index.js (${(legacyResult.outputs[0].size / 1024).toFixed(1)} KB)`
);

console.log('Building JavaScript executor...');

// Bundle the JS executor (runs on Node or Bun for code interpreter)
const executorResult = await Bun.build({
  entrypoints: ['src/runtime/executors/javascript/node_executor.ts'],
  outdir: 'dist/runtime/executors/javascript',
  target: 'node',
  minify: true,
  sourcemap: 'external'
});

if (!executorResult.success) {
  console.error('Executor build failed:');
  for (const log of executorResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(
  `  dist/runtime/executors/javascript/node_executor.js (${(executorResult.outputs[0].size / 1024).toFixed(1)} KB)`
);

console.log('Building standalone binary...');

// Compile standalone binary (bundles Bun runtime)
const proc = Bun.spawn(
  [
    'bun',
    'build',
    'src/main.ts',
    '--compile',
    '--target=bun-linux-x64',
    '--outfile=dist/sandbox',
    '--minify'
  ],
  {
    cwd: process.cwd(),
    stdio: ['inherit', 'inherit', 'inherit']
  }
);

const exitCode = await proc.exited;
if (exitCode !== 0) {
  console.error('Standalone binary build failed');
  process.exit(1);
}

// Get file size
const file = Bun.file('dist/sandbox');
const size = file.size;
console.log(`  dist/sandbox (${(size / 1024 / 1024).toFixed(1)} MB)`);

console.log('Build complete!');
