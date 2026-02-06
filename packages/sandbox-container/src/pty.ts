import type { Disposable, Logger, PtyOptions } from '@repo/shared';
import type { Subprocess } from 'bun';
import { ByteRingBuffer } from './utils/ring-buffer';

const DEFAULT_BUFFER_SIZE = 256 * 1024;

export class Pty {
  private terminal: InstanceType<typeof Bun.Terminal> | null = null;
  private process: Subprocess | null = null;
  private dataListeners = new Set<(data: Uint8Array) => void>();
  private _closed = false;
  private outputBuffer: ByteRingBuffer;

  private readonly cwd: string;
  private readonly env: Record<string, string | undefined>;
  private readonly logger: Logger;

  constructor(options: {
    cwd: string;
    env?: Record<string, string | undefined>;
    logger: Logger;
    bufferSize?: number;
  }) {
    this.cwd = options.cwd;
    this.env = options.env ?? {};
    this.logger = options.logger;
    this.outputBuffer = new ByteRingBuffer(
      options.bufferSize ?? DEFAULT_BUFFER_SIZE
    );
  }

  async initialize(options: PtyOptions = {}): Promise<void> {
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;

    this.terminal = new Bun.Terminal({
      cols,
      rows,
      name: 'xterm-256color',
      data: (_term, data: Uint8Array) => this.emitData(data),
      exit: (_term, exitCode, signal) => {
        this._closed = true;
        this.logger.info('PTY terminal exited', { exitCode, signal });
      }
    });

    this.process = Bun.spawn(['bash'], {
      terminal: this.terminal,
      cwd: this.cwd,
      env: {
        ...process.env,
        ...this.env,
        TERM: 'xterm-256color',
        PROMPT_COMMAND: 'clear; unset PROMPT_COMMAND'
      }
    });

    this.process.exited.then((exitCode) => {
      this._closed = true;
      this.logger.info('PTY process exited', { exitCode });
    });
  }

  onData(callback: (data: Uint8Array) => void): Disposable {
    this.dataListeners.add(callback);
    return {
      dispose: () => this.dataListeners.delete(callback)
    };
  }

  write(data: string | Uint8Array): void {
    if (this._closed || !this.terminal) {
      throw new Error('PTY is closed');
    }
    this.terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this._closed || !this.terminal) {
      throw new Error('PTY is closed');
    }
    this.terminal.resize(cols, rows);
  }

  getBufferedOutput(): Uint8Array {
    return this.outputBuffer.readAll();
  }

  get closed(): boolean {
    return this._closed;
  }

  async destroy(): Promise<void> {
    this._closed = true;

    if (this.terminal && !this.terminal.closed) {
      this.terminal.close();
    }

    if (this.process && !this.process.killed) {
      this.process.kill();
      await this.process.exited.catch(() => {});
    }

    this.dataListeners.clear();
    this.outputBuffer.clear();
    this.terminal = null;
    this.process = null;
  }

  private emitData(data: Uint8Array): void {
    this.outputBuffer.write(data);

    for (const listener of this.dataListeners) {
      try {
        listener(data);
      } catch (err) {
        this.logger.error('PTY data listener error', err as Error);
      }
    }
  }
}
