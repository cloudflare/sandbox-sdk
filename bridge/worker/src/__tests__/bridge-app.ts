/**
 * Test adapter — creates the bridge Hono app for use in tests.
 *
 * This replaces the old `const { app } = await import('../index')` pattern
 * now that the route logic lives in @cloudflare/sandbox/bridge.
 */
import { createBridgeApp } from '../../../../packages/sandbox/src/bridge/routes';

export const app = createBridgeApp({
  sandboxBinding: 'Sandbox',
  warmPoolBinding: 'WarmPool',
  apiPrefix: '/v1',
  healthPath: '/health'
});
