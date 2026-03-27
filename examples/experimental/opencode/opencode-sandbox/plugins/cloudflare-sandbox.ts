/**
 * OpenCode Sandbox Plugin
 *
 * Starts a Cap'n Web WebSocket server on port 3001. The Worker's DO connects
 * and exposes a SandboxRpcApi stub that custom tools use for sandboxed execution.
 */
import type { Plugin } from '@opencode-ai/plugin';
import { createLogger } from '../cloudflare-sandbox/logger';
import { createRPCSocket } from '../cloudflare-sandbox/rpc';

export const SandboxPlugin: Plugin = async (ctx) => {
  const { client } = ctx;

  const logger = createLogger({ app: client.app });

  logger.info('starting server');
  createRPCSocket({ logger });
};
