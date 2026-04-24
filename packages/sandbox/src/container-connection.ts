/**
 * Capnweb RPC connection to the container.
 *
 * Manages a single WebSocket session and exposes typed methods that map
 * 1:1 to the container's SandboxAPI. The Sandbox DO calls these
 * directly instead of going through the HTTP client layer.
 */

import type {
  Logger,
  SandboxAPI,
  SandboxBackupAPI,
  SandboxCommandsAPI,
  SandboxDesktopAPI,
  SandboxFilesAPI,
  SandboxGitAPI,
  SandboxInterpreterAPI,
  SandboxPortsAPI,
  SandboxProcessesAPI,
  SandboxUtilsAPI,
  SandboxWatchAPI
} from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import { RpcSession, type RpcStub, type RpcTransport } from 'capnweb';

// ---------------------------------------------------------------------------
// Connection manager
// ---------------------------------------------------------------------------

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Stub that can issue a WebSocket-upgrade fetch through the DO's Container base class. */
export interface ContainerFetchStub {
  fetch(request: Request): Promise<Response>;
}

export interface ContainerConnectionOptions {
  stub: ContainerFetchStub;
  port?: number;
  logger?: Logger;
}

/**
 * Manages a capnweb WebSocket RPC session to the container.
 *
 * The RPC stub is created eagerly in the constructor using a deferred
 * transport. Calls made before `connect()` completes are queued in the
 * transport and flushed once the WebSocket is established.
 */
export class ContainerConnection {
  private readonly stub: RpcStub<SandboxAPI>;
  private readonly session: RpcSession<SandboxAPI>;
  private readonly transport: DeferredTransport;
  private ws: WebSocket | null = null;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private readonly containerStub: ContainerFetchStub;
  private readonly port: number;
  private readonly logger: Logger;

  constructor(options: ContainerConnectionOptions) {
    this.containerStub = options.stub;
    this.port = options.port ?? 3000;
    this.logger = options.logger ?? createNoOpLogger();

    this.transport = new DeferredTransport();
    this.session = new RpcSession<SandboxAPI>(this.transport);
    this.stub = this.session.getRemoteMain();
  }

  /**
   * Get the typed RPC stub.
   *
   * The stub is available immediately — calls made before connect()
   * completes are queued in the deferred transport and flushed once
   * the WebSocket is established.
   */
  rpc(): RpcStub<SandboxAPI> {
    if (!this.connected && !this.connectPromise) {
      this.connect().catch(() => {});
    }
    return this.stub;
  }

  /**
   * Return capnweb session statistics. The `imports` and `exports` counts
   * reflect all in-flight RPC calls, streams, and peer-held references.
   * An idle session has imports <= 1 && exports <= 1 (the bootstrap stubs).
   */
  getStats(): { imports: number; exports: number } {
    return this.session.getStats();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  disconnect(): void {
    try {
      (this.stub as unknown as Disposable)[Symbol.dispose]?.();
    } catch {
      // Stub may already be disposed
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // WebSocket may already be closed
      }
      this.ws = null;
    }
    this.connected = false;
    this.connectPromise = null;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async doConnect(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DEFAULT_CONNECT_TIMEOUT_MS
    );

    try {
      const url = `http://localhost:${this.port}/rpc`;
      const request = new Request(url, {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade'
        },
        signal: controller.signal
      });

      const response = await this.containerStub.fetch(request);
      clearTimeout(timeout);

      if (response.status !== 101) {
        throw new Error(
          `WebSocket upgrade failed: ${response.status} ${response.statusText}`
        );
      }

      // The Container base class returns the WebSocket on the response object
      // (Cloudflare Workers runtime convention, not standard fetch)
      const ws = (response as unknown as { webSocket?: WebSocket }).webSocket;
      if (!ws) {
        throw new Error('No WebSocket in upgrade response');
      }

      // Workers WebSockets require explicit accept() before use
      (ws as unknown as { accept: () => void }).accept();

      ws.addEventListener('close', () => {
        this.connected = false;
        this.ws = null;
        this.logger.debug('ContainerConnection WebSocket closed');
      });

      ws.addEventListener('error', () => {
        this.connected = false;
        this.ws = null;
      });

      this.ws = ws;
      this.transport.activate(ws);
      this.connected = true;

      this.logger.debug('ContainerConnection established', {
        port: this.port
      });
    } catch (error) {
      clearTimeout(timeout);
      this.connected = false;
      this.logger.error(
        'ContainerConnection failed',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Deferred WebSocket transport
// ---------------------------------------------------------------------------

/**
 * RPC transport that queues sends and blocks receives until a WebSocket
 * is provided via `activate()`. Allows the RPC stub to be created before
 * the connection is established — queued calls flush automatically.
 */
class DeferredTransport implements RpcTransport {
  #ws: WebSocket | null = null;
  #sendQueue: string[] = [];
  #receiveQueue: string[] = [];
  #receiveResolver?: (msg: string) => void;
  #receiveRejecter?: (err: unknown) => void;
  #error?: unknown;

  activate(ws: WebSocket): void {
    this.#ws = ws;

    ws.addEventListener('message', (event: MessageEvent) => {
      if (this.#error) return;
      if (typeof event.data === 'string') {
        if (this.#receiveResolver) {
          this.#receiveResolver(event.data);
          this.#receiveResolver = undefined;
          this.#receiveRejecter = undefined;
        } else {
          this.#receiveQueue.push(event.data);
        }
      }
    });
    ws.addEventListener('close', (event: CloseEvent) => {
      this.#fail(
        new Error(`Peer closed WebSocket: ${event.code} ${event.reason}`)
      );
    });
    ws.addEventListener('error', () => {
      this.#fail(new Error('WebSocket connection failed'));
    });

    // Flush queued sends
    for (const msg of this.#sendQueue) {
      ws.send(msg);
    }
    this.#sendQueue = [];
  }

  async send(message: string): Promise<void> {
    if (this.#ws) {
      this.#ws.send(message);
    } else {
      this.#sendQueue.push(message);
    }
  }

  async receive(): Promise<string> {
    if (this.#receiveQueue.length > 0) return this.#receiveQueue.shift()!;
    if (this.#error) throw this.#error;
    return new Promise<string>((resolve, reject) => {
      this.#receiveResolver = resolve;
      this.#receiveRejecter = reject;
    });
  }

  abort(reason: unknown): void {
    if (this.#ws) {
      const message = reason instanceof Error ? reason.message : String(reason);
      this.#ws.close(3000, message);
    }
  }

  #fail(err: unknown): void {
    if (this.#error) return;
    this.#error = err;
    this.#receiveRejecter?.(err);
    this.#receiveResolver = undefined;
    this.#receiveRejecter = undefined;
  }
}
