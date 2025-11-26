import type { Logger } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import type { ContainerStub } from './types';
import { WSTransport } from './ws-transport';

/**
 * Transport mode for SDK communication
 */
export type TransportMode = 'http' | 'websocket';

/**
 * Transport configuration options
 */
export interface TransportOptions {
  /** Transport mode */
  mode: TransportMode;

  /** Base URL for HTTP mode */
  baseUrl?: string;

  /** WebSocket URL for WebSocket mode */
  wsUrl?: string;

  /** Logger instance */
  logger?: Logger;

  /** Container stub for DO-internal requests */
  stub?: ContainerStub;

  /** Port number */
  port?: number;

  /** Request timeout in milliseconds */
  requestTimeoutMs?: number;
}

/**
 * HTTP response-like structure
 */
export interface TransportResponse {
  status: number;
  ok: boolean;
  body: unknown;
  stream?: ReadableStream<Uint8Array>;
}

/**
 * Transport abstraction layer
 *
 * Provides a unified interface for HTTP and WebSocket transports.
 * The SandboxClient uses this to communicate with the container.
 */
export class Transport {
  private mode: TransportMode;
  private baseUrl: string;
  private wsTransport: WSTransport | null = null;
  private logger: Logger;
  private stub?: ContainerStub;
  private port?: number;

  constructor(options: TransportOptions) {
    this.mode = options.mode;
    this.baseUrl = options.baseUrl ?? 'http://localhost:3000';
    this.logger = options.logger ?? createNoOpLogger();
    this.stub = options.stub;
    this.port = options.port;

    if (this.mode === 'websocket' && options.wsUrl) {
      this.wsTransport = new WSTransport(options.wsUrl, {
        logger: this.logger,
        requestTimeoutMs: options.requestTimeoutMs
      });
    }
  }

  /**
   * Get the current transport mode
   */
  getMode(): TransportMode {
    return this.mode;
  }

  /**
   * Check if WebSocket is connected
   */
  isWebSocketConnected(): boolean {
    return this.wsTransport?.isConnected() ?? false;
  }

  /**
   * Connect WebSocket (no-op for HTTP mode)
   */
  async connect(): Promise<void> {
    if (this.mode === 'websocket' && this.wsTransport) {
      await this.wsTransport.connect();
    }
  }

  /**
   * Disconnect WebSocket (no-op for HTTP mode)
   */
  disconnect(): void {
    if (this.wsTransport) {
      this.wsTransport.disconnect();
    }
  }

  /**
   * Make a request using the configured transport
   */
  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<TransportResponse> {
    if (this.mode === 'websocket' && this.wsTransport) {
      return this.wsRequest<T>(method, path, body);
    }
    return this.httpRequest<T>(method, path, body);
  }

  /**
   * Make a streaming request using the configured transport
   */
  async requestStream(
    method: 'POST',
    path: string,
    body?: unknown
  ): Promise<ReadableStream<Uint8Array>> {
    if (this.mode === 'websocket' && this.wsTransport) {
      return this.wsTransport.requestStream(method, path, body);
    }
    return this.httpRequestStream(method, path, body);
  }

  /**
   * Make an HTTP request
   */
  private async httpRequest<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<TransportResponse> {
    const url = this.stub
      ? `http://localhost:${this.port}${path}`
      : `${this.baseUrl}${path}`;

    const options: RequestInit = {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    };

    let response: Response;
    if (this.stub) {
      response = await this.stub.containerFetch(url, options, this.port);
    } else {
      response = await fetch(url, options);
    }

    // Parse JSON body if possible
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = undefined;
    }

    return {
      status: response.status,
      ok: response.ok,
      body: responseBody
    };
  }

  /**
   * Make an HTTP streaming request
   */
  private async httpRequestStream(
    method: 'POST',
    path: string,
    body?: unknown
  ): Promise<ReadableStream<Uint8Array>> {
    const url = this.stub
      ? `http://localhost:${this.port}${path}`
      : `${this.baseUrl}${path}`;

    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    };

    let response: Response;
    if (this.stub) {
      response = await this.stub.containerFetch(url, options, this.port);
    } else {
      response = await fetch(url, options);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`HTTP error! status: ${response.status} - ${errorBody}`);
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    return response.body;
  }

  /**
   * Make a WebSocket request
   */
  private async wsRequest<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<TransportResponse> {
    if (!this.wsTransport) {
      throw new Error('WebSocket transport not initialized');
    }

    const result = await this.wsTransport.request<T>(method, path, body);

    return {
      status: result.status,
      ok: result.status >= 200 && result.status < 300,
      body: result.body
    };
  }
}

/**
 * Create a transport instance based on options
 */
export function createTransport(options: TransportOptions): Transport {
  return new Transport(options);
}
