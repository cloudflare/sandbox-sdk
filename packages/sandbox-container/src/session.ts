/**
 * Session - Persistent shell execution with reliable stdout/stderr separation
 *
 * Overview
 * - Maintains a persistent bash shell so session state (cwd, env vars, shell
 *   functions) persists across commands.
 * - Separates stdout and stderr by writing binary prefixes to a shared log,
 *   which we later parse to reconstruct the streams.
 *
 * Execution Modes
 * - Foreground (exec): Runs in the main shell (state persists). We avoid FIFOs
 *   here to eliminate cross-process FIFO open/close races on silent commands
 *   (e.g., cd, mkdir). Instead, we use bash process substitution to prefix
 *   stdout/stderr inline and append to the log, then `wait` to ensure those
 *   consumers drain before the exit code file is written.
 * - Background (execStream/startProcess): Uses FIFOs + background labelers.
 *   The command runs in a subshell redirected to FIFOs; labelers read from
 *   FIFOs and prefix lines into the log; we write an exit code file and a
 *   small monitor ensures labelers finish and FIFOs are cleaned up.
 *
 * Exit Detection
 * - We write the exit code to a file and detect completion via a hybrid
 *   fs.watch + polling approach to be robust on tmpfs/overlayfs.
 */

import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ExecEvent, Logger } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import type { Subprocess } from 'bun';
import { CONFIG } from './config';

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

  /** Working directory for the session */
  cwd?: string;

  /** Environment variables for the session */
  env?: Record<string, string>;

  /** Legacy isolation flag (ignored - kept for compatibility) */
  isolation?: boolean;

  /** Command timeout in milliseconds (overrides CONFIG.COMMAND_TIMEOUT_MS) */
  commandTimeoutMs?: number;

  /** Maximum output size in bytes (overrides CONFIG.MAX_OUTPUT_SIZE_BYTES) */
  maxOutputSizeBytes?: number;

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
  /** Environment variables for this command only (does not persist in session) */
  env?: Record<string, string>;
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
  private readonly maxOutputSizeBytes: number;
  private readonly logger: Logger;
  /** Map of running commands for tracking and killing */
  private runningCommands = new Map<string, CommandHandle>();

  constructor(options: SessionOptions) {
    this.id = options.id;
    this.options = options;
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? CONFIG.COMMAND_TIMEOUT_MS;
    this.maxOutputSizeBytes =
      options.maxOutputSizeBytes ?? CONFIG.MAX_OUTPUT_SIZE_BYTES;
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

    // Spawn persistent bash with stdin pipe - no IPC or wrapper needed!
    this.shell = Bun.spawn({
      cmd: ['bash', '--norc'],
      cwd: this.options.cwd || CONFIG.DEFAULT_CWD,
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

    // Set up shell exit monitor - rejects if shell dies unexpectedly
    // This Promise will reject when the shell process exits, allowing us to detect
    // shell death immediately and provide clear error messages to users
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

    this.logger.info('Streaming command execution started', {
      sessionId: this.id,
      commandId,
      operation: 'execStream',
      command: command.substring(0, 100)
    });

    try {
      // Track command
      this.trackCommand(commandId, pidFile, logFile, exitCodeFile);

      // Build FIFO script for BACKGROUND execution
      // Command runs concurrently, shell continues immediately
      const bashScript = this.buildFIFOScript(
        command,
        commandId,
        logFile,
        exitCodeFile,
        options?.cwd,
        true,
        options?.env
      );

      if (this.shell!.stdin && typeof this.shell!.stdin !== 'number') {
        this.shell!.stdin.write(`${bashScript}\n`);
      } else {
        throw new Error('Shell stdin is not available');
      }

      yield {
        type: 'start',
        timestamp: new Date().toISOString(),
        command
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

      // Read final chunks
      const file = Bun.file(logFile);
      if (await file.exists()) {
        const content = await file.text();
        const newContent = content.slice(position);

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
   * This is the core of the FIFO approach:
   * 1. Create two FIFO pipes (stdout.pipe, stderr.pipe)
   * 2. Start background processes that read from pipes and label with binary prefixes
   * 3. Execute command (foreground or background based on isBackground flag)
   * 4. Write exit code to file
   * 5. Wait for background processes and cleanup
   *
   * @param isBackground - If true, command runs in background (for execStream/startProcess)
   *                       If false, command runs in foreground (for exec) - state persists!
   */
  private buildFIFOScript(
    command: string,
    cmdId: string,
    logFile: string,
    exitCodeFile: string,
    cwd?: string,
    isBackground = false,
    env?: Record<string, string>
  ): string {
    // Create unique FIFO names to prevent collisions
    const stdoutPipe = join(this.sessionDir!, `${cmdId}.stdout.pipe`);
    const stderrPipe = join(this.sessionDir!, `${cmdId}.stderr.pipe`);
    const pidFile = join(this.sessionDir!, `${cmdId}.pid`);

    // Escape paths for safe shell usage
    const safeStdoutPipe = this.escapeShellPath(stdoutPipe);
    const safeStderrPipe = this.escapeShellPath(stderrPipe);
    const safeLogFile = this.escapeShellPath(logFile);
    const safeExitCodeFile = this.escapeShellPath(exitCodeFile);
    const safeSessionDir = this.escapeShellPath(this.sessionDir!);
    const safePidFile = this.escapeShellPath(pidFile);

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
      script += `  # Pre-cleanup and create FIFOs with error handling\n`;
      script += `  rm -f "$sp" "$ep" && mkfifo "$sp" "$ep" || exit 1\n`;
      script += `  \n`;
      script += `  # Label stdout with binary prefix in background (capture PID)\n`;
      script += `  (while IFS= read -r line || [[ -n "$line" ]]; do printf '\\x01\\x01\\x01%s\\n' "$line"; done < "$sp") >> "$log" & r1=$!\n`;
      script += `  \n`;
      script += `  # Label stderr with binary prefix in background (capture PID)\n`;
      script += `  (while IFS= read -r line || [[ -n "$line" ]]; do printf '\\x02\\x02\\x02%s\\n' "$line"; done < "$ep") >> "$log" & r2=$!\n`;
      script += `  # EOF note: labelers stop when all writers to the FIFOs close.\n`;
      script += `  # The subshell writing to >"$sp" 2>"$ep" controls EOF; after it exits,\n`;
      script += `  # we wait for labelers and then remove the FIFOs.\n`;
      script += `  \n`;
      if (cwd) {
        const safeCwd = this.escapeShellPath(cwd);
        script += `  # Save and change directory\n`;
        script += `  PREV_DIR=$(pwd)\n`;
        script += `  if cd ${safeCwd}; then\n`;
        script += `    # Execute command in BACKGROUND (runs in subshell, enables concurrency)\n`;
        script += `    {\n`;
        script += `${buildCommandBlock('CMD_EXIT', 6)}\n`;
        script += `      # Write exit code\n`;
        script += `      echo "$CMD_EXIT" > ${safeExitCodeFile}.tmp\n`;
        script += `      mv ${safeExitCodeFile}.tmp ${safeExitCodeFile}\n`;
        script += `    } < /dev/null > "$sp" 2> "$ep" & CMD_PID=$!\n`;
        script += `    # Write PID for process killing\n`;
        script += `    echo "$CMD_PID" > ${safePidFile}.tmp\n`;
        script += `    mv ${safePidFile}.tmp ${safePidFile}\n`;
        script += `    # Background monitor: waits for labelers to finish (after FIFO EOF)\n`;
        script += `    # and then removes the FIFOs. PID file is cleaned up by TypeScript.\n`;
        script += `    (\n`;
        script += `      wait "$r1" "$r2" 2>/dev/null\n`;
        script += `      rm -f "$sp" "$ep"\n`;
        script += `    ) &\n`;
        script += `    # Restore directory immediately\n`;
        script += `    cd "$PREV_DIR"\n`;
        script += `  else\n`;
        script += `    printf '\\x02\\x02\\x02%s\\n' "Failed to change directory to ${safeCwd}" >> "$log"\n`;
        script += `    EXIT_CODE=1\n`;
        script += `  fi\n`;
      } else {
        script += `  # Execute command in BACKGROUND (runs in subshell, enables concurrency)\n`;
        script += `  {\n`;
        script += `${buildCommandBlock('CMD_EXIT', 4)}\n`;
        script += `    # Write exit code\n`;
        script += `    echo "$CMD_EXIT" > ${safeExitCodeFile}.tmp\n`;
        script += `    mv ${safeExitCodeFile}.tmp ${safeExitCodeFile}\n`;
        script += `  } < /dev/null > "$sp" 2> "$ep" & CMD_PID=$!\n`;
        script += `  # Write PID for process killing\n`;
        script += `  echo "$CMD_PID" > ${safePidFile}.tmp\n`;
        script += `  mv ${safePidFile}.tmp ${safePidFile}\n`;
        script += `  # Background monitor: waits for labelers to finish (after FIFO EOF)\n`;
        script += `  # and then removes the FIFOs. PID file is cleaned up by TypeScript.\n`;
        script += `  (\n`;
        script += `    wait "$r1" "$r2" 2>/dev/null\n`;
        script += `    rm -f "$sp" "$ep"\n`;
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
    env: Record<string, string> | undefined,
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

    Object.entries(env).forEach(([key, value], index) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid environment variable name: ${key}`);
      }

      const escapedValue = value.replace(/'/g, "'\\''");

      if (options.restore) {
        const stateSuffix = `${cmdSuffix}_${index}`;
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
    });

    return {
      setup: setupLines.join('\n'),
      cleanup: options.restore ? cleanupLines.join('\n') : ''
    };
  }

  /**
   * Wait for exit code file to appear using hybrid fs.watch + polling
   *
   * Uses fs.watch for fast detection, with polling fallback for systems where
   * fs.watch doesn't reliably detect rename() operations (common on tmpfs, overlayfs).
   */
  private async waitForExitCode(exitCodeFile: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const dir = dirname(exitCodeFile);
      const filename = basename(exitCodeFile);
      let resolved = false;

      // STEP 1: Set up fs.watch for fast detection
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

    // Safety check: prevent OOM attacks
    if (file.size > this.maxOutputSizeBytes) {
      throw new Error(
        `Output too large: ${file.size} bytes (max: ${this.maxOutputSizeBytes})`
      );
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
    // Derive PID file from log file
    const pidFile = logFile.replace('.log', '.pid');

    try {
      await rm(logFile, { force: true });
    } catch (error) {
      // Ignore errors
    }

    try {
      await rm(exitCodeFile, { force: true });
    } catch (error) {
      // Ignore errors
    }

    try {
      await rm(pidFile, { force: true });
    } catch (error) {
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
