import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'bridge/index': 'src/bridge/index.ts',
    'extensions/index': 'src/extensions/index.ts',
    'errors/index': 'src/errors/index.ts',
    'sidecar/index': 'src/sidecar/index.ts',
    // Extensions live at repo-root `extensions/` but ship as subpath exports
    // of `@cloudflare/sandbox` (e.g. `@cloudflare/sandbox/interpreter`).
    // Keeping them out of `packages/sandbox/src/` makes the SDK's core source
    // easier to scope; each entry key here decides the emitted subpath.
    'interpreter/index': '../../extensions/interpreter/src/index.ts',
    'git/index': '../../extensions/git/src/index.ts',
    'openai/index': 'src/openai/index.ts',
    'opencode/index': 'src/opencode/index.ts',
    'xterm/index': 'src/xterm/index.ts'
  },
  external: ['cloudflare:workers', 'hono'],
  loader: {
    '.tgz': 'binary'
  },
  outDir: 'dist',
  dts: {
    sourcemap: true,
    resolve: ['@repo/shared']
  },
  sourcemap: true,
  format: 'esm',
  fixedExtension: false
});
