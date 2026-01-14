import {
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
import { BaseTransport } from './base-transport';
import type { TransportConfig, TransportMode } from './types';

/**
 * Pending request tracker for response matching
 */
interface PendingRequest {
  resolve: (response: WSResponse) => void;
  reject: (error: Error) => void;
  streamController?: ReadableStreamDefaultController<Uint8Array>;
  isStreaming: boolean;
  timeoutId?: ReturnType<typeof setTimeout>;
  /** Called when first stream chunk is received (for deferred stream return) */
  onFirstChunk?: () => void;
}

/**
 * WebSocket transport state
 */
type WSTransportState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * WebSocket transport implementation
 *
 * Multiplexes HTTP-like requests over a single WebSocket connection.
 * Useful when running inside Workers/DO where sub-request limits apply.
 */
export class WebSocketTransport extends BaseTransport {
  private ws: WebSocket | null = null;
  private state: WSTransportState = 'disconnected';
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private connectPromise: Promise<void> | null = null;

  // Bound event handlers for proper add/remove
  private boundHandleMessage: (event: MessageEvent) => void;
  private boundHandleClose: (event: CloseEvent) => void;

  constructor(config: TransportConfig) {
    super(config);

    if (!config.wsUrl) {
      throw new Error('wsUrl is required for WebSocket transport');
    }

    // Bind handlers once in constructor
    this.boundHandleMessage = this.handleMessage.bind(this);
    this.boundHandleClose = this.handleClose.bind(this);
  }

  getMode(): TransportMode {
    return 'websocket';
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Connect to the WebSocket server
   *
   * The connection promise is assigned synchronously so concurrent
   * callers share the same connection attempt.
   */
  async connect(): Promise<void> {
    // Already connected
    if (this.isConnected()) {
      return;
    }

    // Connection in progress - wait for it
    if (this.connectPromise) {
      return this.connectPromise;
    }

    // Assign synchronously so concurrent callers await the same promise
    this.connectPromise = this.doConnect();

    try {
      await this.connectPromise;
    } catch (error) {
      // Clear promise AFTER await so concurrent callers see the same rejection
      this.connectPromise = null;
      throw error;
    }
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(): void {
    this.cleanup();
  }

  /**
   * Transport-specific fetch implementation
   * Converts WebSocket response to standard Response object.
   */
  protected async doFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    await this.connect();

    const method = (options?.method || 'GET') as WSMethod;
    const body = this.parseBody(options?.body);

    const result = await this.request(method, path, body);

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Streaming fetch implementation
   */
  async fetchStream(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' = 'POST'
  ): Promise<ReadableStream<Uint8Array>> {
    return this.requestStream(method, path, body);
  }

  /**
   * Parse request body from RequestInit
   */
  private parseBody(body: RequestInit['body']): unknown {
    if (!body) {
      return undefined;
    }

    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch (error) {
        throw new Error(
          `Request body must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    throw new Error(
      `WebSocket transport only supports string bodies. Got: ${typeof body}`
    );
  }

  /**
   * Internal connection logic
   */
  private async doConnect(): Promise<void> {
    this.state = 'connecting';
    // Use fetch-based WebSocket for DO context (Workers style)
    if (this.config.stub) {
      await this.connectViaFetch();
    } else {
      // Use standard WebSocket for browser/Node
      await this.connectViaWebSocket();
    }
  }

  /**
   * Connect using fetch-based WebSocket (Cloudflare Workers style)
   * This is required when running inside a Durable Object.
   *
   * Uses stub.fetch() which routes WebSocket upgrade requests through the
   * parent Container class that supports the WebSocket protocol.
   */
  private async connectViaFetch(): Promise<void> {
    const timeoutMs = this.config.connectTimeoutMs ?? 30000;

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Build the WebSocket URL for the container
      const wsPath = new URL(this.config.wsUrl!).pathname;
      const httpUrl = `http://localhost:${this.config.port || 3000}${wsPath}`;

      // Create a Request with WebSocket upgrade headers
      const request = new Request(httpUrl, {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade'
        },
        signal: controller.signal
      });

      const response = await this.config.stub!.fetch(request);

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

      this.logger.debug('WebSocket connected via fetch', {
        url: this.config.wsUrl
      });
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
      const timeoutMs = this.config.connectTimeoutMs ?? 30000;
      const timeout = setTimeout(() => {
        this.cleanup();
        reject(new Error(`WebSocket connection timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        this.ws = new WebSocket(this.config.wsUrl!);

        // One-time open handler for connection
        const onOpen = () => {
          clearTimeout(timeout);
          this.ws?.removeEventListener('open', onOpen);
          this.ws?.removeEventListener('error', onConnectError);
          this.state = 'connected';
          this.logger.debug('WebSocket connected', { url: this.config.wsUrl });
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
   * Send a request and wait for response
   */
  private async request<T>(
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
      const timeoutMs = this.config.requestTimeoutMs ?? 120000;
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(`Request timeout after ${timeoutMs}ms: ${method} ${path}`)
        );
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (response: WSResponse) => {
          clearTimeout(timeoutId);
          this.pendingRequests.delete(id);
          resolve({ status: response.status, body: response.body as T });
        },
        reject: (error: Error) => {
          clearTimeout(timeoutId);
          this.pendingRequests.delete(id);
          reject(error);
        },
        isStreaming: false,
        timeoutId
      });

      try {
        this.send(request);
      } catch (error) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Send a streaming request and return a ReadableStream
   *
   * The stream will receive data chunks as they arrive over the WebSocket.
   * Format matches SSE for compatibility with existing streaming code.
   *
   * This method waits for the first message before returning. If the server
   * responds with an error (non-streaming response), it throws immediately
   * rather than returning a stream that will error later.
   */
  private async requestStream(
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

    // We need to wait for the first message to determine if this is a streaming
    // response or an immediate error. This prevents returning a stream that will
    // error on first read.
    return new Promise((resolveStream, rejectStream) => {
      let streamController: ReadableStreamDefaultController<Uint8Array>;
      let firstMessageReceived = false;

      const timeoutMs = this.config.requestTimeoutMs ?? 120000;
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        const error = new Error(
          `Stream timeout after ${timeoutMs}ms: ${method} ${path}`
        );
        if (firstMessageReceived) {
          streamController?.error(error);
        } else {
          rejectStream(error);
        }
      }, timeoutMs);

      // Create the stream but don't return it until we get the first message
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          streamController = controller;
        },
        cancel: () => {
          const pending = this.pendingRequests.get(id);
          if (pending?.timeoutId) {
            clearTimeout(pending.timeoutId);
          }
          this.pendingRequests.delete(id);
        }
      });

      this.pendingRequests.set(id, {
        resolve: (response: WSResponse) => {
          clearTimeout(timeoutId);
          this.pendingRequests.delete(id);

          if (!firstMessageReceived) {
            // First message is a final response (not streaming) - this is an error case
            firstMessageReceived = true;
            if (response.status >= 400) {
              rejectStream(
                new Error(
                  `Stream error: ${response.status} - ${JSON.stringify(response.body)}`
                )
              );
            } else {
              // Successful non-streaming response - close immediately
              streamController?.close();
              resolveStream(stream);
            }
          } else {
            // Stream was already returned, now closing
            if (response.status >= 400) {
              streamController?.error(
                new Error(
                  `Stream error: ${response.status} - ${JSON.stringify(response.body)}`
                )
              );
            } else {
              streamController?.close();
            }
          }
        },
        reject: (error: Error) => {
          clearTimeout(timeoutId);
          this.pendingRequests.delete(id);
          if (firstMessageReceived) {
            streamController?.error(error);
          } else {
            rejectStream(error);
          }
        },
        streamController: undefined, // Set after first chunk
        isStreaming: true,
        timeoutId,
        // Custom handler for first stream chunk
        onFirstChunk: () => {
          if (!firstMessageReceived) {
            firstMessageReceived = true;
            // Update the pending request with the actual controller
            const pending = this.pendingRequests.get(id);
            if (pending) {
              pending.streamController = streamController;
            }
            resolveStream(stream);
          }
        }
      });

      try {
        this.send(request);
      } catch (error) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(id);
        rejectStream(error instanceof Error ? error : new Error(String(error)));
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
    if (!pending) {
      this.logger.warn('Received stream chunk for unknown request', {
        id: chunk.id
      });
      return;
    }

    // Call onFirstChunk if this is the first chunk (triggers stream return)
    if (pending.onFirstChunk) {
      pending.onFirstChunk();
      pending.onFirstChunk = undefined; // Only call once
    }

    // streamController may not be set yet if onFirstChunk just resolved
    if (!pending.streamController) {
      this.logger.warn('Stream chunk received but controller not ready', {
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
      // Stream was cancelled or errored - clean up the pending request
      this.logger.debug('Failed to enqueue stream chunk, cleaning up', {
        id: chunk.id,
        error: error instanceof Error ? error.message : String(error)
      });
      // Clear timeout and remove from pending requests
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      this.pendingRequests.delete(chunk.id);
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

    const closeError = new Error(
      `WebSocket closed: ${event.code} ${event.reason || 'No reason'}`
    );

    // Reject all pending requests, clear their timeouts, and error their stream controllers
    for (const [, pending] of this.pendingRequests) {
      // Clear timeout first to prevent memory leak
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      // Error stream controller if it exists
      if (pending.streamController) {
        try {
          pending.streamController.error(closeError);
        } catch {
          // Stream may already be closed/errored
        }
      }
      pending.reject(closeError);
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
    // Clear all pending request timeouts before clearing the map
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
    }
    this.pendingRequests.clear();
  }
}
