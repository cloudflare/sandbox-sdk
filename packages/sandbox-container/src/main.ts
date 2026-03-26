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
import type { Logger } from '@repo/shared';
import { createLogger } from '@repo/shared';
import { registerShutdownHandlers, startServer } from './server';

const logger = createLogger({ component: 'container' });
const ANSI_ESCAPE_REGEX =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes are intentional
  /\u001b\[[0-9;]*[A-Za-z]/g;

const MAX_LOG_LINE_LENGTH = 4000;

function normalizeLogLine(line: string): string | null {
  const cleaned = line.replace(ANSI_ESCAPE_REGEX, '').trim();
  if (!cleaned) {
    return null;
  }
  if (cleaned.length > MAX_LOG_LINE_LENGTH) {
    return `${cleaned.slice(0, MAX_LOG_LINE_LENGTH)}...[truncated ${cleaned.length - MAX_LOG_LINE_LENGTH} chars]`;
  }
  return cleaned;
}

interface SupervisorChildProcess {
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
}

interface SupervisorControllerOptions {
  cleanup: () => Promise<void>;
  getChild: () => SupervisorChildProcess | null;
  exit?: (code: number) => void;
  logger?: Logger;
}

export interface SupervisorController {
  isShuttingDown: () => boolean;
  onChildExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onSignal: (signal: NodeJS.Signals) => Promise<void>;
}

export function createSupervisorController({
  cleanup,
  getChild,
  exit = process.exit,
  logger: controllerLogger = logger
}: SupervisorControllerOptions): SupervisorController {
  let shuttingDown = false;

  return {
    isShuttingDown: () => shuttingDown,
    onChildExit: (code, signal) => {
      if (shuttingDown) {
        return;
      }

      if (signal) {
        controllerLogger.info('User command killed by signal', { signal });
        const signalNum = constants.signals[signal] ?? 15;
        exit(128 + signalNum);
        return;
      }

      if (code !== 0) {
        controllerLogger.info('User command failed', { exitCode: code });
        exit(code ?? 1);
        return;
      }

      controllerLogger.info(
        'User command completed successfully, server continues running'
      );
    },
    onSignal: async (signal) => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      controllerLogger.info('Received supervisor shutdown signal', { signal });

      const child = getChild();
      if (child && child.exitCode === null) {
        controllerLogger.info('Forwarding signal to child', { signal });
        child.kill(signal);
      }

      try {
        await cleanup();
        exit(0);
      } catch (error) {
        controllerLogger.error(
          'Supervisor cleanup failed',
          error instanceof Error ? error : new Error(String(error))
        );
        exit(1);
      }
    }
  };
}

export function registerSupervisorShutdownHandlers(
  controller: SupervisorController
): void {
  process.on('SIGTERM', () => {
    void controller.onSignal('SIGTERM');
  });
  process.on('SIGINT', () => {
    void controller.onSignal('SIGINT');
  });
}

export async function main(): Promise<void> {
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

  const controller = createSupervisorController({
    cleanup,
    getChild: () => child,
    logger
  });
  registerSupervisorShutdownHandlers(controller);

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
        logger.debug('User command stdout', { message });
      });
    }

    if (stderr) {
      const stderrReader = createInterface({ input: stderr });
      stderrReader.on('line', (line) => {
        const message = normalizeLogLine(line);
        if (!message) {
          return;
        }
        logger.debug('User command stderr', { message });
      });
    }
  }

  child.on('error', (err) => {
    logger.error('Failed to spawn user command', err, { command: userCmd[0] });
    if (controller.isShuttingDown()) {
      return;
    }
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    controller.onChildExit(code, signal);
  });
}

if (import.meta.main) {
  main().catch((err) => {
    logger.error('Entrypoint failed', err);
    process.exit(1);
  });
}
