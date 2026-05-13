/**
 * TunnelManager - supervises a single `cloudflared` child process running
 * a quick tunnel (`cloudflared tunnel --url`).
 */

import type { Logger } from '@repo/shared';
import type { Subprocess } from 'bun';

const READY_POLL_INTERVAL_MS = 200;
const DEFAULT_READY_TIMEOUT_MS = 90_000;
const DEFAULT_STOP_GRACE_MS = 3_000;

/**
 * Match the metrics-endpoint announcement message cloudflared emits at
 * startup. The exact text is `Starting metrics server on 127.0.0.1:<port>/metrics`;
 * we capture the host:port for the readiness probe.
 */
const METRICS_BIND_REGEX = /metrics server on (127\.0\.0\.1:\d+)/i;
const QUICK_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export interface TunnelManagerOptions {
  /** Local port to expose. */
  port: number;
  /** Optional path to the cloudflared binary. Defaults to `cloudflared`. */
  binaryPath?: string;
  /** Override readiness timeout. */
  readyTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL during stop(). */
  stopGraceMs?: number;
  logger: Logger;
}

export interface TunnelStartResult {
  /** Public URL the tunnel resolves to, parsed from the cloudflared banner. */
  url: string;
  /** PID of the cloudflared child process. */
  pid: number;
}

export class TunnelManager {
  private readonly opts: TunnelManagerOptions;
  private readonly logger: Logger;
  private proc: Subprocess<'ignore', 'pipe', 'pipe'> | null = null;
  private metricsAddr: string | null = null;
  private quickUrl: string | null = null;
  private exited = false;
  private exitInfo: { code: number | null; signal: string | null } | null =
    null;

  constructor(opts: TunnelManagerOptions) {
    this.opts = opts;
    this.logger = opts.logger.child({ port: opts.port });
  }

  /**
   * Spawn cloudflared and resolve once a public URL is available and the
   * tunnel reports ready. Rejects on timeout or early process exit. On
   * rejection the caller MUST call `stop()` to clean up the child process —
   * `start()` does not self-clean so failures can be diagnosed by inspecting
   * the (still-running) process.
   */
  async start(): Promise<TunnelStartResult> {
    if (this.proc) {
      throw new Error('TunnelManager: already started');
    }

    const args = this.buildArgs();
    this.logger.info('Spawning cloudflared', { args });

    const binary = this.opts.binaryPath ?? 'cloudflared';
    this.proc = Bun.spawn([binary, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      // Put cloudflared in its own process group so SIGTERM/SIGKILL on its
      // pid is scoped to it (and to any future children it spawns).
      detached: true
    }) as Subprocess<'ignore', 'pipe', 'pipe'>;

    // Track exit so the readiness loop can fail fast if cloudflared dies.
    this.proc.exited.then((code) => {
      this.exited = true;
      this.exitInfo = { code, signal: null };
      this.logger.info('cloudflared exited', { code });
    });

    // Pump stderr (cloudflared logs there by default) and scrape what we
    // need from it. Stdout is normally empty for `tunnel` but we drain
    // it for completeness.
    void this.scrapeStream(this.proc.stderr, 'stderr');
    void this.scrapeStream(this.proc.stdout, 'stdout');

    const timeoutMs = this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const url = await this.waitForReady(timeoutMs);

    return { url, pid: this.proc.pid };
  }

  /** Send SIGTERM, then SIGKILL after `stopGraceMs`. */
  async stop(): Promise<void> {
    if (!this.proc || this.exited) return;
    this.logger.info('Stopping cloudflared', { pid: this.proc.pid });

    try {
      this.proc.kill('SIGTERM');
    } catch (err) {
      this.logger.warn('SIGTERM failed', { error: String(err) });
    }

    const graceMs = this.opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    const exitedInTime = await Promise.race([
      this.proc.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs))
    ]);

    if (!exitedInTime) {
      this.logger.warn('cloudflared did not exit on SIGTERM, sending SIGKILL');
      try {
        this.proc.kill('SIGKILL');
      } catch (err) {
        this.logger.warn('SIGKILL failed', { error: String(err) });
      }
      await this.proc.exited;
    }
  }

  isRunning(): boolean {
    return this.proc !== null && !this.exited;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildArgs(): string[] {
    const localUrl = `http://localhost:${this.opts.port}`;
    // Always attach a metrics server on an ephemeral port so we can poll
    // /ready for a stable readiness signal.
    return [
      'tunnel',
      '--metrics',
      '127.0.0.1:0',
      '--no-autoupdate',
      '--output',
      'json',
      '--url',
      localUrl
    ];
  }

  private async scrapeStream(
    stream: ReadableStream<Uint8Array> | null,
    label: 'stdout' | 'stderr'
  ): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const nl = buffer.indexOf('\n');
          if (nl === -1) break;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          this.handleLogLine(line, label);
        }
      }
      if (buffer) this.handleLogLine(buffer, label);
    } catch {
      // Stream cancelled — expected during stop.
    }
  }

  private handleLogLine(line: string, label: 'stdout' | 'stderr'): void {
    if (!line.trim()) return;
    this.logger.debug(`cloudflared:${label}`, { line });

    // With `--output json`, every record is `{level, message, ...}`.
    // Fall back to substring matching when a line isn't JSON (cloudflared
    // occasionally writes plaintext warnings before json mode kicks in).
    let message = line;
    try {
      const record = JSON.parse(line) as { message?: string };
      if (typeof record.message === 'string') {
        message = record.message;
      }
    } catch {
      // Not JSON — use the raw line.
    }

    if (!this.metricsAddr) {
      const m = message.match(METRICS_BIND_REGEX);
      if (m) {
        this.metricsAddr = m[1];
        this.logger.info('cloudflared metrics endpoint', {
          addr: this.metricsAddr
        });
      }
    }

    if (!this.quickUrl) {
      const m = message.match(QUICK_URL_REGEX);
      if (m) {
        this.quickUrl = m[0];
        this.logger.info('quick tunnel URL detected', { url: this.quickUrl });
      }
    }
  }

  /**
   * Resolve once cloudflared is ready: we have a parsed
   * `*.trycloudflare.com` URL **and** `/ready` reports >= 1 connection.
   */
  private async waitForReady(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.exited) {
        throw new Error(
          `cloudflared exited before becoming ready (code=${this.exitInfo?.code})`
        );
      }

      const ready = await this.checkReady();
      if (ready && this.quickUrl) return this.quickUrl;

      await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
    }

    throw new Error(
      `Timed out waiting for cloudflared to become ready after ${timeoutMs}ms`
    );
  }

  /**
   * Returns true once cloudflared's `/ready` reports `readyConnections >= 1`.
   * Returns false (silently) if the metrics endpoint isn't yet known or the
   * fetch fails — caller will retry on the poll interval.
   */
  private async checkReady(): Promise<boolean> {
    if (!this.metricsAddr) return false;
    try {
      const res = await fetch(`http://${this.metricsAddr}/ready`, {
        signal: AbortSignal.timeout(1_000)
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { readyConnections?: number };
      return (body.readyConnections ?? 0) >= 1;
    } catch {
      return false;
    }
  }
}
