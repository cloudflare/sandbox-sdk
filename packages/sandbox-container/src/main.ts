/**
 * Standalone binary entrypoint with CMD passthrough support.
 *
 * This file is the entry point when compiled with `bun build --compile`.
 * It starts the HTTP API server, then executes any user-provided CMD.
 *
 * Usage:
 *   ENTRYPOINT ["/sandbox"]
 *   CMD ["python", "app.py"]  # Optional - passed to this entrypoint
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createLogger } from '@repo/shared';
import { registerShutdownHandlers, startServer } from './server';

const logger = createLogger({ component: 'container' });

async function main(): Promise<void> {
  // Arguments after the binary name are the user's CMD
  const userCmd = process.argv.slice(2);

  logger.info('Starting sandbox entrypoint', {
    userCmd: userCmd.length > 0 ? userCmd : '(none)',
    version: process.env.SANDBOX_VERSION || 'unknown'
  });

  // Register shutdown handlers first
  registerShutdownHandlers();

  // Start the API server
  const server = await startServer();
  logger.info('API server started', { port: server.port });

  // If no user command, just keep server running
  if (userCmd.length === 0) {
    logger.info('No user command provided, running API server only');
    return; // Server keeps process alive
  }

  // Mark server as started for backwards compatibility with legacy entry point
  // This prevents double-startup when user scripts call `bun /container-server/dist/index.js`
  process.env.SANDBOX_STARTED = 'true';

  // Spawn user's command
  logger.info('Spawning user command', {
    command: userCmd[0],
    args: userCmd.slice(1)
  });

  const child: ChildProcess = spawn(userCmd[0], userCmd.slice(1), {
    stdio: 'inherit',
    env: process.env,
    shell: false
  });

  // Forward signals to child process
  const forwardSignal = (signal: NodeJS.Signals) => {
    logger.info('Forwarding signal to child', { signal });
    child.kill(signal);
  };

  process.on('SIGTERM', () => forwardSignal('SIGTERM'));
  process.on('SIGINT', () => forwardSignal('SIGINT'));

  // Handle child process errors
  child.on('error', (err) => {
    logger.error('Failed to spawn user command', err, { command: userCmd[0] });
    process.exit(1);
  });

  // Handle child exit
  child.on('exit', (code, signal) => {
    if (signal) {
      logger.info('User command killed by signal', { signal });
      // Standard Unix convention: 128 + signal number
      const signalNum =
        signal === 'SIGTERM'
          ? 15
          : signal === 'SIGINT'
            ? 2
            : signal === 'SIGKILL'
              ? 9
              : 1;
      process.exit(128 + signalNum);
    } else if (code !== 0) {
      // Non-zero exit: propagate the error
      logger.info('User command failed', { exitCode: code });
      process.exit(code ?? 1);
    } else {
      // Exit code 0: user command completed successfully
      // Keep server running so sandbox API remains available
      logger.info(
        'User command completed successfully, server continues running'
      );
    }
  });
}

main().catch((err) => {
  logger.error('Entrypoint failed', err);
  process.exit(1);
});
