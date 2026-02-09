/**
 * Session - Persistent shell execution with reliable stdout/stderr separation
 *
 * Architecture docs: docs/SESSION_EXECUTION.md (design decisions, trade-offs, FAQ)
 * This file contains implementation details and bash concept glossary.
 *
 * Overview
 * =========
 * Maintains a persistent bash shell so session state (cwd, env vars, shell
 * functions) persists across commands. Separates stdout and stderr by writing
 * binary prefixes to a shared log, which we later parse to reconstruct streams.
 *
 * Execution Modes
 * ===============
 * - Foreground (exec): Runs in the main shell (state persists). Writes stdout
 *   and stderr to temp files, then prefixes and merges them into the log.
 *   Bash waits for file redirects to complete before continuing, ensuring
 *   the log is fully written before the exit code is published.
 *
 * - Background (execStream/startProcess): Uses FIFOs + background labelers.
 *   The command runs in a subshell redirected to FIFOs; labelers read from
 *   FIFOs and prefix lines into the log; we write an exit code file and a
 *   monitor waits for labelers to finish before signaling completion.
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
 * FIFOs (Named Pipes)
 * -------------------
 * A FIFO is a special file that acts as a pipe between processes. Created with
 * `mkfifo`. One process writes, another reads. Key behaviors:
 * - Reading from a FIFO blocks until data arrives
 * - Writing to a FIFO blocks until someone reads
 * - When all writers close the FIFO, readers get EOF (end-of-file)
 * - Must be deleted after use (they persist on disk unlike anonymous pipes)
 *
 * Backgrounding & Process IDs
 * ---------------------------
 * - `{ cmd } &`  : Run `cmd` in a background subshell. The `&` returns control
 *                  immediately while the command continues executing.
 * - `$!`         : The PID (process ID) of the most recently backgrounded process.
 *                  Must capture immediately after `&` since it changes with each bg.
 * - `wait $PID`  : Block until the process with given PID exits.
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
 * Signal Handling
 * ---------------
 * - `trap 'cmd' EXIT HUP INT TERM` : Run `cmd` when shell exits or receives
 *   signals. Used for cleanup (removing temp files, FIFOs). EXIT fires on
 *   normal exit; HUP/INT/TERM fire on hangup/interrupt/terminate signals.
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
 * - We use this for exit codes and PIDs to prevent race conditions
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
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ExecEvent, Logger } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import type { Subprocess } from 'bun';
import { CONFIG } from './config';
import type { Pty } from './pty';

// Binary prefixes for output labeling (won't appear in normal text)
// Using three bytes to minimize collision probability
const STDOUT_PREFIX = '\x01\x01\x01';
const STDERR_PREFIX = '\x02\x02\x02';

// ============================================================================
// Types
// ============================================================================

export interface SessionOptions {
  /** Session identifier (generated if not provided) */
  id: string;

  /**
   * Initial working directory for the shell.
   *
   * Note: This only affects where the shell starts. Individual commands can
   * specify their own cwd via exec options, and the shell can cd anywhere.
   * If the specified directory doesn't exist when the session initializes,
   * the session will fall back to the home directory.
   */
  cwd?: string;

  /** Environment variables for the session. Undefined values are skipped. */
  env?: Record<string, string | undefined>;

  /** Legacy isolation flag (ignored - kept for compatibility) */
  isolation?: boolean;

  /** Command timeout in milliseconds (overrides CONFIG.COMMAND_TIMEOUT_MS) */
  commandTimeoutMs?: number;

  /** Logger instance for structured logging (optional - uses no-op logger if not provided) */
  logger?: Logger;
}

export interface RawExecResult {
  /** Standard output */
  stdout: string;

  /** Standard error */
  stderr: string;

  /** Process exit code */
  exitCode: number;

  /** Command that was executed */
  command: string;

  /** Execution duration in milliseconds */
  duration: number;

  /** ISO timestamp when command started */
  timestamp: string;
}

interface ExecOptions {
  /** Override working directory for this command only */
  cwd?: string;
  /** Environment variables for this command only (does not persist in session). Undefined values are skipped. */
  env?: Record<string, string | undefined>;
}

/** Command handle for tracking and killing running commands */
interface CommandHandle {
  /** Unique command identifier */
  commandId: string;
  /** Process ID of the command (not the shell) */
  pid?: number;
  /** Path to PID file */
  pidFile: string;
  /** Path to log file */
  logFile: string;
  /** Path to exit code file */
  exitCodeFile: string;
}

// ============================================================================
// Session Class
// ============================================================================

export class Session {
  private shell: Subprocess | null = null;
  private shellExitedPromise: Promise<never> | null = null;
  private ready = false;
  private isDestroying = false;
  private sessionDir: string | null = null;
  private readonly id: string;
  private readonly options: SessionOptions;
  private readonly commandTimeoutMs: number | undefined;
  private readonly logger: Logger;
  /** Map of running commands for tracking and killing */
  private runningCommands = new Map<string, CommandHandle>();

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
    // Create temp directory for this session's FIFO files
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

    // Shell death sentinel: a Promise<never> that NEVER resolves, only rejects.
    //
    // Used in Promise.race to detect unexpected shell termination:
    //   await Promise.race([waitForExitCode(...), this.shellExitedPromise])
    //
    // If shell dies (e.g., user runs `exit`), this rejects immediately,
    // letting us report "shell terminated" instead of hanging forever.
    this.shellExitedPromise = new Promise<never>((_, reject) => {
      this.shell!.exited.then((exitCode) => {
        // If we're intentionally destroying the session, don't log error or reject
        if (this.isDestroying) {
          return;
        }

        this.logger.error(
          'Shell process exited unexpectedly',
          new Error(`Exit code: ${exitCode ?? 'unknown'}`),
          {
            sessionId: this.id,
            exitCode: exitCode ?? 'unknown'
          }
        );
        this.ready = false;

        // Reject with clear error message
        reject(
          new Error(
            `Shell terminated unexpectedly (exit code: ${exitCode ?? 'unknown'}). Session is dead and cannot execute further commands.`
          )
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
          this.ready = false;
          reject(error);
        }
      });
    });

    this.ready = true;
  }

  /**
   * Execute a command in the persistent shell and return the result
   */
  async exec(command: string, options?: ExecOptions): Promise<RawExecResult> {
    this.ensureReady();

    const startTime = Date.now();
    const commandId = randomUUID();
    const logFile = join(this.sessionDir!, `${commandId}.log`);
    const exitCodeFile = join(this.sessionDir!, `${commandId}.exit`);
    const pidFile = join(this.sessionDir!, `${commandId}.pid`);

    this.logger.info('Command execution started', {
      sessionId: this.id,
      commandId,
      operation: 'exec',
      command: command.substring(0, 100)
    });

    try {
      // Track command
      this.trackCommand(commandId, pidFile, logFile, exitCodeFile);

      // Build FIFO-based bash script for FOREGROUND execution
      // State changes (cd, export, functions) persist across exec() calls
      const bashScript = this.buildFIFOScript(
        command,
        commandId,
        logFile,
        exitCodeFile,
        options?.cwd,
        false,
        options?.env
      );

      // Write script to shell's stdin
      if (this.shell!.stdin && typeof this.shell!.stdin !== 'number') {
        this.shell!.stdin.write(`${bashScript}\n`);
      } else {
        throw new Error('Shell stdin is not available');
      }

      // Race between:
      // 1. Normal completion (exit code file appears)
      // 2. Shell death (shell process exits unexpectedly)
      // This allows us to detect shell termination (e.g., from 'exit' command) immediately
      const exitCode = await Promise.race([
        this.waitForExitCode(exitCodeFile),
        this.shellExitedPromise!
      ]);

      // Read log file and parse prefixes
      const { stdout, stderr } = await this.parseLogFile(logFile);

      // Untrack command
      this.untrackCommand(commandId);

      // Clean up temp files
      await this.cleanupCommandFiles(logFile, exitCodeFile);

      const duration = Date.now() - startTime;

      this.logger.info('Command execution completed', {
        sessionId: this.id,
        commandId,
        operation: 'exec',
        exitCode,
        duration
      });

      return {
        command,
        stdout,
        stderr,
        exitCode,
        duration,
        timestamp: new Date(startTime).toISOString()
      };
    } catch (error) {
      this.logger.error(
        'Command execution failed',
        error instanceof Error ? error : new Error(String(error)),
        {
          sessionId: this.id,
          commandId,
          operation: 'exec'
        }
      );
      // Untrack and clean up on error
      this.untrackCommand(commandId);
      await this.cleanupCommandFiles(logFile, exitCodeFile);
      throw error;
    }
  }

  /**
   * Execute a command with streaming output (maintains session state!)
   *
   * @param command - The command to execute
   * @param options - Execution options including required commandId for tracking
   */
  async *execStream(
    command: string,
    options?: ExecOptions & { commandId?: string }
  ): AsyncGenerator<ExecEvent> {
    this.ensureReady();

    const startTime = Date.now();
    const commandId = options?.commandId || randomUUID();
    const logFile = join(this.sessionDir!, `${commandId}.log`);
    const exitCodeFile = join(this.sessionDir!, `${commandId}.exit`);
    const pidFile = join(this.sessionDir!, `${commandId}.pid`);
    const pidPipe = join(this.sessionDir!, `${commandId}.pid.pipe`);
    const labelersDoneFile = join(
      this.sessionDir!,
      `${commandId}.labelers.done`
    );

    this.logger.info('Streaming command execution started', {
      sessionId: this.id,
      commandId,
      operation: 'execStream',
      command: command.substring(0, 100)
    });

    try {
      // Track command
      this.trackCommand(commandId, pidFile, logFile, exitCodeFile);

      // Create PID notification FIFO before sending command
      // This ensures synchronization: shell writes PID, we read it (blocking)
      await this.createPidPipe(pidPipe);

      // Build FIFO script for BACKGROUND execution
      // Command runs concurrently, shell continues immediately
      const bashScript = this.buildFIFOScript(
        command,
        commandId,
        logFile,
        exitCodeFile,
        options?.cwd,
        true,
        options?.env,
        pidPipe
      );

      if (this.shell!.stdin && typeof this.shell!.stdin !== 'number') {
        this.shell!.stdin.write(`${bashScript}\n`);
      } else {
        throw new Error('Shell stdin is not available');
      }

      // Wait for PID via FIFO (blocking read - guarantees synchronization)
      const pid = await this.waitForPidViaPipe(pidPipe, pidFile);

      if (pid === undefined) {
        this.logger.warn('PID not received within timeout', {
          sessionId: this.id,
          commandId,
          pidPipe
        });
      }

      yield {
        type: 'start',
        timestamp: new Date().toISOString(),
        command,
        pid
      };

      // Hybrid approach: poll log file until exit code is written
      // (fs.watch on log file would trigger too often during writes)
      let position = 0;
      let exitCodeContent = '';

      // Wait until exit code file exists, checking for shell death on each iteration
      while (true) {
        // Check if shell is still alive (will be false if shell died)
        if (!this.isReady()) {
          // Shell died - throw the error from shellExitedPromise
          await this.shellExitedPromise!.catch((error) => {
            throw error;
          });
        }

        const exitFile = Bun.file(exitCodeFile);
        if (await exitFile.exists()) {
          exitCodeContent = (await exitFile.text()).trim();
          break;
        }

        // Stream any new log content while waiting
        const file = Bun.file(logFile);
        if (await file.exists()) {
          const content = await file.text();
          const newContent = content.slice(position);
          position = content.length;

          // Yield chunks with binary prefix parsing
          if (newContent) {
            const lines = newContent.split('\n');
            for (const line of lines) {
              if (!line) continue;

              if (line.startsWith(STDOUT_PREFIX)) {
                yield {
                  type: 'stdout',
                  data: `${line.slice(STDOUT_PREFIX.length)}\n`,
                  timestamp: new Date().toISOString()
                };
              } else if (line.startsWith(STDERR_PREFIX)) {
                yield {
                  type: 'stderr',
                  data: `${line.slice(STDERR_PREFIX.length)}\n`,
                  timestamp: new Date().toISOString()
                };
              }
            }
          }
        }

        await Bun.sleep(CONFIG.STREAM_CHUNK_DELAY_MS);
      }

      /*
       * Wait for labelers done marker file.
       * The exit code file is written by the command subshell, but labelers
       * run in parallel background processes. The background monitor creates
       * the labelers done file after waiting for labelers to finish.
       */
      const maxWaitMs = 5000;
      const startWait = Date.now();
      let labelersDone = false;
      while (Date.now() - startWait < maxWaitMs) {
        const doneFile = Bun.file(labelersDoneFile);
        if (await doneFile.exists()) {
          labelersDone = true;
          break;
        }
        await Bun.sleep(CONFIG.STREAM_CHUNK_DELAY_MS);
      }

      if (!labelersDone) {
        this.logger.warn('Output capture timeout - logs may be incomplete', {
          commandId,
          sessionId: this.id,
          timeoutMs: maxWaitMs
        });
      }

      // Read final chunks from log file after labelers are done
      const file = Bun.file(logFile);
      if (await file.exists()) {
        const logContent = await file.text();
        const finalContent = logContent.slice(position);

        // Process final chunks
        if (finalContent) {
          const lines = finalContent.split('\n');
          for (const line of lines) {
            if (!line) continue;

            if (line.startsWith(STDOUT_PREFIX)) {
              yield {
                type: 'stdout',
                data: `${line.slice(STDOUT_PREFIX.length)}\n`,
                timestamp: new Date().toISOString()
              };
            } else if (line.startsWith(STDERR_PREFIX)) {
              yield {
                type: 'stderr',
                data: `${line.slice(STDERR_PREFIX.length)}\n`,
                timestamp: new Date().toISOString()
              };
            }
          }
        }
      }

      // Clean up labelers done file
      try {
        await rm(labelersDoneFile, { force: true });
      } catch {
        // Ignore cleanup errors
      }

      // Parse exit code (already read during polling loop)
      const exitCode = parseInt(exitCodeContent, 10);
      if (Number.isNaN(exitCode)) {
        throw new Error(`Invalid exit code in file: "${exitCodeContent}"`);
      }

      const duration = Date.now() - startTime;

      this.logger.info('Streaming command execution completed', {
        sessionId: this.id,
        commandId,
        operation: 'execStream',
        exitCode,
        duration
      });

      yield {
        type: 'complete',
        exitCode,
        timestamp: new Date().toISOString(),
        result: {
          stdout: '', // Already streamed
          stderr: '', // Already streamed
          exitCode,
          success: exitCode === 0,
          command,
          duration,
          timestamp: new Date(startTime).toISOString()
        }
      };

      // Untrack command
      this.untrackCommand(commandId);

      // Clean up temp files
      await this.cleanupCommandFiles(logFile, exitCodeFile);
    } catch (error) {
      this.logger.error(
        'Streaming command execution failed',
        error instanceof Error ? error : new Error(String(error)),
        {
          sessionId: this.id,
          commandId,
          operation: 'execStream'
        }
      );
      // Untrack and clean up on error
      this.untrackCommand(commandId);
      await this.cleanupCommandFiles(logFile, exitCodeFile);

      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Check if the session is ready to execute commands
   */
  isReady(): boolean {
    return this.ready && this.shell !== null && !this.shell.killed;
  }

  /**
   * Kill a running command by its ID
   *
   * NOTE: Only works for BACKGROUND commands started via execStream()/startProcess().
   * Foreground commands from exec() run synchronously and complete before returning,
   * so they cannot be killed mid-execution (use timeout instead).
   *
   * @param commandId - The unique command identifier
   * @returns true if command was killed, false if not found or already completed
   */
  async killCommand(commandId: string): Promise<boolean> {
    const handle = this.runningCommands.get(commandId);
    if (!handle) {
      return false; // Command not found or already completed
    }

    try {
      // Try reading PID from file (might still exist if command running)
      const pidFile = Bun.file(handle.pidFile);
      const pidFileExists = await pidFile.exists();

      if (pidFileExists) {
        const pidText = await pidFile.text();
        const pid = parseInt(pidText.trim(), 10);

        if (!Number.isNaN(pid)) {
          // Send SIGTERM for graceful termination
          process.kill(pid, 'SIGTERM');

          // Clean up
          this.runningCommands.delete(commandId);
          return true;
        }
      }

      // PID file gone = command already completed
      this.runningCommands.delete(commandId);
      return false;
    } catch (error) {
      // Process already dead or PID invalid
      this.runningCommands.delete(commandId);
      return false;
    }
  }

  /**
   * Get list of running command IDs
   */
  getRunningCommandIds(): string[] {
    return Array.from(this.runningCommands.keys());
  }

  /**
   * Destroy the session and clean up resources
   */
  async destroy(): Promise<void> {
    // Mark as destroying to prevent shell exit monitor from logging errors
    this.isDestroying = true;

    if (this.pty) {
      await this.pty.destroy();
      this.pty = null;
    }

    // Kill all running commands first
    const runningCommandIds = Array.from(this.runningCommands.keys());
    await Promise.all(
      runningCommandIds.map((commandId) => this.killCommand(commandId))
    );

    if (this.shell && !this.shell.killed) {
      // Close stdin to send EOF to bash (standard way to terminate interactive shells)
      if (this.shell.stdin && typeof this.shell.stdin !== 'number') {
        try {
          this.shell.stdin.end();
        } catch {
          // stdin may already be closed
        }
      }

      // Send SIGTERM for graceful termination (triggers trap handlers)
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

    // Clean up session directory (includes pid files, FIFOs, log files)
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
   * Build FIFO-based bash script for command execution
   *
   * This generates a bash script that handles stdout/stderr separation using
   * binary prefixes. The approach differs based on execution mode:
   *
   * BACKGROUND MODE (execStream/startProcess) - Data Flow:
   * -------------------------------------------------------
   *
   *   ┌─────────────┐
   *   │   Command   │ ──stdout──▶ ┌──────────────┐     ┌─────────────┐
   *   │  (subshell) │             │ stdout.pipe  │ ──▶ │ Labeler r1  │ ──┐
   *   │    { }  &   │ ──stderr──▶ ├──────────────┤     ├─────────────┤   │
   *   └─────────────┘             │ stderr.pipe  │ ──▶ │ Labeler r2  │ ──┼──▶ log file
   *         │                     └──────────────┘     └─────────────┘   │
   *         │ $?                        FIFOs         (prefix \x01/\x02) │
   *         ▼                                                            │
   *   exit_code.tmp ──mv──▶ exit_code                                    │
   *                                                                      │
   *   Monitor ( ) & : waits for r1,r2 to finish, removes FIFOs ──────────┘
   *
   *   Key: Command runs async, shell returns immediately.
   *        PID captured via $! after backgrounding the subshell.
   *
   * FOREGROUND MODE (exec) - Data Flow:
   * ------------------------------------
   *
   *   ┌─────────────┐
   *   │   Command   │ ──stdout──▶ log.stdout (temp file)
   *   │   { }       │ ──stderr──▶ log.stderr (temp file)
   *   └─────────────┘
   *         │ $?
   *         ▼
   *   Then: Read temp files, prefix each line, append to log file
   *   Then: Write exit code (atomic)
   *   Then: Shell continues (state changes like cd/export persist!)
   *
   *   Key: Command runs synchronously in main shell.
   *        State persists because { } runs in current shell, not ( ).
   *
   * @param isBackground - If true, command runs in background (for execStream/startProcess)
   *                       If false, command runs in foreground (for exec) - state persists!
   * @param pidPipe - Optional path to PID notification FIFO (for reliable PID synchronization)
   */
  private buildFIFOScript(
    command: string,
    cmdId: string,
    logFile: string,
    exitCodeFile: string,
    cwd?: string,
    isBackground = false,
    env?: Record<string, string | undefined>,
    pidPipe?: string
  ): string {
    // Create unique FIFO names to prevent collisions
    const stdoutPipe = join(this.sessionDir!, `${cmdId}.stdout.pipe`);
    const stderrPipe = join(this.sessionDir!, `${cmdId}.stderr.pipe`);
    const pidFile = join(this.sessionDir!, `${cmdId}.pid`);
    const labelersDoneFile = join(this.sessionDir!, `${cmdId}.labelers.done`);

    // Escape paths for safe shell usage
    const safeStdoutPipe = this.escapeShellPath(stdoutPipe);
    const safeStderrPipe = this.escapeShellPath(stderrPipe);
    const safeLogFile = this.escapeShellPath(logFile);
    const safeExitCodeFile = this.escapeShellPath(exitCodeFile);
    const safeSessionDir = this.escapeShellPath(this.sessionDir!);
    const safePidFile = this.escapeShellPath(pidFile);
    const safeLabelersDoneFile = this.escapeShellPath(labelersDoneFile);
    const safePidPipe = pidPipe ? this.escapeShellPath(pidPipe) : null;

    const indentLines = (input: string, spaces: number) => {
      const prefix = ' '.repeat(spaces);
      return input
        .split('\n')
        .map((line) => (line.length > 0 ? `${prefix}${line}` : ''))
        .join('\n');
    };

    const { setup: envSetupBlock, cleanup: envCleanupBlock } =
      this.buildScopedEnvBlocks(env, cmdId, { restore: !isBackground });

    const hasScopedEnv = envSetupBlock.length > 0;

    const buildCommandBlock = (exitVar: string, indent: number): string => {
      const lines: string[] = [];
      if (hasScopedEnv) {
        lines.push(envSetupBlock);
      }
      lines.push(`  ${command}`);
      lines.push(`  ${exitVar}=$?`);
      if (envCleanupBlock) {
        lines.push(envCleanupBlock);
      }
      return indentLines(lines.join('\n'), indent);
    };

    // Build the FIFO script
    // For background: monitor handles cleanup (no trap needed)
    // For foreground: trap handles cleanup (standard pattern)
    let script = `{
  log=${safeLogFile}
  dir=${safeSessionDir}
  sp=${safeStdoutPipe}
  ep=${safeStderrPipe}

`;

    // Setup trap only for foreground pattern
    if (!isBackground) {
      script += `  # Cleanup function (foreground only): remove FIFOs if they exist\n`;
      script += `  cleanup() {\n`;
      script += `    rm -f "$sp" "$ep"\n`;
      script += `  }\n`;
      script += `  trap 'cleanup' EXIT HUP INT TERM\n`;
      script += `  \n`;
    }

    // Execute command based on execution mode (foreground vs background)
    if (isBackground) {
      // BACKGROUND PATTERN (for execStream/startProcess)
      // Command runs in subshell, shell continues immediately

      // Create FIFOs and start labelers (background mode)
      // Labeler pattern explanation:
      //   (while IFS= read -r line || [[ -n "$line" ]]; do printf '\x01..%s\n' "$line"; done < FIFO) >> log & r1=$!
      //   │     │                    │                        │                          │      │    │
      //   │     │                    │                        │                          │      │    └─ Capture labeler PID
      //   │     │                    │                        │                          │      └─ Run in background
      //   │     │                    │                        │                          └─ Read from FIFO (blocks until data)
      //   │     │                    │                        └─ Prepend binary prefix to line
      //   │     │                    └─ Handle final line without newline (read returns false but $line has data)
      //   │     └─ Read line preserving whitespace (IFS=) and backslashes (-r)
      //   └─ Run in subshell so it can be backgrounded
      script += `  # Pre-cleanup and create FIFOs with error handling\n`;
      script += `  rm -f "$sp" "$ep" && mkfifo "$sp" "$ep" || exit 1\n`;
      script += `  \n`;
      script += `  # Labeler r1: reads stdout FIFO, prefixes with \\x01\\x01\\x01, appends to log\n`;
      script += `  (while IFS= read -r line || [[ -n "$line" ]]; do printf '\\x01\\x01\\x01%s\\n' "$line"; done < "$sp") >> "$log" & r1=$!\n`;
      script += `  \n`;
      script += `  # Labeler r2: reads stderr FIFO, prefixes with \\x02\\x02\\x02, appends to log\n`;
      script += `  (while IFS= read -r line || [[ -n "$line" ]]; do printf '\\x02\\x02\\x02%s\\n' "$line"; done < "$ep") >> "$log" & r2=$!\n`;
      script += `  # Labelers exit when FIFO writers close (EOF). The command subshell is the\n`;
      script += `  # only writer; when it exits, labelers get EOF, finish, and monitor cleans up.\n`;
      script += `  \n`;
      if (cwd) {
        const safeCwd = this.escapeShellPath(cwd);
        script += `  PREV_DIR=$(pwd)\n`;
        script += `  if cd ${safeCwd}; then\n`;
        script += `    {\n`;
        script += `${buildCommandBlock('CMD_EXIT', 6)}\n`;
        script += `      echo "$CMD_EXIT" > ${safeExitCodeFile}.tmp\n`;
        script += `      mv ${safeExitCodeFile}.tmp ${safeExitCodeFile}\n`;
        script += `    } < /dev/null > "$sp" 2> "$ep" & CMD_PID=$!\n`;
        script += `    echo "$CMD_PID" > ${safePidFile}.tmp\n`;
        script += `    mv ${safePidFile}.tmp ${safePidFile}\n`;
        if (safePidPipe) {
          script += `    # Notify PID via FIFO (unblocks waitForPidViaPipe)\n`;
          script += `    echo "$CMD_PID" > ${safePidPipe}\n`;
        }
        script += `    # Background monitor: waits for labelers to finish, then cleans up FIFOs\n`;
        script += `    (\n`;
        script += `      wait "$r1" "$r2" 2>/dev/null\n`;
        script += `      rm -f "$sp" "$ep"\n`;
        script += `      touch ${safeLabelersDoneFile}\n`;
        script += `    ) &\n`;
        script += `    # Restore directory immediately\n`;
        script += `    cd "$PREV_DIR"\n`;
        script += `  else\n`;
        script += `    printf '\\x02\\x02\\x02%s\\n' "Failed to change directory to ${safeCwd}" >> "$log"\n`;
        script += `    EXIT_CODE=1\n`;
        if (safePidPipe) {
          script += `    # Notify error via FIFO (unblocks waitForPidViaPipe with empty/error)\n`;
          script += `    echo "" > ${safePidPipe}\n`;
        }
        script += `  fi\n`;
      } else {
        script += `  {\n`;
        script += `${buildCommandBlock('CMD_EXIT', 4)}\n`;
        script += `    echo "$CMD_EXIT" > ${safeExitCodeFile}.tmp\n`;
        script += `    mv ${safeExitCodeFile}.tmp ${safeExitCodeFile}\n`;
        script += `  } < /dev/null > "$sp" 2> "$ep" & CMD_PID=$!\n`;
        script += `  echo "$CMD_PID" > ${safePidFile}.tmp\n`;
        script += `  mv ${safePidFile}.tmp ${safePidFile}\n`;
        if (safePidPipe) {
          script += `  # Notify PID via FIFO (unblocks waitForPidViaPipe)\n`;
          script += `  echo "$CMD_PID" > ${safePidPipe}\n`;
        }
        script += `  # Background monitor: waits for labelers to finish, then cleans up FIFOs\n`;
        script += `  (\n`;
        script += `    wait "$r1" "$r2" 2>/dev/null\n`;
        script += `    rm -f "$sp" "$ep"\n`;
        script += `    touch ${safeLabelersDoneFile}\n`;
        script += `  ) &\n`;
      }
    } else {
      // FOREGROUND PATTERN (for exec)
      // Command runs in main shell, state persists!

      // FOREGROUND: Write stdout/stderr to temp files, then prefix and merge.
      // This ensures bash waits for all writes to complete before continuing,
      // avoiding race conditions when reading the log file.

      if (cwd) {
        const safeCwd = this.escapeShellPath(cwd);
        script += `  # Save and change directory\n`;
        script += `  PREV_DIR=$(pwd)\n`;
        script += `  if cd ${safeCwd}; then\n`;
        script += `    # Execute command, redirect to temp files\n`;
        script += `    {\n`;
        script += `${buildCommandBlock('EXIT_CODE', 6)}\n`;
        script += `    } < /dev/null > "$log.stdout" 2> "$log.stderr"\n`;
        script += `    # Restore directory\n`;
        script += `    cd "$PREV_DIR"\n`;
        script += `  else\n`;
        script += `    printf '\\x02\\x02\\x02%s\\n' "Failed to change directory to ${safeCwd}" >> "$log"\n`;
        script += `    EXIT_CODE=1\n`;
        script += `  fi\n`;
      } else {
        script += `  # Execute command, redirect to temp files\n`;
        script += `  {\n`;
        script += `${buildCommandBlock('EXIT_CODE', 4)}\n`;
        script += `  } < /dev/null > "$log.stdout" 2> "$log.stderr"\n`;
      }

      script += `  \n`;
      script += `  # Prefix and merge stdout/stderr into main log\n`;
      script += `  (while IFS= read -r line || [[ -n "$line" ]]; do printf '\\x01\\x01\\x01%s\\n' "$line"; done < "$log.stdout" >> "$log") 2>/dev/null\n`;
      script += `  (while IFS= read -r line || [[ -n "$line" ]]; do printf '\\x02\\x02\\x02%s\\n' "$line"; done < "$log.stderr" >> "$log") 2>/dev/null\n`;
      script += `  rm -f "$log.stdout" "$log.stderr"\n`;
      script += `  \n`;
      script += `  # Write exit code\n`;
      script += `  echo "$EXIT_CODE" > ${safeExitCodeFile}.tmp\n`;
      script += `  mv ${safeExitCodeFile}.tmp ${safeExitCodeFile}\n`;
    }

    // Cleanup (only for foreground - background monitor handles it)
    if (!isBackground) {
      script += `  \n`;
      script += `  # Explicit cleanup (redundant with trap, but ensures cleanup)\n`;
      script += `  cleanup\n`;
    }

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
  private async waitForExitCode(exitCodeFile: string): Promise<number> {
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
      if (this.commandTimeoutMs !== undefined) {
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            watcher.close();
            clearInterval(pollInterval);
            reject(
              new Error(`Command timeout after ${this.commandTimeoutMs}ms`)
            );
          }
        }, this.commandTimeoutMs);
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
    // Derive related files from log file
    const pidFile = logFile.replace('.log', '.pid');
    const pidPipe = logFile.replace('.log', '.pid.pipe');

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

    try {
      await rm(pidFile, { force: true });
    } catch {
      // Ignore errors
    }

    try {
      await rm(pidPipe, { force: true });
    } catch {
      // Ignore errors
    }
  }

  /**
   * Wait for PID file to be created and return the PID
   * Returns undefined if file doesn't appear within timeout
   */
  private async waitForPidFile(
    pidFile: string,
    timeoutMs: number = 1000
  ): Promise<number | undefined> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const file = Bun.file(pidFile);
        if (await file.exists()) {
          const content = await file.text();
          const pid = parseInt(content.trim(), 10);
          if (!Number.isNaN(pid)) {
            return pid;
          }
        }
      } catch {
        // Ignore errors, keep polling
      }
      await Bun.sleep(10); // Poll every 10ms
    }

    return undefined;
  }

  /**
   * Create a FIFO (named pipe) for PID notification
   * This must be created BEFORE sending the command to the shell
   */
  private async createPidPipe(pidPipe: string): Promise<void> {
    // Remove any existing pipe first
    try {
      await rm(pidPipe, { force: true });
    } catch {
      // Ignore errors
    }

    // Create the FIFO using mkfifo command
    const result = Bun.spawnSync(['mkfifo', pidPipe]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create PID pipe: ${result.stderr.toString()}`);
    }
  }

  /**
   * Wait for PID via FIFO with fallback to file polling
   *
   * Fallback chain:
   *   1. FIFO read (primary)  → Blocking read guarantees shell has written PID
   *   2. Timeout + unblock    → If FIFO hangs, unblock it to prevent fd leak
   *   3. File polling (fallback) → Less reliable but works if FIFO fails
   *
   * Why FIFO over file polling?
   * File polling has race conditions - file might not exist yet or be partially
   * written. FIFO read blocks until shell writes, guaranteeing complete PID.
   *
   * @param pidPipe - Path to the PID notification FIFO
   * @param pidFile - Path to the PID file (fallback)
   * @param timeoutMs - Timeout for waiting
   * @returns The PID or undefined if not available within timeout
   */
  private async waitForPidViaPipe(
    pidPipe: string,
    pidFile: string,
    timeoutMs: number = 5000
  ): Promise<number | undefined> {
    const TIMEOUT_SENTINEL = Symbol('timeout');

    try {
      // Read from FIFO with timeout
      // Opening a FIFO for reading blocks until a writer opens it
      const result = await Promise.race([
        this.readPidFromPipe(pidPipe),
        Bun.sleep(timeoutMs).then(() => TIMEOUT_SENTINEL)
      ]);

      if (typeof result === 'number') {
        return result;
      }

      if (result === TIMEOUT_SENTINEL) {
        // The timed-out readPidFromPipe() is still blocked on open() - unblock it
        // to prevent leaking a file descriptor
        await this.unblockPidPipe(pidPipe);

        this.logger.warn(
          'PID pipe read timed out, falling back to file polling',
          {
            pidPipe,
            pidFile,
            timeoutMs
          }
        );
      } else {
        // readPidFromPipe returned undefined (empty or invalid content from shell)
        this.logger.warn(
          'PID pipe returned invalid content, falling back to file polling',
          {
            pidPipe,
            pidFile
          }
        );
      }
    } catch (error) {
      // FIFO read failed, fall back to file polling
      this.logger.warn('PID pipe read failed, falling back to file polling', {
        pidPipe,
        pidFile,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      // Clean up the pipe
      try {
        await rm(pidPipe, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    // Fallback: poll the PID file (less reliable but works)
    return this.waitForPidFile(pidFile, 1000);
  }

  /**
   * Read PID from a FIFO (named pipe)
   * This blocks until the shell writes the PID
   *
   * Uses Node.js fs.open which properly handles FIFOs - the open() call
   * blocks until a writer opens the pipe, then we read the content.
   */
  private async readPidFromPipe(pidPipe: string): Promise<number | undefined> {
    // Open the FIFO for reading - this blocks until a writer opens it
    const fd = await open(pidPipe, 'r');
    try {
      // Read content from the FIFO
      const buffer = Buffer.alloc(64);
      const { bytesRead } = await fd.read(buffer, 0, 64, null);
      const content = buffer.toString('utf8', 0, bytesRead).trim();
      const pid = parseInt(content, 10);
      return Number.isNaN(pid) ? undefined : pid;
    } finally {
      await fd.close();
    }
  }

  /**
   * Unblock a FIFO reader by opening the pipe for writing
   *
   * Opening a FIFO for reading blocks until a writer opens it. Writing to
   * the FIFO unblocks the reader, allowing it to complete.
   */
  private async unblockPidPipe(pidPipe: string): Promise<void> {
    try {
      const fd = await open(pidPipe, 'w');
      await fd.write('\n');
      await fd.close();
    } catch {
      // Ignore errors - FIFO might already have a writer, be closed, or be deleted
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

  /**
   * Track a command when it starts
   */
  private trackCommand(
    commandId: string,
    pidFile: string,
    logFile: string,
    exitCodeFile: string
  ): void {
    const handle: CommandHandle = {
      commandId,
      pidFile,
      logFile,
      exitCodeFile
    };
    this.runningCommands.set(commandId, handle);
  }

  /**
   * Untrack a command when it completes
   */
  private untrackCommand(commandId: string): void {
    this.runningCommands.delete(commandId);
  }
}
