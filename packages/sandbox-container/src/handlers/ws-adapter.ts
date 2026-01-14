/**
 * WebSocket Protocol Adapter for Container
 *
 * Adapts WebSocket messages to HTTP requests for routing through existing handlers.
 * This enables multiplexing multiple requests over a single WebSocket connection,
 * reducing sub-request count when the SDK runs inside Workers/Durable Objects.
 */

import type { Logger } from '@repo/shared';
import {
  isWSRequest,
  type WSError,
  type WSRequest,
  type WSResponse,
  type WSServerMessage,
  type WSStreamChunk
} from '@repo/shared';
import type { ServerWebSocket } from 'bun';
import type { Router } from '../core/router';

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
  private logger: Logger;

  constructor(router: Router, logger: Logger) {
    this.router = router;
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
    // Track partial event state across chunks
    let currentEvent: { event?: string; data: string[] } = { data: [] };

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        // Decode chunk and add to buffer
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer, preserving partial event state
        const result = this.parseSSEEvents(buffer, currentEvent);
        buffer = result.remaining;
        currentEvent = result.currentEvent;

        // Send each parsed event as a stream chunk
        for (const event of result.events) {
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
   * Returns parsed events, remaining unparsed content, and current partial event state.
   * The currentEvent parameter allows preserving state across chunk boundaries.
   *
   * Note: This is a minimal SSE parser that only handles `event:` and `data:`
   * fields - sufficient for our streaming handlers which only emit these.
   * Per the SSE spec, we intentionally ignore:
   * - `id:` field (event IDs for reconnection)
   * - `retry:` field (reconnection timing hints)
   * - Comment lines (starting with `:`)
   */
  private parseSSEEvents(
    buffer: string,
    currentEvent: { event?: string; data: string[] } = { data: [] }
  ): {
    events: Array<{ event?: string; data: string }>;
    remaining: string;
    currentEvent: { event?: string; data: string[] };
  } {
    const events: Array<{ event?: string; data: string }> = [];
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
      remaining: buffer.substring(i),
      currentEvent
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
}

/**
 * Generate a unique connection ID
 */
export function generateConnectionId(): string {
  return `conn_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}
