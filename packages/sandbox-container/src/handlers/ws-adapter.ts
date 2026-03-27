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
  parseSSEFrames,
  type SSEPartialEvent,
  type WSError,
  type WSRequest,
  type WSResponse,
  type WSServerMessage,
  type WSStreamChunk
} from '@repo/shared';
import type { ServerWebSocket } from 'bun';
import { CONFIG } from '../config';
import type { Router } from '../core/router';

/**
 * WebSocket data attached to each connection
 */
export interface WSData {
  /** Connection ID for logging */
  connectionId: string;
}

function isCancelMessage(
  value: unknown
): value is { type: 'cancel'; id: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.type === 'cancel' && typeof candidate.id === 'string';
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
  /** Track active streaming responses for explicit client-side cancellation */
  private activeStreams: Map<
    string,
    {
      connectionId: string;
      cancel: () => Promise<void>;
    }
  > = new Map();

  constructor(router: Router, logger: Logger) {
    this.router = router;
    this.logger = logger.child({ component: 'container' });
  }

  /**
   * Handle WebSocket connection open
   */
  onOpen(_ws: ServerWebSocket<WSData>): void {
    // Lifecycle captured in onClose canonical log line
  }

  /**
   * Handle WebSocket connection close — canonical log line for connection lifecycle
   */
  onClose(ws: ServerWebSocket<WSData>, code: number, reason: string): void {
    const connectionId = ws.data.connectionId;
    this.logger.debug('ws.connection', {
      connectionId,
      code,
      reason,
      outcome: 'closed'
    });

    for (const [requestId, stream] of this.activeStreams) {
      if (stream.connectionId !== connectionId) {
        continue;
      }

      void stream.cancel().catch((error) => {
        this.logger.debug('Failed to cancel stream on socket close', {
          requestId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      this.activeStreams.delete(requestId);
    }
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

    if (isCancelMessage(parsed)) {
      await this.handleCancel(parsed.id, ws.data.connectionId);
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

    try {
      await this.handleRequest(ws, request);
    } catch (error) {
      this.logger.error(
        'ws.request',
        error instanceof Error ? error : new Error(String(error)),
        {
          connectionId: ws.data.connectionId,
          requestId: request.id,
          method: request.method,
          path: request.path
        }
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
   * Handle explicit cancellation for an in-flight streaming request.
   */
  private async handleCancel(
    requestId: string,
    connectionId: string
  ): Promise<void> {
    const stream = this.activeStreams.get(requestId);
    if (!stream || stream.connectionId !== connectionId) {
      this.logger.debug('Cancel received for unknown stream request', {
        requestId,
        connectionId
      });
      return;
    }

    this.activeStreams.delete(requestId);
    try {
      await stream.cancel();
      this.logger.debug('Cancelled active stream request', { requestId });
    } catch (error) {
      this.logger.debug('Failed to cancel active stream request', {
        requestId,
        error: error instanceof Error ? error.message : String(error)
      });
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
    const url = `http://localhost:${CONFIG.SERVER_PORT}${request.path}`;

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
      // CRITICAL: We must capture the Response body reader BEFORE the promise starts executing
      // asynchronously. If we call getReader() inside handleStreamingResponse after an await,
      // Bun's WebSocket handler may GC or invalidate the Response body when onMessage returns.
      // By getting the reader synchronously here, we ensure the stream remains valid.
      const reader =
        httpResponse.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;

      // Register cancellation immediately after reader acquisition so socket-close
      // cleanup can always find and cancel this stream.
      this.activeStreams.set(request.id, {
        connectionId: ws.data.connectionId,
        cancel: async () => {
          try {
            await reader.cancel();
          } catch {
            // Reader may already be closed/cancelled.
          }
        }
      });

      void this.handleStreamingResponseWithReader(
        ws,
        request.id,
        httpResponse.status,
        reader
      )
        .catch((error: unknown) => {
          this.logger.error(
            'Error in streaming response',
            error instanceof Error ? error : new Error(String(error)),
            { requestId: request.id }
          );
        })
        .finally(() => {
          this.activeStreams.delete(request.id);
        });
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
   * Handle a streaming (SSE) HTTP response with a pre-acquired reader
   *
   * This variant receives the reader instead of the Response, allowing the caller
   * to acquire the reader synchronously before any await points. This is critical
   * for WebSocket streaming because Bun's message handler may invalidate the
   * Response body if the reader is acquired after the handler returns.
   */
  private async handleStreamingResponseWithReader(
    ws: ServerWebSocket<WSData>,
    requestId: string,
    status: number,
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    // Track partial event state across chunks
    let currentEvent: SSEPartialEvent = { data: [] };
    let chunkCount = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        chunkCount++;

        // Decode chunk and add to buffer
        const chunkText = decoder.decode(value, { stream: true });
        buffer += chunkText;

        // Parse SSE events from buffer, preserving partial event state
        const result = parseSSEFrames(buffer, currentEvent);
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

      this.logger.debug('Completed streaming response handler', {
        requestId,
        chunkCount
      });

      // Send final response to close the stream
      const wsResponse: WSResponse = {
        type: 'response',
        id: requestId,
        status,
        done: true
      };
      this.send(ws, wsResponse);
    } catch (error) {
      // Cancellation removes the request from activeStreams before reader.cancel().
      if (!this.activeStreams.has(requestId)) {
        this.logger.debug('Stream cancelled', { requestId });
        return;
      }

      this.logger.error(
        'ws.stream',
        error instanceof Error ? error : new Error(String(error)),
        { connectionId: ws.data.connectionId, requestId }
      );
      this.sendError(
        ws,
        requestId,
        'STREAM_ERROR',
        error instanceof Error ? error.message : 'Stream read failed',
        500
      );
    } finally {
      await reader.cancel().catch(() => {
        // Reader may already be closed/cancelled.
      });
      reader.releaseLock();
    }
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
        'ws.send',
        error instanceof Error ? error : new Error(String(error)),
        { connectionId: ws.data.connectionId }
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
