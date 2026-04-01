import type {
  DesktopProcessHealth,
  DesktopStartRequest,
  Logger
} from '@repo/shared';

interface DesktopProcess {
  name: string;
  command: string;
  args: string[];
  priority: number;
  proc: import('bun').Subprocess | null;
  pid: number | undefined;
  startTime: Date | null;
}

const DEFAULT_RESOLUTION: [number, number] = [1024, 768];
const DEFAULT_DPI = 96;
const READINESS_TIMEOUT_MS = 15000;
const READINESS_POLL_INTERVAL_MS = 200;
const PROCESS_KILL_TIMEOUT_MS = 5000;

export class DesktopManager {
  private processes = new Map<string, DesktopProcess>();
  private state: 'inactive' | 'starting' | 'active' | 'stopping' = 'inactive';
  private resolution: [number, number] = DEFAULT_RESOLUTION;
  private dpi: number = DEFAULT_DPI;

  constructor(private logger: Logger) {}

  async start(options?: DesktopStartRequest): Promise<void> {
    if (this.state === 'active') {
      this.logger.info('Desktop already running, skipping start');
      return;
    }
    if (this.state === 'starting' || this.state === 'stopping') {
      throw new Error(`Desktop is currently ${this.state}`);
    }

    this.state = 'starting';
    this.resolution = options?.resolution ?? DEFAULT_RESOLUTION;
    this.dpi = options?.dpi ?? DEFAULT_DPI;

    const [width, height] = this.resolution;

    try {
      const processDefs: Omit<DesktopProcess, 'proc' | 'pid' | 'startTime'>[] =
        [
          {
            name: 'xvfb',
            command: 'Xvfb',
            args: [
              ':99',
              '-screen',
              '0',
              `${width}x${height}x24`,
              '-dpi',
              String(this.dpi),
              '-ac'
            ],
            priority: 100
          },
          {
            name: 'xfce4',
            command: 'startxfce4',
            args: [],
            priority: 200
          },
          {
            name: 'x11vnc',
            command: 'x11vnc',
            args: [
              '-display',
              ':99',
              '-nopw',
              '-forever',
              '-shared',
              '-rfbport',
              '5900'
            ],
            priority: 300
          },
          {
            name: 'novnc',
            command: 'websockify',
            args: [
              '--web',
              '/usr/share/novnc',
              '0.0.0.0:6080',
              'localhost:5900'
            ],
            priority: 400
          }
        ];

      for (const def of processDefs) {
        const process: DesktopProcess = {
          ...def,
          proc: null,
          pid: undefined,
          startTime: null
        };
        this.processes.set(def.name, process);
        await this.startProcess(process);
      }

      await this.waitForHttp('http://localhost:6080', READINESS_TIMEOUT_MS);

      this.state = 'active';
      this.logger.info('Desktop environment started', {
        resolution: this.resolution,
        dpi: this.dpi
      });
    } catch (error) {
      this.logger.error(
        'Desktop start failed, stopping all processes',
        error instanceof Error ? error : undefined,
        { error }
      );
      await this.stop().catch((stopErr) => {
        this.logger.warn('Cleanup stop also failed', {
          error: stopErr instanceof Error ? stopErr.message : String(stopErr)
        });
      });
      this.state = 'inactive';
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'inactive') return;
    this.state = 'stopping';

    const sorted = [...this.processes.values()].sort(
      (a, b) => b.priority - a.priority
    );
    for (const process of sorted) {
      await this.killProcess(process);
    }

    this.processes.clear();
    this.state = 'inactive';
    this.logger.info('Desktop environment stopped');
  }

  getStatus(): {
    status: 'active' | 'partial' | 'inactive';
    processes: Record<string, DesktopProcessHealth>;
  } {
    if (this.state === 'inactive' || this.processes.size === 0) {
      return { status: 'inactive', processes: {} };
    }

    const processes: Record<string, DesktopProcessHealth> = {};
    let allRunning = true;
    let anyRunning = false;

    for (const [name, process] of this.processes) {
      const running = process.proc !== null && !process.proc.killed;
      const uptime = process.startTime
        ? Math.floor((Date.now() - process.startTime.getTime()) / 1000)
        : undefined;

      processes[name] = {
        running,
        pid: process.pid,
        uptime
      };

      if (running) anyRunning = true;
      else allRunning = false;
    }

    const status = allRunning ? 'active' : anyRunning ? 'partial' : 'inactive';
    return { status, processes };
  }

  getResolution(): [number, number] | null {
    return this.state === 'active' ? this.resolution : null;
  }

  getDpi(): number | null {
    return this.state === 'active' ? this.dpi : null;
  }

  private async startProcess(process: DesktopProcess): Promise<void> {
    const childLogger = this.logger.child({ process: process.name });
    childLogger.info('Starting desktop process', {
      command: process.command,
      args: process.args
    });

    const env: Record<string, string> = {
      ...(process.name !== 'xvfb' ? { DISPLAY: ':99' } : {})
    };

    const proc = Bun.spawn([process.command, ...process.args], {
      env: { ...Bun.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe'
    });

    process.proc = proc;
    process.pid = proc.pid;
    process.startTime = new Date();

    this.pipeOutput(proc.stdout, childLogger, 'debug');
    this.pipeOutput(proc.stderr, childLogger, 'debug');

    await new Promise((resolve) => setTimeout(resolve, 500));

    if (proc.killed) {
      throw new Error(`Desktop process ${process.name} exited immediately`);
    }

    childLogger.info('Desktop process started', { pid: proc.pid });
  }

  private async pipeOutput(
    stream: ReadableStream<Uint8Array> | null,
    logger: Logger,
    level: 'info' | 'warn' | 'debug'
  ): Promise<void> {
    if (!stream) return;
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value).trim();
        if (text) {
          logger[level](text);
        }
      }
    } catch {}
  }

  private async killProcess(process: DesktopProcess): Promise<void> {
    if (!process.proc || process.proc.killed) return;

    const childLogger = this.logger.child({ process: process.name });
    childLogger.info('Stopping desktop process', { pid: process.pid });

    try {
      process.proc.kill('SIGTERM');

      const exitPromise = process.proc.exited;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Kill timeout')),
          PROCESS_KILL_TIMEOUT_MS
        )
      );

      await Promise.race([exitPromise, timeoutPromise]).catch(() => {
        childLogger.warn('Process did not exit gracefully, sending SIGKILL');
        process.proc?.kill('SIGKILL');
      });
    } catch (error) {
      childLogger.warn('Error killing process', { error });
    }

    process.proc = null;
    process.pid = undefined;
  }

  private async waitForHttp(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    this.logger.info('Waiting for HTTP readiness', { url, timeoutMs });

    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(2000)
        });
        if (response.ok) {
          this.logger.info('HTTP endpoint ready', { url });
          return;
        }
      } catch {}
      await new Promise((resolve) =>
        setTimeout(resolve, READINESS_POLL_INTERVAL_MS)
      );
    }

    throw new Error(`HTTP endpoint ${url} not ready after ${timeoutMs}ms`);
  }
}
