import type { SandboxAPI } from '@repo/shared';
import { BackupClient } from './backup-client';
import { CommandClient } from './command-client';
import { DesktopClient } from './desktop-client';
import { FileClient } from './file-client';
import { GitClient } from './git-client';
import { InterpreterClient } from './interpreter-client';
import { PortClient } from './port-client';
import { ProcessClient } from './process-client';
import {
  createTransport,
  type ITransport,
  type TransportMode
} from './transport';
import type { HttpClientOptions } from './types';
import { UtilityClient } from './utility-client';
import { WatchClient } from './watch-client';

/**
 * Main sandbox client that composes all domain-specific clients.
 * Provides organized access to all sandbox functionality.
 *
 * Supports two transport modes:
 * - HTTP (default): Each request is a separate HTTP call
 * - WebSocket: All requests multiplexed over a single connection,
 *   reducing sub-request count inside Workers/Durable Objects
 */
export class SandboxClient {
  public readonly backup: BackupClient;
  public readonly commands: CommandClient;
  public readonly files: FileClient;
  public readonly processes: ProcessClient;
  public readonly ports: PortClient;
  public readonly git: GitClient;
  public readonly interpreter: InterpreterClient;
  public readonly utils: UtilityClient;
  public readonly desktop: DesktopClient;
  public readonly watch: WatchClient;

  private transport: ITransport | null = null;

  constructor(options: HttpClientOptions) {
    // Create shared transport if WebSocket mode is enabled
    if (options.transportMode === 'websocket' && options.wsUrl) {
      this.transport = createTransport({
        mode: options.transportMode,
        wsUrl: options.wsUrl,
        baseUrl: options.baseUrl,
        logger: options.logger,
        stub: options.stub,
        port: options.port,
        retryTimeoutMs: options.retryTimeoutMs
      });
    }

    // Ensure baseUrl is provided for all clients
    const clientOptions: HttpClientOptions = {
      baseUrl: 'http://localhost:3000',
      ...options,
      // Share transport across all clients
      transport: this.transport ?? options.transport
    };

    // Initialize all domain clients with shared options
    this.backup = new BackupClient(clientOptions);
    this.commands = new CommandClient(clientOptions);
    this.files = new FileClient(clientOptions);
    this.processes = new ProcessClient(clientOptions);
    this.ports = new PortClient(clientOptions);
    this.git = new GitClient(clientOptions);
    this.interpreter = new InterpreterClient(clientOptions);
    this.utils = new UtilityClient(clientOptions);
    this.desktop = new DesktopClient(clientOptions);
    this.watch = new WatchClient(clientOptions);
  }

  /**
   * Update the 503 retry budget on all transports without recreating the client.
   *
   * In WebSocket mode a single shared transport is used, so one update covers
   * every sub-client. In HTTP mode each sub-client owns its own transport, so
   * all of them are updated individually.
   */
  setRetryTimeoutMs(ms: number): void {
    if (this.transport) {
      // WebSocket mode — single shared transport
      this.transport.setRetryTimeoutMs(ms);
    } else {
      // HTTP mode — each sub-client has its own transport
      this.backup.setRetryTimeoutMs(ms);
      this.commands.setRetryTimeoutMs(ms);
      this.files.setRetryTimeoutMs(ms);
      this.processes.setRetryTimeoutMs(ms);
      this.ports.setRetryTimeoutMs(ms);
      this.git.setRetryTimeoutMs(ms);
      this.interpreter.setRetryTimeoutMs(ms);
      this.utils.setRetryTimeoutMs(ms);
      this.desktop.setRetryTimeoutMs(ms);
      this.watch.setRetryTimeoutMs(ms);
    }
  }

  /**
   * Get the current transport mode
   */
  getTransportMode(): TransportMode {
    return this.transport?.getMode() ?? 'http';
  }

  /**
   * Check if WebSocket is connected (only relevant in WebSocket mode)
   */
  isWebSocketConnected(): boolean {
    return this.transport?.isConnected() ?? false;
  }

  /**
   * Stream a file directly to the container over a binary RPC channel.
   *
   * Requires the capnweb transport (`useWebSocket: 'rpc'`). Calling this
   * method with the HTTP or WebSocket transports throws an error because those
   * transports do not support binary streaming.
   */
  writeFileStream(
    _path: string,
    _content: ReadableStream<Uint8Array>,
    _sessionId: string
  ): Promise<{
    success: boolean;
    path: string;
    bytesWritten: number;
    timestamp: string;
  }> {
    throw new Error(
      'writeFileStream requires the RPC transport. Enable it with transport: "rpc" in sandbox options.'
    );
  }

  /**
   * Connect WebSocket transport (no-op in HTTP mode)
   * Called automatically on first request, but can be called explicitly
   * to establish connection upfront.
   */
  async connect(): Promise<void> {
    if (this.transport) {
      await this.transport.connect();
    }
  }

  /**
   * Disconnect WebSocket transport (no-op in HTTP mode)
   * Should be called when the sandbox is destroyed.
   */
  disconnect(): void {
    if (this.transport) {
      this.transport.disconnect();
    }
  }
}

// Compile-time check: SandboxClient exposes every top-level field that SandboxAPI requires.
// Deep structural compatibility is not enforced because the HTTP sub-clients
// (e.g. FileClient) lack streaming methods only available via capnweb.
type PublicKeys<T> = { [K in keyof T]: unknown };
void (0 as unknown as PublicKeys<SandboxClient> satisfies PublicKeys<SandboxAPI>);
