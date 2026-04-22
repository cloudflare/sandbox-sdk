import type {
  DesktopProcessHealth,
  DesktopStartRequest,
  Logger
} from '@repo/shared';
import type { Subprocess } from 'bun';

interface DesktopProcess {
  name: string;
  command: string;
  args: string[];
  priority: number;
  proc: Subprocess<'ignore', 'pipe', 'pipe'> | null;
  pid: number | undefined;
  /** PGID for group-kill. Equals the child PID when spawned with `detached`. */
  pgid: number | undefined;
  startTime: Date | null;
}

const DEFAULT_RESOLUTION: [number, number] = [1024, 768];
const DEFAULT_DPI = 96;
const READINESS_TIMEOUT_MS = 15000;
const READINESS_POLL_INTERVAL_MS = 200;
/** Overall deadline for the entire stop sequence (SIGTERM + wait + SIGKILL). */
const STOP_DEADLINE_MS = 3000;
/** Grace period after SIGKILL before clearing state. */
const SIGKILL_GRACE_MS = 500;

export class DesktopManager {
  private processes = new Map<string, DesktopProcess>();
  private state: 'inactive' | 'starting' | 'active' | 'stopping' = 'inactive';
  private resolution: [number, number] = DEFAULT_RESOLUTION;
  private dpi: number = DEFAULT_DPI;
  /** Coalesces concurrent stop() calls onto a single teardown. */
  private stopPromise: Promise<void> | null = null;

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
      const processDefs: Omit<
        DesktopProcess,
        'proc' | 'pid' | 'pgid' | 'startTime'
      >[] = [
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
          args: ['--web', '/usr/share/novnc', '0.0.0.0:6080', 'localhost:5900'],
          priority: 400
        }
      ];

      for (const def of processDefs) {
        const desktopProcess: DesktopProcess = {
          ...def,
          proc: null,
          pid: undefined,
          pgid: undefined,
          startTime: null
        };
        this.processes.set(def.name, desktopProcess);
        await this.startProcess(desktopProcess);
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

    // Coalesce concurrent stop() calls onto the same teardown promise.
    if (this.stopPromise) return this.stopPromise;

    this.stopPromise = this.doStop();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private async doStop(): Promise<void> {
    this.state = 'stopping';

    const allProcs = [...this.processes.values()];

    // 1. SIGTERM every process group at once.
    for (const p of allProcs) {
      this.signalProcessGroup(p, 'SIGTERM');
    }

    // 2. Wait for all to exit, bounded by STOP_DEADLINE_MS.
    // allSettled never rejects — a single process crashing won't
    // short-circuit the wait or skip the SIGKILL escalation.
    const exitPromises = allProcs
      .filter((p) => p.proc && !p.proc.killed)
      .map((p) => p.proc!.exited);

    const allSettled = Promise.allSettled(exitPromises);
    const deadline = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), STOP_DEADLINE_MS)
    );

    const result = await Promise.race([
      allSettled.then(() => 'exited' as const),
      deadline
    ]);

    if (result === 'timeout') {
      // 3. SIGKILL survivors.
      this.logger.warn(
        'Desktop processes did not exit after SIGTERM, sending SIGKILL'
      );
      for (const p of allProcs) {
        this.signalProcessGroup(p, 'SIGKILL');
      }
      await new Promise((resolve) => setTimeout(resolve, SIGKILL_GRACE_MS));
    }

    // 4. Clear state.
    for (const p of allProcs) {
      p.proc = null;
      p.pid = undefined;
      p.pgid = undefined;
    }
    this.processes.clear();
    this.state = 'inactive';
    this.logger.info('Desktop environment stopped');
  }

  getStatus(): {
    status: 'active' | 'partial' | 'inactive';
    processes: Record<string, DesktopProcessHealth>;
  } {
    if (
      this.state === 'inactive' ||
      this.state === 'stopping' ||
      this.processes.size === 0
    ) {
      return { status: 'inactive', processes: {} };
    }

    const processes: Record<string, DesktopProcessHealth> = {};
    let allRunning = true;
    let anyRunning = false;

    for (const [name, p] of this.processes) {
      const running = p.proc !== null && !p.proc.killed;
      const uptime = p.startTime
        ? Math.floor((Date.now() - p.startTime.getTime()) / 1000)
        : undefined;

      processes[name] = {
        running,
        pid: p.pid,
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

  private async startProcess(desktopProcess: DesktopProcess): Promise<void> {
    const childLogger = this.logger.child({ process: desktopProcess.name });
    childLogger.info('Starting desktop process', {
      command: desktopProcess.command,
      args: desktopProcess.args
    });

    const env: Record<string, string> = {
      ...(desktopProcess.name !== 'xvfb' ? { DISPLAY: ':99' } : {})
    };

    // `detached: true` calls setsid(2), making the child a process group
    // leader. Its PGID equals its PID, so `kill(-pid, sig)` reaches the
    // entire subtree (e.g. xfce4's panel, xfwm4, thunar, etc.).
    const proc = Bun.spawn([desktopProcess.command, ...desktopProcess.args], {
      env: { ...Bun.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true
    });

    desktopProcess.proc = proc;
    desktopProcess.pid = proc.pid;
    desktopProcess.pgid = proc.pid; // group leader ⇒ pgid == pid
    desktopProcess.startTime = new Date();

    this.pipeOutput(proc.stdout, childLogger, 'debug');
    this.pipeOutput(proc.stderr, childLogger, 'debug');

    await new Promise((resolve) => setTimeout(resolve, 500));

    if (proc.killed) {
      throw new Error(
        `Desktop process ${desktopProcess.name} exited immediately`
      );
    }

    childLogger.info('Desktop process started', { pid: proc.pid });
  }

  /** Drain a ReadableStream through the logger. Fire-and-forget. */
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
    } catch {
      // Stream cancelled or errored — expected during stop.
    }
  }

  /** Send a signal to the entire process group via kill(-pgid, sig). */
  private signalProcessGroup(
    desktopProcess: DesktopProcess,
    signal: NodeJS.Signals
  ): void {
    const pgid = desktopProcess.pgid;
    if (!pgid) return;
    try {
      // Negative PID targets the process group.
      process.kill(-pgid, signal);
    } catch {
      // ESRCH: process group already exited.
    }
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
