import { describe, expect, it } from 'vitest';
import viteConfig from './sandbox-app/vite.config.js';

describe('Vite Sandbox Config', () => {
  it('sets server.strictPort to true so concurrent starts fail instead of auto-incrementing', () => {
    // Assert that strictPort is explicitly set to true
    expect(viteConfig.server?.strictPort).toBe(true);
  });
});
