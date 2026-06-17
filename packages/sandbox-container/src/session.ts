/**
 * Session - Persistent shell execution with reliable stdout/stderr separation
 *
 * Architecture docs: docs/SESSION_EXECUTION.md (design decisions, trade-offs, FAQ)
 * This file contains implementation details and bash concept glossary.
 *
 * Overview
 * =========
 * Maintains a persistent bash shell so session state (cwd, env vars, shell
 * functions) persists across commands. Completion-only exec() writes stdout
 * and stderr to temp files, then prefixes and merges them into a command log.
 * Bash waits for file redirects to complete before continuing, ensuring the log
 * is fully written before the exit code is published.
 *
 * Exit Detection
 * ==============
 * We write the exit code to a file and detect completion via a hybrid
 * fs.watch + polling approach to be robust on tmpfs/overlayfs.
 *
 * ============================================================================
 * BASH CONCEPTS GLOSSARY (for non-bash experts)
 * ============================================================================
 *
 * Exit Codes & Status
 * -------------------
 * - `$?`         : The exit code of the most recently completed command.
 *                  0 = success, non-zero = failure. Must capture immediately.
 *
 * I/O Redirection
 * ---------------
 * - `> file`     : Redirect stdout to file (overwrites).
 * - `2> file`    : Redirect stderr to file (fd 2 is stderr).
 * - `>> file`    : Redirect stdout to file (appends).
 * - `< /dev/null`: Redirect stdin from /dev/null (empty input, prevents hangs).
 *
 * Reading Lines
 * -------------
 * - `IFS= read -r line` : Read a line preserving whitespace and backslashes.
 *   - `IFS=` : Don't trim leading/trailing whitespace
 *   - `-r`   : Don't interpret backslashes as escapes
 * - `|| [[ -n "$line" ]]` : Handle the final line if it lacks a trailing newline.
 *   `read` returns false on EOF even if it read data; this catches that case.
 *
 * Atomic File Writes
 * ------------------
 * Pattern: Write to `file.tmp`, then `mv file.tmp file`
 * - `mv` is atomic on POSIX filesystems (rename syscall)
 * - Readers never see partial/corrupted content
 * - We use this for exit codes to prevent race conditions
 *
 * Subshells
 * ---------
 * - `( cmd )`    : Run `cmd` in a subshell (child process).
 *                  Changes to cwd, env vars don't affect parent.
 * - `{ cmd }`    : Run `cmd` in current shell (a "group command").
 *                  Changes DO affect current shell.
 *
 */

import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Logger } from '@repo/shared';
import {
  createNoOpLogger,
  logCanonicalEvent,
  redactCommand
} from '@repo/shared';
import type { Subprocess } from 'bun';
import { CONFIG } from './config';
import { SessionDestroyedError, ShellTerminatedError } from './errors';
import type { Pty } from './pty';
import type { RawExecResult, SessionOptions } from './session-types';

export type { RawExecResult, SessionOptions } from './session-types';

// Binary prefixes for output labeling (won't appear in normal text)
// Using three bytes to minimize collision probability
const STDOUT_PREFIX = '\x01\x01\x01';
const STDERR_PREFIX = '\x02\x02\x02';

// ============================================================================
// Types
// ============================================================================

/** Accumulated state tracked during exec for canonical logging. */
interface ExecState {
  outcome?: 'success' | 'error';
  durationMs?: number;
  exitCode?: number;
  stdoutLen?: number;
  stderrLen?: number;
  stderrPreview?: string;
  errorMessage?: string;
  /** exec-specific: timeout requested for this command */
  timeout?: number;
  /** Whether this command was initiated by the user or internally by the SDK */
  origin?: 'user' | 'internal';
}

interface ExecOptions {
  /** Override working directory for this command only */
  cwd?: string;
  /** Environment variables for this command only (does not persist in session). Undefined values are skipped. */
  env?: Record<string, string | undefined>;
  /** Maximum execution time in milliseconds */
  timeoutMs?: number;
  /** Whether this command was initiated by the user or internally by the SDK */
  origin?: 'user' | 'internal';
}

// ============================================================================
// Session Class
// ============================================================================

export class Session {
  private shell: Subprocess | null = null;
  private shellExitedPromise: Promise<never> | null = null;
  private ready = false;
  private isDestroying = false;
  /**
   * Exit code reported by the shell once it has exited. Null while the
   * shell is still running or exited without a numeric code.
   */
  private shellExitCode: number | null = null;
  private sessionDir: string | null = null;
  private readonly id: string;
  private readonly options: SessionOptions;
  private readonly commandTimeoutMs: number | undefined;
  private readonly logger: Logger;
  pty: Pty | null = null;

  constructor(options: SessionOptions) {
    this.id = options.id;
    this.options = options;
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? CONFIG.COMMAND_TIMEOUT_MS;
    // Use provided logger or create no-op logger (for backward compatibility/tests)
    this.logger = options.logger ?? createNoOpLogger();
  }

  /**
   * Initialize the session by spawning a persistent bash shell
   */
  async initialize(): Promise<void> {
    // Create temp directory for this session's command files
    this.sessionDir = join(tmpdir(), `session-${this.id}-${Date.now()}`);
    await mkdir(this.sessionDir, { recursive: true });

    // Determine working directory. If the requested cwd doesn't exist, we fall
    // back to the home directory since it's a natural default for shell sessions.
    const homeDir = process.env.HOME || '/root';
    let cwd = this.options.cwd || CONFIG.DEFAULT_CWD;
    try {
      await stat(cwd);
    } catch {
      this.logger.debug(
        `Shell startup directory '${cwd}' does not exist, using '${homeDir}'`,
        {
          sessionId: this.id,
          requestedCwd: cwd,
          actualCwd: homeDir
        }
      );
      cwd = homeDir;
    }

    // Spawn persistent bash with stdin pipe - no IPC or wrapper needed!
    this.shell = Bun.spawn({
      cmd: ['bash', '--norc'],
      cwd,
      env: {
        ...process.env,
        ...this.options.env,
        // Ensure bash uses UTF-8 encoding
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8'
      },
      stdin: 'pipe',
      stdout: 'ignore', // We'll read from log files instead
      stderr: 'ignore' // Ignore bash diagnostics
    });

    // Rejects on any shell exit, whether unexpected (user ran `exit`) or
    // intentional (destroy() killed the shell). Raced against waitForExitCode()
    // so callers unblock immediately when the shell dies.
    this.shellExitedPromise = new Promise<never>((_, reject) => {
      this.shell!.exited.then((exitCode) => {
        // Always reject regardless of isDestroying — concurrent code
        // awaiting this promise must settle promptly.
        if (!this.isDestroying) {
          this.logger.error(
            'Shell process exited unexpectedly',
            new Error(`Exit code: ${exitCode ?? 'unknown'}`),
            {
              sessionId: this.id,
              exitCode: exitCode ?? 'unknown'
            }
          );
        }
        this.shellExitCode = exitCode ?? null;
        this.ready = false;

        reject(
          this.isDestroying
            ? new SessionDestroyedError(this.id)
            : new ShellTerminatedError(this.id, exitCode ?? null)
        );
      }).catch((error) => {
        // Handle any errors from shell.exited promise
        if (!this.isDestroying) {
          this.logger.error(
            'Shell exit monitor error',
            error instanceof Error ? error : new Error(String(error)),
            {
              sessionId: this.id
            }
          );
        }
        this.ready = false;
        reject(
          this.isDestroying
            ? new SessionDestroyedError(this.id)
            : error instanceof Error
              ? error
              : new Error(String(error))
        );
      });
    });

    this.ready = true;
  }

  /**
   * Execute a command in the persistent shell and return the result
   */
  async exec(command: string, options?: ExecOptions): Promise<RawExecResult> {
    this.ensureReady();

    // Local copies of mutable fields — used throughout this method so
    // concurrent destroy() calls don't invalidate references mid-execution.
    const sessionDir = this.sessionDir!;
    const shell = this.shell!;
    const shellExitedPromise = this.shellExitedPromise!;

    const startTime = Date.now();
    const commandId = randomUUID();
    const logFile = join(this.sessionDir!, `${commandId}.log`);
    const exitCodeFile = join(this.sessionDir!, `${commandId}.exit`);
    const state: ExecState = {
      ...(options?.timeoutMs && { timeout: options.timeoutMs }),
      ...(options?.origin && { origin: options.origin })
    };
    let caughtError: Error | undefined;

    try {
      // State changes (cd, export, functions) persist across exec() calls.
      const bashScript = this.buildExecScript(
        command,
        commandId,
        logFile,
        exitCodeFile,
        options?.cwd,
        options?.env
      );

      // Write script to shell's stdin
      if (shell.stdin && typeof shell.stdin !== 'number') {
        shell.stdin.write(`${bashScript}\n`);
      } else {
        throw new Error('Shell stdin is not available');
      }

      // Race between:
      // 1. Normal completion (exit code file appears)
      // 2. Shell death (shell process exits unexpectedly)
      // This allows us to detect shell termination (e.g., from 'exit' command) immediately
      const exitCode = await Promise.race([
        this.waitForExitCode(exitCodeFile, options?.timeoutMs),
        shellExitedPromise
      ]);

      // Read log file and parse prefixes
      const { stdout, stderr } = await this.parseLogFile(logFile);

      // Clean up temp files
      await this.cleanupCommandFiles(logFile, exitCodeFile);

      const duration = Date.now() - startTime;

      state.exitCode = exitCode;
      state.durationMs = duration;
      state.stdoutLen = stdout.length;
      state.stderrLen = stderr.length;
      state.stderrPreview =
        stderr.length > 0 ? stderr.substring(0, 200) : undefined;
      state.outcome = 'success';

      return {
        command,
        stdout,
        stderr,
        exitCode,
        duration,
        timestamp: new Date(startTime).toISOString()
      };
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      state.outcome = 'error';
      state.errorMessage = caughtError.message;
      // Clean up on error
      await this.cleanupCommandFiles(logFile, exitCodeFile);
      throw error;
    } finally {
      const stderrPreview = state.stderrPreview
        ? redactCommand(state.stderrPreview)
        : undefined;
      logCanonicalEvent(this.logger, {
        event: 'command.exec',
        outcome: state.outcome ?? 'error',
        durationMs: state.durationMs ?? Date.now() - startTime,
        command,
        sessionId: this.id,
        commandId,
        exitCode: state.exitCode,
        stdoutLen: state.stdoutLen,
        stderrLen: state.stderrLen,
        stderrPreview,
        origin: state.origin,
        errorMessage: state.errorMessage,
        error: caughtError
      });
    }
  }

  /**
   * Check if the session is ready to execute commands
   */
  isReady(): boolean {
    return this.ready && this.shell !== null && !this.shell.killed;
  }

  /**
   * Check if the session is being torn down by an explicit destroy() call.
   * Distinguishes "session destroyed via API" from "shell died on its own"
   * (e.g., user ran `exit`).
   */
  wasDestroyed(): boolean {
    return this.isDestroying;
  }

  /**
   * Exit code observed when the shell exited, or null if the shell is
   * still running or exited without a numeric code.
   */
  getShellExitCode(): number | null {
    return this.shellExitCode;
  }

  /**
   * Destroy the session and clean up resources
   */
  async destroy(): Promise<void> {
    // Suppresses error logging for the expected shell exit that follows
    this.isDestroying = true;

    // Absorb the shellExitedPromise rejection caused by our own kill below.
    // In-flight code awaiting the same promise receives the rejection
    // through their own .catch() handlers (promise rejection is multicast).
    if (this.shellExitedPromise) {
      this.shellExitedPromise.catch(() => {});
    }
    if (this.pty) {
      await this.pty.destroy();
      this.pty = null;
    }

    if (this.shell && !this.shell.killed) {
      // Close stdin to send EOF to bash (standard way to terminate interactive shells)
      if (this.shell.stdin && typeof this.shell.stdin !== 'number') {
        try {
          this.shell.stdin.end();
        } catch {
          // stdin may already be closed
        }
      }

      // Send SIGTERM for graceful termination
      this.shell.kill();

      // Wait for shell to exit (with 1s timeout)
      try {
        await Promise.race([
          this.shell.exited,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), 1000)
          )
        ]);
      } catch {
        // Timeout: force kill with SIGKILL
        this.shell.kill('SIGKILL');
        await this.shell.exited.catch(() => {});
      }
    }

    // Clean up session directory (includes command log and exit files)
    if (this.sessionDir) {
      await rm(this.sessionDir, { recursive: true, force: true }).catch(
        () => {}
      );
    }

    this.ready = false;
    this.shell = null;
    this.shellExitedPromise = null;
    this.sessionDir = null;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Build a completion-only bash script for persistent exec().
   *
   * The command runs in the main shell, so shell state changes persist across
   * calls. Stdout and stderr are redirected to temp files, then synchronously
   * prefixed and merged into the command log before publishing the exit code.
   */
  private buildExecScript(
    command: string,
    cmdId: string,
    logFile: string,
    exitCodeFile: string,
    cwd?: string,
    env?: Record<string, string | undefined>
  ): string {
    const safeLogFile = this.escapeShellPath(logFile);
    const safeExitCodeFile = this.escapeShellPath(exitCodeFile);

    const indentLines = (input: string, spaces: number) => {
      const prefix = ' '.repeat(spaces);
      return input
        .split('\n')
        .map((line) => (line.length > 0 ? `${prefix}${line}` : ''))
        .join('\n');
    };

    const { setup: envSetupBlock, cleanup: envCleanupBlock } =
      this.buildScopedEnvBlocks(env, cmdId, { restore: true });

    const hasScopedEnv = envSetupBlock.length > 0;

    const buildCommandBlock = (indent: number): string => {
      const parts: string[] = [];
      if (hasScopedEnv) {
        parts.push(indentLines(envSetupBlock, indent));
      }
      // Indent only the first line of the user command to preserve
      // multi-line constructs like heredocs, where subsequent lines
      // (including terminators) must remain at their original positions.
      const prefix = ' '.repeat(indent + 2);
      const commandLines = command.split('\n');
      const indentedCommand =
        commandLines.length === 1
          ? `${prefix}${command}`
          : `${prefix}${commandLines[0]}\n${commandLines.slice(1).join('\n')}`;
      parts.push(indentedCommand);
      parts.push(indentLines('  EXIT_CODE=$?', indent));
      if (envCleanupBlock) {
        parts.push(indentLines(envCleanupBlock, indent));
      }
      return parts.join('\n');
    };

    let script = `{
  log=${safeLogFile}
`;

    if (cwd) {
      const safeCwd = this.escapeShellPath(cwd);
      script += `  # Save and change directory\n`;
      script += `  PREV_DIR=$(pwd)\n`;
      script += `  if cd ${safeCwd}; then\n`;
      script += `    # Execute command, redirect to temp files\n`;
      script += `    {\n`;
      script += `${buildCommandBlock(6)}\n`;
      script += `    } < /dev/null > "$log.stdout" 2> "$log.stderr"\n`;
      script += `    # Restore directory\n`;
      script += `    cd "$PREV_DIR"\n`;
      script += `  else\n`;
      script += `    printf '\x02\x02\x02%s\n' "Failed to change directory to ${safeCwd}" >> "$log"\n`;
      script += `    EXIT_CODE=1\n`;
      script += `  fi\n`;
    } else {
      script += `  # Execute command, redirect to temp files\n`;
      script += `  {\n`;
      script += `${buildCommandBlock(4)}\n`;
      script += `  } < /dev/null > "$log.stdout" 2> "$log.stderr"\n`;
    }

    script += `  \n`;
    script += `  # Prefix and merge stdout/stderr into main log\n`;
    script += `  (while IFS= read -r line || [[ -n "$line" ]]; do printf '\x01\x01\x01%s\n' "$line"; done < "$log.stdout" >> "$log") 2>/dev/null\n`;
    script += `  (while IFS= read -r line || [[ -n "$line" ]]; do printf '\x02\x02\x02%s\n' "$line"; done < "$log.stderr" >> "$log") 2>/dev/null\n`;
    script += `  rm -f "$log.stdout" "$log.stderr"\n`;
    script += `  \n`;
    script += `  # Write exit code\n`;
    script += `  echo "$EXIT_CODE" > ${safeExitCodeFile}.tmp\n`;
    script += `  mv ${safeExitCodeFile}.tmp ${safeExitCodeFile}\n`;
    script += `}`;

    return script;
  }

  private buildScopedEnvBlocks(
    env: Record<string, string | undefined> | undefined,
    cmdId: string,
    options: { restore: boolean }
  ): { setup: string; cleanup: string } {
    if (!env || Object.keys(env).length === 0) {
      return { setup: '', cleanup: '' };
    }

    const sanitizeIdentifier = (value: string) =>
      value.replace(/[^A-Za-z0-9_]/g, '_');

    const setupLines: string[] = [];
    const cleanupLines: string[] = [];
    const cmdSuffix = sanitizeIdentifier(cmdId);

    let validIndex = 0;
    Object.entries(env).forEach(([key, value]) => {
      if (value == null) {
        return;
      }

      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid environment variable name: ${key}`);
      }

      const escapedValue = value.replace(/'/g, "'\\''");

      if (options.restore) {
        const stateSuffix = `${cmdSuffix}_${validIndex}`;
        const hasVar = `__SANDBOX_HAS_${stateSuffix}`;
        const prevVar = `__SANDBOX_PREV_${stateSuffix}`;

        setupLines.push(`  ${hasVar}=0`);
        setupLines.push(`  if [ "\${${key}+x}" = "x" ]; then`);
        setupLines.push(`    ${hasVar}=1`);
        setupLines.push(`    ${prevVar}=$(printf '%q' "\${${key}}")`);
        setupLines.push('  fi');
        setupLines.push(`  export ${key}='${escapedValue}'`);

        cleanupLines.push(`  if [ "$${hasVar}" = "1" ]; then`);
        cleanupLines.push(`    eval "export ${key}=$${prevVar}"`);
        cleanupLines.push('  else');
        cleanupLines.push(`    unset ${key}`);
        cleanupLines.push('  fi');
        cleanupLines.push(`  unset ${hasVar} ${prevVar}`);
      } else {
        setupLines.push(`  export ${key}='${escapedValue}'`);
      }

      validIndex++;
    });

    return {
      setup: setupLines.join('\n'),
      cleanup: options.restore ? cleanupLines.join('\n') : ''
    };
  }

  /**
   * Wait for exit code file to appear using hybrid fs.watch + polling
   *
   * Detection strategy (multiple mechanisms for reliability):
   *   1. fs.watch on directory  → Fast, but unreliable on tmpfs/overlayfs
   *   2. Polling every 50ms     → Reliable fallback
   *   3. Timeout (if configured)→ Prevents infinite hangs
   *   4. Initial existence check→ File may already exist
   *
   * Any mechanism that detects the file first wins (via `resolved` flag).
   */
  private async waitForExitCode(
    exitCodeFile: string,
    timeoutMs?: number
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const dir = dirname(exitCodeFile);
      const filename = basename(exitCodeFile);
      let resolved = false; // First detector wins, others bail out

      // STEP 1: fs.watch for fast detection (may miss rename events on some filesystems)
      const watcher = watch(dir, async (_eventType, changedFile) => {
        if (resolved) return;

        if (changedFile === filename) {
          try {
            const exitCode = await Bun.file(exitCodeFile).text();
            resolved = true;
            watcher.close();
            clearInterval(pollInterval);
            resolve(parseInt(exitCode.trim(), 10));
          } catch {
            // Ignore transient read errors (e.g., ENOENT right after event)
            // Polling or a subsequent watch event will handle it.
          }
        }
      });

      // STEP 2: Set up polling fallback (fs.watch can miss rename events on some filesystems)
      const pollInterval = setInterval(async () => {
        if (resolved) return;

        try {
          const exists = await Bun.file(exitCodeFile).exists();
          if (exists) {
            resolved = true;
            watcher.close();
            clearInterval(pollInterval);
            const exitCode = await Bun.file(exitCodeFile).text();
            resolve(parseInt(exitCode.trim(), 10));
          }
        } catch (error) {
          // Ignore polling errors, watcher or next poll will catch it
        }
      }, 50); // Poll every 50ms as fallback

      // STEP 3: Set up timeout if configured
      const timeout = timeoutMs ?? this.commandTimeoutMs;
      if (timeout !== undefined) {
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            watcher.close();
            clearInterval(pollInterval);
            reject(new Error(`Command timeout after ${timeout}ms`));
          }
        }, timeout);
      }

      // STEP 4: Check if file already exists
      Bun.file(exitCodeFile)
        .exists()
        .then(async (exists) => {
          if (exists && !resolved) {
            resolved = true;
            watcher.close();
            clearInterval(pollInterval);
            try {
              const exitCode = await Bun.file(exitCodeFile).text();
              resolve(parseInt(exitCode.trim(), 10));
            } catch (error) {
              reject(new Error(`Failed to read exit code: ${error}`));
            }
          }
        })
        .catch((error) => {
          if (!resolved) {
            resolved = true;
            watcher.close();
            clearInterval(pollInterval);
            reject(error);
          }
        });
    });
  }

  /**
   * Parse log file and separate stdout/stderr using binary prefixes
   */
  private async parseLogFile(
    logFile: string
  ): Promise<{ stdout: string; stderr: string }> {
    const file = Bun.file(logFile);

    if (!(await file.exists())) {
      return { stdout: '', stderr: '' };
    }

    const content = await file.text();
    const lines = content.split('\n');

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith(STDOUT_PREFIX)) {
        stdoutLines.push(line.slice(STDOUT_PREFIX.length));
      } else if (line.startsWith(STDERR_PREFIX)) {
        stderrLines.push(line.slice(STDERR_PREFIX.length));
      }
      // Lines without prefix are ignored (shouldn't happen)
    }

    return {
      stdout: stdoutLines.join('\n'),
      stderr: stderrLines.join('\n')
    };
  }

  /**
   * Clean up command temp files
   */
  private async cleanupCommandFiles(
    logFile: string,
    exitCodeFile: string
  ): Promise<void> {
    try {
      await rm(logFile, { force: true });
    } catch {
      // Ignore errors
    }

    try {
      await rm(exitCodeFile, { force: true });
    } catch {
      // Ignore errors
    }
  }

  /**
   * Escape shell path for safe usage in bash scripts
   */
  private escapeShellPath(path: string): string {
    // Use single quotes to prevent any interpretation, escape existing single quotes
    return `'${path.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Ensure session is ready, throw if not
   */
  private ensureReady(): void {
    if (!this.isReady()) {
      throw new Error(`Session '${this.id}' is not ready or shell has died`);
    }
  }
}
