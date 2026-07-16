import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node'
  },
  // Ensure we don't load standard vite plugins or config for the worker that conflict with test environments
  plugins: []
});
