import { CommandClient } from './command-client';
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

/**
 * Main sandbox client that composes all domain-specific clients
 * Provides organized access to all sandbox functionality
 *
 * Supports two transport modes:
 * - HTTP (default): Each request is a separate HTTP call
 * - WebSocket: All requests multiplexed over a single connection
 *
 * WebSocket mode reduces sub-request count when running inside Workers/Durable Objects.
 */
export class SandboxClient {
  public readonly commands: CommandClient;
  public readonly files: FileClient;
  public readonly processes: ProcessClient;
  public readonly ports: PortClient;
  public readonly git: GitClient;
  public readonly interpreter: InterpreterClient;
  public readonly utils: UtilityClient;

  private transport: ITransport | null = null;

  constructor(options: HttpClientOptions) {
    // Create shared transport if WebSocket mode is enabled
    if (options.transportMode === 'websocket' && options.wsUrl) {
      this.transport = createTransport({
        mode: 'websocket',
        wsUrl: options.wsUrl,
        baseUrl: options.baseUrl,
        logger: options.logger,
        stub: options.stub,
        port: options.port,
        requestTimeoutMs: options.requestTimeoutMs,
        streamIdleTimeoutMs: options.streamIdleTimeoutMs
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
    this.commands = new CommandClient(clientOptions);
    this.files = new FileClient(clientOptions);
    this.processes = new ProcessClient(clientOptions);
    this.ports = new PortClient(clientOptions);
    this.git = new GitClient(clientOptions);
    this.interpreter = new InterpreterClient(clientOptions);
    this.utils = new UtilityClient(clientOptions);
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
