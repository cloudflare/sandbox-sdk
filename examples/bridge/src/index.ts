/**
 * Sandbox Bridge Example
 *
 * This example demonstrates how to create an HTTP bridge that exposes
 * the Sandbox SDK API, allowing access from any platform (Python, Go,
 * browsers, etc.) via HTTP requests.
 *
 * The bridge handles:
 * - API key authentication via Bearer token
 * - CORS for browser clients
 * - All sandbox operations (exec, files, processes, git, code interpreter)
 *
 * Usage:
 * 1. Deploy this Worker
 * 2. Set SANDBOX_API_KEY secret: wrangler secret put SANDBOX_API_KEY
 * 3. Use the client SDK to connect:
 *
 *    import { getSandbox } from '@cloudflare/sandbox/client';
 *
 *    const sandbox = getSandbox('my-project', {
 *      baseUrl: 'https://your-bridge.workers.dev',
 *      apiKey: 'your-api-key'
 *    });
 *
 *    const result = await sandbox.exec('ls -la');
 */

import { createBridge, Sandbox } from '@cloudflare/sandbox/bridge';

// Export the Sandbox Durable Object so it can be bound
export { Sandbox };

// Create and export the bridge handler
export default createBridge();
