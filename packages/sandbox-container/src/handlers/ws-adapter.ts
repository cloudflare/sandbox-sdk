/**
 * WebSocket Protocol Adapter for Container
 *
 * Adapts WebSocket messages to HTTP requests for routing through existing handlers.
 * This enables multiplexing multiple requests over a single WebSocket connection,
 * reducing sub-request count when the SDK runs inside Workers/Durable Objects.
 */

import type { Logger } from '@repo/shared';
import {
  isWSPtyInput,
  isWSPtyResize,
  isWSRequest,
  type WSError,
  type WSRequest,
  type WSResponse,
  type WSServerMessage,
  type WSStreamChunk
} from '@repo/shared';
import type { ServerWebSocket } from 'bun';
import type { Router } from '../core/router';
import type { PtyManager } from '../managers/pty-manager';

/** Container server port - must match SERVER_PORT in server.ts */
const SERVER_PORT = 3000;

/**
 * WebSocket data attached to each connection
 */
export interface WSData {
  /** Connection ID for logging */
  connectionId: string;
}

/**
 * WebSocket protocol adapter that bridges WebSocket messages to HTTP handlers
 *
 * Converts incoming WebSocket requests to HTTP Request objects and routes them
 * through the standard router. Supports both regular responses and SSE streaming.
 */
export class WebSocketAdapter {
  private router: Router;
  private ptyManager: PtyManager;
  private logger: Logger;

  constructor(router: Router, ptyManager: PtyManager, logger: Logger) {
    this.router = router;
    this.ptyManager = ptyManager;
    this.logger = logger.child({ component: 'container' });
  }

  /**
   * Handle WebSocket connection open
   */
  onOpen(ws: ServerWebSocket<WSData>): void {
    this.logger.debug('WebSocket connection opened', {
      connectionId: ws.data.connectionId
    });
  }

  /**
   * Handle WebSocket connection close
   */
  onClose(ws: ServerWebSocket<WSData>, code: number, reason: string): void {
    this.logger.debug('WebSocket connection closed', {
      connectionId: ws.data.connectionId,
      code,
      reason
    });
  }

  /**
   * Handle incoming WebSocket message
   */
  async onMessage(
    ws: ServerWebSocket<WSData>,
    message: string | Buffer
  ): Promise<void> {
    const messageStr =
      typeof message === 'string' ? message : message.toString('utf-8');

    let parsed: unknown;
    try {
      parsed = JSON.parse(messageStr);
    } catch (error) {
      this.sendError(ws, undefined, 'PARSE_ERROR', 'Invalid JSON message', 400);
      return;
    }

    // Handle PTY input messages
    if (isWSPtyInput(parsed)) {
      const result = this.ptyManager.write(parsed.ptyId, parsed.data);
      if (!result.success) {
        this.sendError(
          ws,
          parsed.ptyId,
          'PTY_ERROR',
          result.error ?? 'PTY write failed',
          400
        );
      }
      return;
    }

    // Handle PTY resize messages
    if (isWSPtyResize(parsed)) {
      const result = this.ptyManager.resize(
        parsed.ptyId,
        parsed.cols,
        parsed.rows
      );
      if (!result.success) {
        this.sendError(
          ws,
          parsed.ptyId,
          'PTY_ERROR',
          result.error ?? 'PTY resize failed',
          400
        );
      }
      return;
    }

    if (!isWSRequest(parsed)) {
      this.sendError(
        ws,
        undefined,
        'INVALID_REQUEST',
        'Message must be a valid WSRequest',
        400
      );
      return;
    }

    const request = parsed as WSRequest;

    this.logger.debug('WebSocket request received', {
      connectionId: ws.data.connectionId,
      id: request.id,
      method: request.method,
      path: request.path
    });

    try {
      await this.handleRequest(ws, request);
    } catch (error) {
      this.logger.error(
        'Error handling WebSocket request',
        error instanceof Error ? error : new Error(String(error)),
        { requestId: request.id }
      );
      this.sendError(
        ws,
        request.id,
        'INTERNAL_ERROR',
        error instanceof Error ? error.message : 'Unknown error',
        500
      );
    }
  }

  /**
   * Handle a WebSocket request by routing it to HTTP handlers
   */
  private async handleRequest(
    ws: ServerWebSocket<WSData>,
    request: WSRequest
  ): Promise<void> {
    // Build URL for the request
    const url = `http://localhost:${SERVER_PORT}${request.path}`;

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...request.headers
    };

    // Build request options
    const requestInit: RequestInit = {
      method: request.method,
      headers
    };

    // Add body for POST/PUT
    if (
      request.body !== undefined &&
      (request.method === 'POST' || request.method === 'PUT')
    ) {
      requestInit.body = JSON.stringify(request.body);
    }

    // Create a fetch Request object
    const httpRequest = new Request(url, requestInit);

    // Route through the existing router
    const httpResponse = await this.router.route(httpRequest);

    // Check if this is a streaming response
    const contentType = httpResponse.headers.get('Content-Type') || '';
    const isStreaming = contentType.includes('text/event-stream');

    if (isStreaming && httpResponse.body) {
      // Handle SSE streaming response
      await this.handleStreamingResponse(ws, request.id, httpResponse);
    } else {
      // Handle regular response
      await this.handleRegularResponse(ws, request.id, httpResponse);
    }
  }

  /**
   * Handle a regular (non-streaming) HTTP response
   */
  private async handleRegularResponse(
    ws: ServerWebSocket<WSData>,
    requestId: string,
    response: Response
  ): Promise<void> {
    let body: unknown;

    try {
      const text = await response.text();
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }

    const wsResponse: WSResponse = {
      type: 'response',
      id: requestId,
      status: response.status,
      body,
      done: true
    };

    this.send(ws, wsResponse);
  }

  /**
   * Handle a streaming (SSE) HTTP response
   */
  private async handleStreamingResponse(
    ws: ServerWebSocket<WSData>,
    requestId: string,
    response: Response
  ): Promise<void> {
    if (!response.body) {
      this.sendError(ws, requestId, 'STREAM_ERROR', 'No response body', 500);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        // Decode chunk and add to buffer
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const events = this.parseSSEEvents(buffer);
        buffer = events.remaining;

        // Send each parsed event as a stream chunk
        for (const event of events.events) {
          const chunk: WSStreamChunk = {
            type: 'stream',
            id: requestId,
            event: event.event,
            data: event.data
          };
          if (!this.send(ws, chunk)) {
            return; // Connection dead, stop processing
          }
        }
      }

      // Send final response to close the stream
      const wsResponse: WSResponse = {
        type: 'response',
        id: requestId,
        status: response.status,
        done: true
      };
      this.send(ws, wsResponse);
    } catch (error) {
      this.logger.error(
        'Error reading stream',
        error instanceof Error ? error : new Error(String(error)),
        { requestId }
      );
      this.sendError(
        ws,
        requestId,
        'STREAM_ERROR',
        error instanceof Error ? error.message : 'Stream read failed',
        500
      );
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse SSE events from a buffer
   *
   * Returns parsed events and any remaining unparsed content (incomplete lines
   * waiting for more data from the next chunk).
   *
   * Note: This is a minimal SSE parser that only handles `event:` and `data:`
   * fields - sufficient for our streaming handlers which only emit these.
   * Per the SSE spec, we intentionally ignore:
   * - `id:` field (event IDs for reconnection)
   * - `retry:` field (reconnection timing hints)
   * - Comment lines (starting with `:`)
   */
  private parseSSEEvents(buffer: string): {
    events: Array<{ event?: string; data: string }>;
    remaining: string;
  } {
    const events: Array<{ event?: string; data: string }> = [];
    let currentEvent: { event?: string; data: string[] } = { data: [] };
    let i = 0;

    while (i < buffer.length) {
      const newlineIndex = buffer.indexOf('\n', i);
      if (newlineIndex === -1) break; // Incomplete line, keep in buffer

      const line = buffer.substring(i, newlineIndex);
      i = newlineIndex + 1;

      // Check if we have a complete event (empty line after data)
      if (line === '' && currentEvent.data.length > 0) {
        events.push({
          event: currentEvent.event,
          data: currentEvent.data.join('\n')
        });
        currentEvent = { data: [] };
        continue;
      }

      if (line.startsWith('event:')) {
        currentEvent.event = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        currentEvent.data.push(line.substring(5).trim());
      }
      // Other lines (including empty lines without pending data) are ignored
    }

    return {
      events,
      remaining: buffer.substring(i)
    };
  }

  /**
   * Send a message over WebSocket
   * @returns true if send succeeded, false if it failed (connection will be closed)
   */
  private send(ws: ServerWebSocket<WSData>, message: WSServerMessage): boolean {
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.logger.error(
        'Failed to send WebSocket message, closing connection',
        error instanceof Error ? error : new Error(String(error))
      );
      try {
        ws.close(1011, 'Send failed'); // 1011 = unexpected condition
      } catch {
        // Connection already closed
      }
      return false;
    }
  }

  /**
   * Send an error message over WebSocket
   */
  private sendError(
    ws: ServerWebSocket<WSData>,
    requestId: string | undefined,
    code: string,
    message: string,
    status: number
  ): void {
    const error: WSError = {
      type: 'error',
      id: requestId,
      code,
      message,
      status
    };
    this.send(ws, error);
  }

  /**
   * Register PTY output listener for a WebSocket connection
   * Returns cleanup function to unsubscribe from PTY events
   *
   * Auto-unsubscribes when send fails to prevent resource leaks
   * from repeatedly attempting to send to a dead connection.
   */
  registerPtyListener(ws: ServerWebSocket<WSData>, ptyId: string): () => void {
    let unsubData: (() => void) | null = null;
    let unsubExit: (() => void) | null = null;

    const cleanup = () => {
      unsubData?.();
      unsubExit?.();
      unsubData = null;
      unsubExit = null;
    };

    unsubData = this.ptyManager.onData(ptyId, (data) => {
      const chunk: WSStreamChunk = {
        type: 'stream',
        id: ptyId,
        event: 'pty_data',
        data
      };
      if (!this.send(ws, chunk)) {
        cleanup(); // Send failed, stop trying
      }
    });

    unsubExit = this.ptyManager.onExit(ptyId, (exitCode) => {
      const chunk: WSStreamChunk = {
        type: 'stream',
        id: ptyId,
        event: 'pty_exit',
        data: JSON.stringify({ exitCode })
      };
      if (!this.send(ws, chunk)) {
        cleanup(); // Send failed, stop trying
      }
    });

    return cleanup;
  }
}

/**
 * Generate a unique connection ID
 */
export function generateConnectionId(): string {
  return `conn_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}
