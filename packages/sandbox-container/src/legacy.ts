/**
 * Legacy entry point for backwards compatibility.
 *
 * This file is bundled to dist/index.js for users who have custom startup
 * scripts that explicitly run `bun /container-server/dist/index.js`.
 *
 * Behavior:
 * - If SANDBOX_STARTED is set (meaning /sandbox binary already started the server),
 *   this is a no-op and exits cleanly.
 * - Otherwise, starts the server normally (legacy behavior for users not using
 *   the binary entrypoint).
 */

import { createLogger } from '@repo/shared';
import { registerShutdownHandlers, startServer } from './server';

const logger = createLogger({ component: 'container' });

if (process.env.SANDBOX_STARTED === 'true') {
  logger.info(
    'Server already running (SANDBOX_STARTED=true). Legacy entry is a no-op.'
  );
} else {
  logger.info('Starting server via legacy entry point');

  startServer()
    .then(({ port, cleanup }) => {
      registerShutdownHandlers(cleanup);
      logger.info('Server started via legacy entry', { port });
    })
    .catch((err) => {
      logger.error('Failed to start server via legacy entry', err);
      process.exit(1);
    });
}
