/**
 * WebSocket transport protocol types
 *
 * Enables multiplexing HTTP-like requests over a single WebSocket connection.
 * This reduces sub-request count when running inside Workers/Durable Objects.
 *
 * Protocol:
 * - Client sends WSRequest messages
 * - Server responds with WSResponse messages (matched by id)
 * - For streaming endpoints, server sends multiple WSStreamChunk messages
 *   followed by a final WSResponse
 */

/**
 * HTTP methods supported over WebSocket
 */
export type WSMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * WebSocket request message sent from client to server
 */
export interface WSRequest {
  /** Message type discriminator */
  type: 'request';

  /** Unique request ID for response matching */
  id: string;

  /** HTTP method */
  method: WSMethod;

  /** Request path (e.g., '/api/execute', '/api/read') */
  path: string;

  /** Request body (for POST/PUT requests) */
  body?: unknown;

  /** Request headers (optional, for special cases) */
  headers?: Record<string, string>;
}

/**
 * WebSocket response message sent from server to client
 */
export interface WSResponse {
  /** Message type discriminator */
  type: 'response';

  /** Request ID this response corresponds to */
  id: string;

  /** HTTP status code */
  status: number;

  /** Response body (JSON parsed) */
  body?: unknown;

  /** Whether this is the final response (for streaming, false until complete) */
  done: boolean;
}

/**
 * WebSocket stream chunk for streaming responses (SSE replacement)
 * Sent for streaming endpoints like /api/execute/stream, /api/read/stream
 */
export interface WSStreamChunk {
  /** Message type discriminator */
  type: 'stream';

  /** Request ID this chunk belongs to */
  id: string;

  /** Stream event type (matches SSE event types) */
  event?: string;

  /** Chunk data */
  data: string;
}

/**
 * WebSocket error response
 */
export interface WSError {
  /** Message type discriminator */
  type: 'error';

  /** Request ID this error corresponds to (if available) */
  id?: string;

  /** Error code */
  code: string;

  /** Error message */
  message: string;

  /** HTTP status code equivalent */
  status: number;

  /** Additional error context */
  context?: Record<string, unknown>;
}

/**
 * Union type for all WebSocket messages from server to client
 */
export type WSServerMessage = WSResponse | WSStreamChunk | WSError;

/**
 * PTY input message - send keystrokes to PTY (fire-and-forget)
 */
export interface WSPtyInput {
  type: 'pty_input';
  ptyId: string;
  data: string;
}

/**
 * PTY resize message - resize terminal (fire-and-forget)
 */
export interface WSPtyResize {
  type: 'pty_resize';
  ptyId: string;
  cols: number;
  rows: number;
}

/**
 * Type guard for WSPtyInput
 */
export function isWSPtyInput(msg: unknown): msg is WSPtyInput {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as WSPtyInput).type === 'pty_input'
  );
}

/**
 * Type guard for WSPtyResize
 */
export function isWSPtyResize(msg: unknown): msg is WSPtyResize {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as WSPtyResize).type === 'pty_resize'
  );
}

/**
 * Union type for all WebSocket messages from client to server
 */
export type WSClientMessage = WSRequest | WSPtyInput | WSPtyResize;

/**
 * Type guard for WSRequest
 *
 * Note: Only validates the discriminator field (type === 'request').
 * Does not validate other required fields (id, method, path).
 * Use for routing messages; trust TypeScript for field validation.
 */
export function isWSRequest(msg: unknown): msg is WSRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as WSRequest).type === 'request'
  );
}

/**
 * Type guard for WSResponse
 *
 * Note: Only validates the discriminator field (type === 'response').
 */
export function isWSResponse(msg: unknown): msg is WSResponse {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as WSResponse).type === 'response'
  );
}

/**
 * Type guard for WSStreamChunk
 *
 * Note: Only validates the discriminator field (type === 'stream').
 */
export function isWSStreamChunk(msg: unknown): msg is WSStreamChunk {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as WSStreamChunk).type === 'stream'
  );
}

/**
 * Type guard for WSError
 *
 * Note: Only validates the discriminator field (type === 'error').
 */
export function isWSError(msg: unknown): msg is WSError {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as WSError).type === 'error'
  );
}

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
  return `ws_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}
