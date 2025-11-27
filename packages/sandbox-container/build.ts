/**
 * Build script for sandbox-container using Bun's bundler.
 * Bundles the container server and JS executor into standalone files.
 */

import { mkdir } from 'node:fs/promises';

// Ensure output directories exist
await mkdir('dist/runtime/executors/javascript', { recursive: true });

console.log('Building container server bundle...');

// Bundle the main container server
const serverResult = await Bun.build({
  entrypoints: ['src/index.ts'],
  outdir: 'dist',
  target: 'bun',
  minify: true,
  sourcemap: 'external'
});

if (!serverResult.success) {
  console.error('Server build failed:');
  for (const log of serverResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(
  `  dist/index.js (${(serverResult.outputs[0].size / 1024).toFixed(1)} KB)`
);

console.log('Building JavaScript executor...');

// Bundle the JS executor (runs on Node, not Bun)
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

console.log('Build complete!');
