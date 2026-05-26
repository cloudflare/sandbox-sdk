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
  /**
   * Opaque cloudflared `--token` from the Cloudflare Tunnel API.
   *
   * Presence selects the tunnel mode:
   *   - omitted → quick tunnel (`cloudflared tunnel --url`), scrape
   *     `*.trycloudflare.com` URL from stderr, resolve once `/ready`
   *     reports a live connection.
   *   - present → named tunnel (`cloudflared tunnel run --token <T> --url`),
   *     hostname is owned by the SDK; the manager only confirms readiness.
   *
   * The token is masked when logged — only the first five characters
   * survive into log lines, the rest become `*`s.
   */
  token?: string;
  /** Optional path to the cloudflared binary. Defaults to `cloudflared`. */
  binaryPath?: string;
  /** Override readiness timeout. */
  readyTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL during stop(). */
  stopGraceMs?: number;
  /**
   * Optional callback invoked exactly once when the supervised
   * `cloudflared` process exits, for any reason — natural exit,
   * graceful SIGTERM via `stop()`, or post-SIGKILL reap.
   *
   * `exitCode` is the integer exit status, or `null` if the process
   * was signalled rather than exited cleanly (matches Bun's
   * Subprocess.exited contract).
   *
   * Errors thrown from the callback are caught and logged so a
   * broken consumer cannot crash the manager.
   */
  onExit?: (exitCode: number | null) => void | Promise<void>;
  logger: Logger;
}

export interface TunnelStartResult {
  /**
   * Public URL the tunnel resolves to, parsed from the cloudflared banner.
   * Only populated for quick tunnels; `undefined` for named tunnels where
   * the hostname lives in the SDK layer.
   */
  url?: string;
  /** PID of the cloudflared child process. */
  pid: number;
}

/**
 * Sentinel thrown by `TunnelManager.start()` when `Bun.spawn` reports the
 * `cloudflared` binary is missing on `$PATH`. The dedicated subclass lets
 * callers (notably `TunnelService` and the SDK) distinguish a
 * missing-binary failure from generic startup errors, and lets us scrub the
 * `$PATH`-bearing message Bun emits — the literal `$` token confused
 * downstream tooling.
 */
export class CloudflaredNotFoundError extends Error {
  readonly binary: string;
  constructor(binary: string, cause?: unknown) {
    super(
      `cloudflared binary not found at '${binary}'. ` +
        'Install cloudflared and ensure it is reachable on PATH inside the container.'
    );
    this.name = 'CloudflaredNotFoundError';
    this.binary = binary;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

function isEnoent(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errno?: unknown };
  return e.code === 'ENOENT' || e.errno === -2;
}

/**
 * Mask a cloudflared `--token` value for logging. Keeps the first 5
 * characters (enough to correlate against Cloudflare's dashboard token
 * preview) followed by a constant-width `***` placeholder. The mask is
 * the same width regardless of the input so the log line does not leak
 * the secret's byte length — even though Cloudflare tokens are a known
 * fixed format, treating length as non-sensitive in logs is a habit
 * better not built.
 */
function maskToken(token: string): string {
  if (token.length <= 5) return '***';
  return `${token.slice(0, 5)}***`;
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
    const isNamed = this.opts.token !== undefined;

    const args = this.buildArgs();
    // Token presence selects the mode. When it's set we mask it in the
    // log line: first 5 chars survive (useful for matching against a
    // dashboard token preview), the rest become `*`s.
    const loggableArgs = isNamed
      ? args.map((a, i) => (args[i - 1] === '--token' ? maskToken(a) : a))
      : args;
    this.logger.info('Spawning cloudflared', {
      mode: isNamed ? 'named' : 'quick',
      args: loggableArgs
    });

    const binary = this.opts.binaryPath ?? 'cloudflared';
    try {
      this.proc = Bun.spawn([binary, ...args], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        // Put cloudflared in its own process group so SIGTERM/SIGKILL on its
        // pid is scoped to it (and to any future children it spawns).
        detached: true
      }) as Subprocess<'ignore', 'pipe', 'pipe'>;
    } catch (err) {
      if (isEnoent(err)) {
        throw new CloudflaredNotFoundError(binary, err);
      }
      throw err;
    }

    // Track exit so the readiness loop can fail fast if cloudflared dies.
    // We also fire the consumer's onExit callback here so a single
    // hook covers natural exits, SIGTERM-driven stops, and SIGKILL
    // fallbacks. Callback errors are caught and logged — a broken
    // consumer must not crash the manager.
    this.proc.exited.then((code) => {
      this.exited = true;
      this.exitInfo = { code, signal: null };
      this.logger.info('cloudflared exited', { code });
      const onExit = this.opts.onExit;
      if (onExit) {
        try {
          const result = onExit(code);
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch((err) => {
              this.logger.warn('onExit callback rejected', {
                error: err instanceof Error ? err.message : String(err)
              });
            });
          }
        } catch (err) {
          this.logger.warn('onExit callback threw', {
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    });

    // Pump stderr (cloudflared logs there by default) and scrape what we
    // need from it. Stdout is normally empty for `tunnel` but we drain
    // it for completeness.
    void this.scrapeStream(this.proc.stderr, 'stderr');
    void this.scrapeStream(this.proc.stdout, 'stdout');

    const timeoutMs = this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const url = await this.waitForReady(timeoutMs);

    return url === undefined
      ? { pid: this.proc.pid }
      : { url, pid: this.proc.pid };
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
    const token = this.opts.token;
    // Always attach a metrics server on an ephemeral port so we can poll
    // /ready for a stable readiness signal.
    if (token !== undefined) {
      // Named tunnel: `tunnel run --token <T>` uses config_src=cloudflare.
      // The token identifies the tunnel; `--url` overrides the local
      // forward address so we don't depend on the edge-side ingress config.
      return [
        'tunnel',
        '--metrics',
        '127.0.0.1:0',
        '--no-autoupdate',
        'run',
        '--token',
        token,
        '--url',
        localUrl
      ];
    }
    // Quick mode: `cloudflared tunnel --url http://localhost:<port>`.
    // JSON output makes the URL line easy to parse out of stderr.
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
   * Resolve once cloudflared is ready.
   *
   * - Quick mode: wait until we've parsed a `*.trycloudflare.com` URL
   *   from stderr **and** `/ready` reports >= 1 connection. Returns
   *   the URL.
   * - Named mode: wait until `/ready` reports >= 1 connection. The SDK
   *   owns the hostname; we resolve with `undefined`.
   */
  private async waitForReady(timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    const isNamed = this.opts.token !== undefined;

    while (Date.now() < deadline) {
      if (this.exited) {
        throw new Error(
          `cloudflared exited before becoming ready (code=${this.exitInfo?.code})`
        );
      }

      const ready = await this.checkReady();
      if (ready) {
        if (isNamed) return undefined;
        if (this.quickUrl) return this.quickUrl;
      }

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
