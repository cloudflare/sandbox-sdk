import { connect, type Socket } from 'node:net';
import type { Logger } from '@repo/shared';
import { RpcSession } from 'capnweb';
import { SocketTransport } from './socket-transport';

const PING_TIMEOUT_MS = 5_000;
const CONNECT_RETRY_DELAY_MS = 50;

/**
 * Capnweb client for a single sidecar process.
 *
 * The container connects to the sidecar's unix socket, brings up a capnweb
 * `RpcSession`, and holds the sidecar's remote main as a permanent reference.
 * `remoteMain()` returns a `.dup()`-ed stub that callers can dispose freely
 * without tearing down the session itself \u2014 critical because the same
 * sidecar is shared across every DO that connects to it.
 *
 * One bridge instance per running sidecar; recreated whenever the sidecar
 * (re)starts.
 */
export class CapnwebExtensionBridge {
  readonly #extensionId: string;
  readonly #logger: Logger;
  #socket: Socket | null = null;
  #session: RpcSession | null = null;
  #remoteMain: object | null = null;
  #closed = false;
  #down = false;

  constructor(extensionId: string, logger: Logger) {
    this.#extensionId = extensionId;
    this.#logger = logger;
  }

  /**
   * Connect to the sidecar socket, retrying until it accepts or the timeout
   * elapses (the sidecar may still be starting up). Resolves once the
   * capnweb session is live.
   */
  async connect(socketPath: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | undefined;

    while (Date.now() < deadline) {
      try {
        const socket = await this.#tryConnect(socketPath);
        this.#attach(socket);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await new Promise((r) => setTimeout(r, CONNECT_RETRY_DELAY_MS));
      }
    }

    throw new Error(
      `Extension '${this.#extensionId}' sidecar did not accept a capnweb connection within ${timeoutMs}ms${
        lastError ? `: ${lastError.message}` : ''
      }`
    );
  }

  /**
   * Return a `.dup()`-ed stub of the sidecar's remote main. The duplicate is
   * disposable by the caller (e.g. when a DO releases its handle) without
   * tearing down the underlying capnweb session held by the bridge.
   */
  remoteMain(): object {
    if (!this.#remoteMain) {
      throw new Error(
        `Extension '${this.#extensionId}' capnweb bridge is not connected`
      );
    }
    const main = this.#remoteMain as { dup?: () => object };
    return main.dup ? main.dup() : main;
  }

  /** Bounded `__ping__` round-trip; never hangs the caller. */
  async ping(): Promise<boolean> {
    if (!this.#remoteMain) return false;
    const main = this.#remoteMain as {
      __ping__?: () => Promise<string> | string;
    };
    if (typeof main.__ping__ !== 'function') return false;
    try {
      const result = await Promise.race([
        Promise.resolve(main.__ping__()),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('ping timed out')), PING_TIMEOUT_MS)
        )
      ]);
      return result === 'pong';
    } catch (error) {
      this.#logger.debug('Extension ping failed', {
        extensionId: this.#extensionId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  get connected(): boolean {
    return (
      !this.#closed &&
      !this.#down &&
      this.#socket !== null &&
      this.#session !== null
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#dispose();
  }

  #tryConnect(socketPath: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        resolve(socket);
      });
    });
  }

  #attach(socket: Socket): void {
    this.#socket = socket;
    const transport = new SocketTransport(socket);
    const session = new RpcSession(transport);
    this.#session = session;
    this.#remoteMain = session.getRemoteMain() as object;
    socket.on('error', (error) => this.#markDown(error));
    socket.on('close', () =>
      this.#markDown(new Error('Extension capnweb socket closed'))
    );
  }

  #markDown(error: Error): void {
    if (this.#closed || this.#down) return;
    this.#down = true;
    this.#logger.debug('Extension capnweb bridge disconnected', {
      extensionId: this.#extensionId,
      error: error.message
    });
    this.#dispose();
  }

  #dispose(): void {
    const main = this.#remoteMain as Disposable | null;
    const session = this.#session as unknown as Disposable | null;
    const socket = this.#socket;
    this.#remoteMain = null;
    this.#session = null;
    this.#socket = null;
    try {
      main?.[Symbol.dispose]?.();
    } catch (error) {
      this.#logger.debug('Error disposing extension remote main', {
        extensionId: this.#extensionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    try {
      session?.[Symbol.dispose]?.();
    } catch (error) {
      this.#logger.debug('Error disposing extension capnweb session', {
        extensionId: this.#extensionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    socket?.destroy();
  }
}
