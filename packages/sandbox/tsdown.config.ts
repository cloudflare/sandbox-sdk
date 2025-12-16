import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/openai/index.ts', 'src/opencode/index.ts'],
  outDir: 'dist',
  dts: {
    sourcemap: true,
    resolve: ['@repo/shared']
  },
  sourcemap: true,
  format: 'esm',
  fixedExtension: false
});
