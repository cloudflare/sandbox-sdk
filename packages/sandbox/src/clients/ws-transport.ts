import type { Logger } from '@repo/shared';
import {
  createNoOpLogger,
  generateRequestId,
  isWSError,
  isWSResponse,
  isWSStreamChunk,
  type WSMethod,
  type WSRequest,
  type WSResponse,
  type WSServerMessage,
  type WSStreamChunk
} from '@repo/shared';
import type { ContainerStub } from './types';

/**
 * Pending request tracker for response matching
 */
interface PendingRequest {
  resolve: (response: WSResponse) => void;
  reject: (error: Error) => void;
  streamController?: ReadableStreamDefaultController<Uint8Array>;
  isStreaming: boolean;
}

/**
 * WebSocket transport configuration
 */
export interface WSTransportOptions {
  /** Logger instance */
  logger?: Logger;

  /** Connection timeout in milliseconds */
  connectTimeoutMs?: number;

  /** Request timeout in milliseconds */
  requestTimeoutMs?: number;

  /**
   * Container stub for DO-internal WebSocket connections.
   * When provided, uses fetch-based WebSocket (Workers style) instead of new WebSocket().
   */
  stub?: ContainerStub;

  /** Port number for container connection */
  port?: number;
}

/**
 * WebSocket transport state
 */
type WSTransportState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * WebSocket transport layer for multiplexing HTTP-like requests
 *
 * Maintains a single WebSocket connection and multiplexes requests using
 * unique IDs. Supports both request/response and streaming patterns.
 */
export class WSTransport {
  private ws: WebSocket | null = null;
  private state: WSTransportState = 'disconnected';
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private connectPromise: Promise<void> | null = null;
  private logger: Logger;
  private options: WSTransportOptions;
  private url: string;
  private stub?: ContainerStub;
  private port?: number;

  // Bound event handlers for proper add/remove
  private boundHandleMessage: (event: MessageEvent) => void;
  private boundHandleClose: (event: CloseEvent) => void;

  constructor(url: string, options: WSTransportOptions = {}) {
    this.url = url;
    this.options = options;
    this.logger = options.logger ?? createNoOpLogger();
    this.stub = options.stub;
    this.port = options.port;

    // Bind handlers once in constructor
    this.boundHandleMessage = this.handleMessage.bind(this);
    this.boundHandleClose = this.handleClose.bind(this);
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Connect to the WebSocket server
   */
  async connect(): Promise<void> {
    // Already connected
    if (this.isConnected()) {
      return;
    }

    // Connection in progress
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.state = 'connecting';

    // Use fetch-based WebSocket for DO context (Workers style)
    if (this.stub) {
      this.connectPromise = this.connectViaFetch();
    } else {
      // Use standard WebSocket for browser/Node
      this.connectPromise = this.connectViaWebSocket();
    }

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  /**
   * Connect using fetch-based WebSocket (Cloudflare Workers style)
   * This is required when running inside a Durable Object.
   */
  private async connectViaFetch(): Promise<void> {
    const timeoutMs = this.options.connectTimeoutMs ?? 30000;

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Build the WebSocket URL for the container
      const wsPath = new URL(this.url).pathname;
      const httpUrl = `http://localhost:${this.port || 3000}${wsPath}`;

      // Use containerFetch with upgrade headers to establish WebSocket
      const response = await this.stub!.containerFetch(
        httpUrl,
        {
          headers: {
            Upgrade: 'websocket',
            Connection: 'Upgrade'
          },
          signal: controller.signal
        },
        this.port || 3000
      );

      clearTimeout(timeout);

      // Check if upgrade was successful
      if (response.status !== 101) {
        throw new Error(
          `WebSocket upgrade failed: ${response.status} ${response.statusText}`
        );
      }

      // Get the WebSocket from the response (Workers-specific API)
      const ws = (response as unknown as { webSocket?: WebSocket }).webSocket;
      if (!ws) {
        throw new Error('No WebSocket in upgrade response');
      }

      // Accept the WebSocket connection (Workers-specific)
      (ws as unknown as { accept: () => void }).accept();

      this.ws = ws;
      this.state = 'connected';

      // Set up event handlers
      this.ws.addEventListener('close', this.boundHandleClose);
      this.ws.addEventListener('message', this.boundHandleMessage);

      this.logger.debug('WebSocket connected via fetch', { url: this.url });
    } catch (error) {
      clearTimeout(timeout);
      this.state = 'error';
      this.logger.error(
        'WebSocket fetch connection failed',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Connect using standard WebSocket API (browser/Node style)
   */
  private connectViaWebSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeoutMs = this.options.connectTimeoutMs ?? 30000;
      const timeout = setTimeout(() => {
        this.cleanup();
        reject(new Error(`WebSocket connection timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        this.ws = new WebSocket(this.url);

        // One-time open handler for connection
        const onOpen = () => {
          clearTimeout(timeout);
          this.ws?.removeEventListener('open', onOpen);
          this.ws?.removeEventListener('error', onConnectError);
          this.state = 'connected';
          this.logger.debug('WebSocket connected', { url: this.url });
          resolve();
        };

        // One-time error handler for connection
        const onConnectError = () => {
          clearTimeout(timeout);
          this.ws?.removeEventListener('open', onOpen);
          this.ws?.removeEventListener('error', onConnectError);
          this.state = 'error';
          this.logger.error(
            'WebSocket error',
            new Error('WebSocket connection failed')
          );
          reject(new Error('WebSocket connection failed'));
        };

        this.ws.addEventListener('open', onOpen);
        this.ws.addEventListener('error', onConnectError);
        this.ws.addEventListener('close', this.boundHandleClose);
        this.ws.addEventListener('message', this.boundHandleMessage);
      } catch (error) {
        clearTimeout(timeout);
        this.state = 'error';
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(): void {
    this.cleanup();
  }

  /**
   * Send a request and wait for response
   */
  async request<T>(
    method: WSMethod,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: T }> {
    await this.connect();

    const id = generateRequestId();
    const request: WSRequest = {
      type: 'request',
      id,
      method,
      path,
      body
    };

    return new Promise((resolve, reject) => {
      const timeoutMs = this.options.requestTimeoutMs ?? 120000;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(`Request timeout after ${timeoutMs}ms: ${method} ${path}`)
        );
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (response: WSResponse) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(id);
          resolve({ status: response.status, body: response.body as T });
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(id);
          reject(error);
        },
        isStreaming: false
      });

      this.send(request);
    });
  }

  /**
   * Send a streaming request and return a ReadableStream
   *
   * The stream will receive data chunks as they arrive over the WebSocket.
   * Format matches SSE for compatibility with existing streaming code.
   */
  async requestStream(
    method: WSMethod,
    path: string,
    body?: unknown
  ): Promise<ReadableStream<Uint8Array>> {
    await this.connect();

    const id = generateRequestId();
    const request: WSRequest = {
      type: 'request',
      id,
      method,
      path,
      body
    };

    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const timeoutMs = this.options.requestTimeoutMs ?? 120000;
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(id);
          controller.error(
            new Error(`Stream timeout after ${timeoutMs}ms: ${method} ${path}`)
          );
        }, timeoutMs);

        this.pendingRequests.set(id, {
          resolve: (response: WSResponse) => {
            clearTimeout(timeout);
            this.pendingRequests.delete(id);
            // Final response - close the stream
            if (response.status >= 400) {
              controller.error(
                new Error(
                  `Stream error: ${response.status} - ${JSON.stringify(response.body)}`
                )
              );
            } else {
              controller.close();
            }
          },
          reject: (error: Error) => {
            clearTimeout(timeout);
            this.pendingRequests.delete(id);
            controller.error(error);
          },
          streamController: controller,
          isStreaming: true
        });

        this.send(request);
      },
      cancel: () => {
        this.pendingRequests.delete(id);
        // Could send a cancel message to server if needed
      }
    });
  }

  /**
   * Send a message over the WebSocket
   */
  private send(message: WSRequest): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    this.ws.send(JSON.stringify(message));
    this.logger.debug('WebSocket sent', {
      id: message.id,
      method: message.method,
      path: message.path
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(event: MessageEvent): void {
    try {
      const message = JSON.parse(event.data) as WSServerMessage;

      if (isWSResponse(message)) {
        this.handleResponse(message);
      } else if (isWSStreamChunk(message)) {
        this.handleStreamChunk(message);
      } else if (isWSError(message)) {
        this.handleError(message);
      } else {
        this.logger.warn('Unknown WebSocket message type', { message });
      }
    } catch (error) {
      this.logger.error(
        'Failed to parse WebSocket message',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Handle a response message
   */
  private handleResponse(response: WSResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      this.logger.warn('Received response for unknown request', {
        id: response.id
      });
      return;
    }

    this.logger.debug('WebSocket response', {
      id: response.id,
      status: response.status,
      done: response.done
    });

    // Only resolve when done is true
    if (response.done) {
      pending.resolve(response);
    }
  }

  /**
   * Handle a stream chunk message
   */
  private handleStreamChunk(chunk: WSStreamChunk): void {
    const pending = this.pendingRequests.get(chunk.id);
    if (!pending || !pending.streamController) {
      this.logger.warn('Received stream chunk for unknown request', {
        id: chunk.id
      });
      return;
    }

    // Convert to SSE format for compatibility with existing parsers
    const encoder = new TextEncoder();
    let sseData: string;
    if (chunk.event) {
      sseData = `event: ${chunk.event}\ndata: ${chunk.data}\n\n`;
    } else {
      sseData = `data: ${chunk.data}\n\n`;
    }

    try {
      pending.streamController.enqueue(encoder.encode(sseData));
    } catch (error) {
      // Stream may have been cancelled
      this.logger.debug('Failed to enqueue stream chunk', {
        id: chunk.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Handle an error message
   */
  private handleError(error: {
    id?: string;
    code: string;
    message: string;
    status: number;
  }): void {
    if (error.id) {
      const pending = this.pendingRequests.get(error.id);
      if (pending) {
        pending.reject(new Error(`${error.code}: ${error.message}`));
        return;
      }
    }

    // Global error - log it
    this.logger.error('WebSocket error message', new Error(error.message), {
      code: error.code,
      status: error.status
    });
  }

  /**
   * Handle WebSocket close
   */
  private handleClose(event: CloseEvent): void {
    this.state = 'disconnected';
    this.ws = null;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(
        new Error(
          `WebSocket closed: ${event.code} ${event.reason || 'No reason'}`
        )
      );
    }
    this.pendingRequests.clear();
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    if (this.ws) {
      this.ws.removeEventListener('close', this.boundHandleClose);
      this.ws.removeEventListener('message', this.boundHandleMessage);
      this.ws.close();
      this.ws = null;
    }
    this.state = 'disconnected';
    this.connectPromise = null;
    this.pendingRequests.clear();
  }
}
