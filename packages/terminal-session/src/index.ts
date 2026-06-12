// biome-ignore-all lint/style/useTemplate: Bash parameter expansion strings are assembled from pieces because this file generates bash source.
import { Buffer } from 'node:buffer';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CONTROL_FD = 3;
const COMMAND_FD = 4;
const RECORD_SEPARATOR = '\x1e';
const FRAME_PREFIX = 'TERMINAL_SESSION';
const BASH_EXPANSION_START = '$' + '{';

const RC_FILE_CONTENT = [
  'set +H',
  'unset HISTFILE',
  'export HISTFILE=/dev/null',
  "export PS1='terminal-session$ '",
  '',
  "__terminal_session_rs=$'\\x1e'",
  '__terminal_session_nonce="' +
    BASH_EXPANSION_START +
    'TERMINAL_SESSION_NONCE}"',
  '__terminal_session_ctrl_fd=' +
    BASH_EXPANSION_START +
    'TERMINAL_SESSION_CTRL_FD:-3}',
  '__terminal_session_cmd_fd=' +
    BASH_EXPANSION_START +
    'TERMINAL_SESSION_CMD_FD:-4}',
  'if [[ -n "' +
    BASH_EXPANSION_START +
    'TERMINAL_SESSION_CMD_FIFO:-}" ]]; then',
  '  exec 4<>"$TERMINAL_SESSION_CMD_FIFO"',
  'fi',
  '',
  '__terminal_session_frame() {',
  '  printf \'%sTERMINAL_SESSION|%s|%s|%s|%s%s\\n\' "$__terminal_session_rs" "$__terminal_session_nonce" "$1" "$2" "$3" "$__terminal_session_rs" >&$__terminal_session_ctrl_fd',
  '}',
  '',
  '__terminal_session_ready() { __terminal_session_frame READY "" ""; }',
  '__terminal_session_exec_start() { __terminal_session_frame EXEC_START "$1" ""; }',
  '__terminal_session_exec_done() { __terminal_session_frame EXEC_DONE "$1" "$2"; }',
  '',
  '__terminal_session_poll_exec() {',
  '  local line exec_id cmd_b64 cmd exit_code',
  '  local did_exec=0',
  '  while IFS= read -r -t 0.05 -u $__terminal_session_cmd_fd line 2>/dev/null; do',
  '    exec_id="' + BASH_EXPANSION_START + 'line%%|*}"',
  '    cmd_b64="' + BASH_EXPANSION_START + 'line#*|}"',
  '    cmd=$(echo "$cmd_b64" | base64 -d 2>/dev/null) || continue',
  '',
  '    printf \'%s\\n\' "$cmd"',
  '    __terminal_session_exec_start "$exec_id"',
  '    eval "$cmd"',
  '    exit_code=$?',
  '    __terminal_session_exec_done "$exec_id" "$exit_code"',
  '    did_exec=1',
  '  done',
  '  [[ "$did_exec" == "1" ]]',
  '}',
  '',
  '__terminal_session_polling=0',
  '__terminal_session_poll_prompt() {',
  '  local saved_status=$?',
  '  if [[ "$__terminal_session_polling" == "1" ]]; then return $saved_status; fi',
  '  __terminal_session_polling=1',
  '  __terminal_session_poll_exec',
  '  __terminal_session_polling=0',
  '  return $saved_status',
  '}',
  '',
  '__terminal_session_poll_signal() {',
  '  local saved_status=$?',
  '  if [[ "$__terminal_session_polling" == "1" ]]; then return $saved_status; fi',
  '  __terminal_session_polling=1',
  '  if __terminal_session_poll_exec; then',
  "    printf '%s' \"" + BASH_EXPANSION_START + 'PS1@P}"',
  '  fi',
  '  __terminal_session_polling=0',
  '  return $saved_status',
  '}',
  '',
  "trap '__terminal_session_poll_signal' WINCH",
  'PROMPT_COMMAND="__terminal_session_poll_prompt"',
  '',
  '__terminal_session_ready',
  ''
].join('\n');

export type ExecResult = {
  exitCode: number;
  transcript: string;
};

type PendingExec = {
  id: string;
  transcriptStart: number;
  resolve: (result: ExecResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type ParsedFrame = {
  type: string;
  id: string;
  payload: string;
};

class Deferred<T> {
  promise: Promise<T>;
  private resolveFn?: (value: T) => void;
  private rejectFn?: (error: Error) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  resolve(value: T): void {
    this.resolveFn?.(value);
  }

  reject(error: Error): void {
    this.rejectFn?.(error);
  }
}

export class TerminalSession implements AsyncDisposable {
  private readonly terminal: Bun.Terminal;
  private readonly shell: Bun.Subprocess;
  private readonly rcPath: string;
  private readonly commandFifoPath: string;
  private readonly nonce: string;
  private readonly controlFd: number;
  private commandWriter?: ReturnType<typeof Bun.file.prototype.writer>;
  private readonly decoder = new TextDecoder();
  private readonly ready = new Deferred<void>();
  private transcript = '';
  private controlBuffer = '';
  private pendingExec?: PendingExec;
  private failure?: Error;
  private operationQueue: Promise<ExecResult> = Promise.resolve({
    exitCode: 0,
    transcript: ''
  });
  private closed = false;

  private constructor(options: {
    terminal: Bun.Terminal;
    shell: Bun.Subprocess;
    rcPath: string;
    commandFifoPath: string;
    nonce: string;
    controlFd: number;
  }) {
    this.terminal = options.terminal;
    this.shell = options.shell;
    this.rcPath = options.rcPath;
    this.commandFifoPath = options.commandFifoPath;
    this.nonce = options.nonce;
    this.controlFd = options.controlFd;
    this.ready.promise.catch(() => {});
    void this.readControlFrames();
    this.shell.exited.then((exitCode) => {
      if (!this.closed) {
        this.fail(
          new Error(
            `Terminal session shell exited with code ${exitCode}. Transcript: ${JSON.stringify(this.transcript)}`
          )
        );
      }
    });
  }

  static async create(
    options: { cwd?: string; env?: Record<string, string> } = {}
  ): Promise<TerminalSession> {
    const nonce = crypto.randomUUID().replaceAll('-', '');
    const rcPath = join('/tmp', `terminal-session-${nonce}.bashrc`);
    const commandFifoPath = join('/tmp', `terminal-session-${nonce}.commands`);
    let session: TerminalSession | undefined;
    try {
      await writeFile(rcPath, RC_FILE_CONTENT);
      const mkfifo = Bun.spawn(['mkfifo', commandFifoPath]);
      const mkfifoExitCode = await mkfifo.exited;
      if (mkfifoExitCode !== 0) {
        throw new Error(`Failed to create command FIFO at ${commandFifoPath}`);
      }

      const earlyData: Uint8Array[] = [];
      const terminal = new Bun.Terminal({
        cols: 80,
        rows: 24,
        data: (_terminal, data) => {
          const chunk = new Uint8Array(data);
          if (session) {
            session.appendTerminalData(chunk);
          } else {
            earlyData.push(chunk);
          }
        }
      });

      const shell = Bun.spawn(
        ['bash', '--noprofile', '--rcfile', rcPath, '-i'],
        {
          terminal,
          cwd: options.cwd,
          env: {
            ...process.env,
            ...options.env,
            TERM: 'xterm-256color',
            HISTFILE: '',
            TERMINAL_SESSION_NONCE: nonce,
            TERMINAL_SESSION_CTRL_FD: String(CONTROL_FD),
            TERMINAL_SESSION_CMD_FD: String(COMMAND_FD),
            TERMINAL_SESSION_CMD_FIFO: commandFifoPath
          },
          stdio: [undefined, undefined, undefined, 'pipe']
        }
      );

      const controlFd = shell.stdio[CONTROL_FD] as number;
      session = new TerminalSession({
        terminal,
        shell,
        rcPath,
        commandFifoPath,
        nonce,
        controlFd
      });

      for (const chunk of earlyData) {
        session.appendTerminalData(chunk);
      }

      await session.waitForReady();
      return session;
    } catch (error) {
      if (session) {
        await session.close();
      } else {
        await rm(rcPath, { force: true });
        await rm(commandFifoPath, { force: true });
      }
      throw error;
    }
  }

  async exec(
    command: string,
    options: { timeoutMs?: number } = {}
  ): Promise<ExecResult> {
    const run = async (): Promise<ExecResult> =>
      this.execNow(command, options.timeoutMs ?? 2_000);
    const result = this.operationQueue.then(run, run);
    this.operationQueue = result.catch(() => ({ exitCode: 1, transcript: '' }));
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.commandWriter) {
      try {
        await this.commandWriter.end();
      } catch {}
    }

    this.fail(new Error('Terminal session is closed'));
    try {
      this.shell.kill('SIGTERM');
    } catch {}
    const exited = await Promise.race([
      this.shell.exited.then(() => true),
      Bun.sleep(500).then(() => false)
    ]);
    if (!exited) {
      try {
        this.shell.kill('SIGKILL');
      } catch {}
      await Promise.race([this.shell.exited, Bun.sleep(500)]);
    }
    await rm(this.rcPath, { force: true });
    await rm(this.commandFifoPath, { force: true });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.ready.reject(error);
    if (this.pendingExec) {
      clearTimeout(this.pendingExec.timeout);
      this.pendingExec.reject(error);
      this.pendingExec = undefined;
    }
  }

  private waitForReady(): Promise<void> {
    return Promise.race([
      this.ready.promise,
      Bun.sleep(2_000).then(() => {
        throw new Error(
          `Timed out waiting for terminal session shell readiness. Transcript: ${JSON.stringify(this.transcript)} Control: ${JSON.stringify(this.controlBuffer)}`
        );
      })
    ]);
  }

  private async execNow(
    command: string,
    timeoutMs: number
  ): Promise<ExecResult> {
    if (this.closed) {
      throw new Error('Terminal session is closed');
    }
    if (this.failure) {
      throw this.failure;
    }
    if (this.pendingExec) {
      throw new Error('Terminal session already has a pending exec');
    }
    const id = crypto.randomUUID().replaceAll('-', '');
    const transcriptStart = this.transcript.length;
    const encodedCommand = Buffer.from(command).toString('base64');

    const result = new Promise<ExecResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingExec = undefined;
        reject(new Error(`Timed out waiting for exec ${id}`));
      }, timeoutMs);
      this.pendingExec = { id, transcriptStart, resolve, reject, timeout };
    });

    const writer = this.ensureCommandWriter();
    writer.write(`${id}|${encodedCommand}\n`);
    await writer.flush();
    try {
      process.kill(this.shell.pid, 'SIGWINCH');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = new Error(`Terminal session wakeup failed: ${message}`);
      this.fail(failure);
      throw failure;
    }

    return result;
  }

  private ensureCommandWriter(): ReturnType<typeof Bun.file.prototype.writer> {
    if (!this.commandWriter) {
      this.commandWriter = Bun.file(this.commandFifoPath).writer();
    }
    return this.commandWriter;
  }

  private appendTerminalData(data: Uint8Array): void {
    this.transcript += this.decoder.decode(data, { stream: true });
  }

  private async readControlFrames(): Promise<void> {
    const reader = Bun.file(this.controlFd).stream().getReader();
    while (!this.closed) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        this.controlBuffer += this.decoder.decode(value, { stream: true });
        this.drainControlFrames();
      } catch (error) {
        if (!this.closed) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.fail(new Error(`Control channel failed: ${message}`));
        }
        return;
      }
    }
  }

  private drainControlFrames(): void {
    while (true) {
      const start = this.controlBuffer.indexOf(RECORD_SEPARATOR);
      if (start < 0) {
        return;
      }
      const end = this.controlBuffer.indexOf(RECORD_SEPARATOR, start + 1);
      if (end < 0) {
        if (start > 0) {
          this.controlBuffer = this.controlBuffer.slice(start);
        }
        return;
      }

      const frameContent = this.controlBuffer.slice(start + 1, end);
      this.controlBuffer = this.controlBuffer.slice(end + 1);
      const frame = this.parseFrame(frameContent);
      if (frame) {
        this.handleFrame(frame);
      }
    }
  }

  private parseFrame(content: string): ParsedFrame | null {
    const [prefix, nonce, type, id, payload] = content.split('|');
    if (prefix !== FRAME_PREFIX || nonce !== this.nonce || !type) {
      return null;
    }
    return { type, id: id ?? '', payload: payload ?? '' };
  }

  private handleFrame(frame: ParsedFrame): void {
    if (frame.type === 'READY') {
      this.ready.resolve();
      return;
    }
    if (frame.type !== 'EXEC_DONE' || !this.pendingExec) {
      return;
    }
    if (frame.id !== this.pendingExec.id) {
      return;
    }

    const pending = this.pendingExec;
    this.pendingExec = undefined;
    clearTimeout(pending.timeout);
    const exitCode = Number.parseInt(frame.payload, 10);
    setTimeout(() => {
      pending.resolve({
        exitCode: Number.isNaN(exitCode) ? 1 : exitCode,
        transcript: this.transcript.slice(pending.transcriptStart)
      });
    }, 20);
  }
}
