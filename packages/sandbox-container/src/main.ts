/**
 * Standalone binary entrypoint with CMD passthrough support.
 *
 * This file is the entry point when compiled with `bun build --compile`.
 * It starts the HTTP API server, then executes any user-provided CMD.
 *
 * Usage:
 *   ENTRYPOINT ["/sandbox"]
 *   CMD ["python", "app.py"]  # Optional - passed to this entrypoint
 *
 * Modes:
 *   - Server-only (no CMD): Runs API server with standard shutdown handlers
 *   - Supervisor (with CMD): Forwards signals to child, exits when child exits
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:os';
import { createInterface } from 'node:readline';
import { createLogger } from '@repo/shared';
import { registerShutdownHandlers, startServer } from './server';

const logger = createLogger({ component: 'container' });
const ANSI_ESCAPE_REGEX =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes are intentional
  /\u001b\[[0-9;]*[A-Za-z]/g;

function normalizeLogLine(line: string): string | null {
  const cleaned = line.replace(ANSI_ESCAPE_REGEX, '').trim();
  if (!cleaned) {
    return null;
  }
  return cleaned.slice(0, 4000);
}

async function main(): Promise<void> {
  const userCmd = process.argv.slice(2);

  logger.info('Starting sandbox entrypoint', {
    userCmd: userCmd.length > 0 ? userCmd : '(none)',
    version: process.env.SANDBOX_VERSION || 'unknown'
  });

  const { cleanup } = await startServer();

  if (userCmd.length === 0) {
    logger.info('No user command provided, running API server only');
    registerShutdownHandlers(cleanup);
    return;
  }

  // Supervisor mode: manage child process lifecycle

  // Backwards compatibility: prevents double-startup when user scripts call
  // `bun /container-server/dist/index.js`
  process.env.SANDBOX_STARTED = 'true';

  let child: ChildProcess | null = null;

  // Register signal handlers before spawn to avoid race window
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (child && !child.killed) {
      logger.info('Forwarding signal to child', { signal });
      child.kill(signal);
    }
  };
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));
  process.on('SIGINT', () => forwardSignal('SIGINT'));

  logger.info('Spawning user command', {
    command: userCmd[0],
    args: userCmd.slice(1)
  });

  const useRawChildStdio = process.env.SANDBOX_RAW_CHILD_STDIO === '1';

  child = spawn(userCmd[0], userCmd.slice(1), {
    stdio: useRawChildStdio ? 'inherit' : 'pipe',
    env: process.env,
    shell: false
  });

  if (!useRawChildStdio) {
    const stdout = child.stdout;
    const stderr = child.stderr;

    if (stdout) {
      const stdoutReader = createInterface({ input: stdout });
      stdoutReader.on('line', (line) => {
        const message = normalizeLogLine(line);
        if (!message) {
          return;
        }
        logger.info('User command stdout', { message });
      });
    }

    if (stderr) {
      const stderrReader = createInterface({ input: stderr });
      stderrReader.on('line', (line) => {
        const message = normalizeLogLine(line);
        if (!message) {
          return;
        }
        logger.warn('User command stderr', { message });
      });
    }
  }

  child.on('error', (err) => {
    logger.error('Failed to spawn user command', err, { command: userCmd[0] });
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      logger.info('User command killed by signal', { signal });
      // Unix convention: 128 + signal number
      const signalNum = constants.signals[signal] ?? 15;
      process.exit(128 + signalNum);
    } else if (code !== 0) {
      logger.info('User command failed', { exitCode: code });
      process.exit(code ?? 1);
    } else {
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
