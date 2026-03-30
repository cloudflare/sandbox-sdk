import { HttpTransport } from './http-transport';
import type { ITransport, TransportConfig, TransportMode } from './types';
import { WebSocketTransport } from './ws-transport';

/**
 * Transport options with mode selection
 */
export interface TransportOptions extends TransportConfig {
  /** Transport mode */
  mode: TransportMode;
}

/**
 * Create a transport instance based on mode
 *
 * This is the primary API for creating transports. It handles
 * the selection of HTTP or WebSocket transport based on the mode.
 *
 * @example
 * ```typescript
 * // HTTP transport (default)
 * const http = createTransport({
 *   mode: 'http',
 *   baseUrl: 'http://localhost:3000'
 * });
 *
 * // WebSocket transport
 * const ws = createTransport({
 *   mode: 'websocket',
 *   wsUrl: 'ws://localhost:3000/ws'
 * });
 * ```
 */
export function createTransport(options: TransportOptions): ITransport {
  switch (options.mode) {
    case 'websocket':
      return new WebSocketTransport(options);

    default:
      return new HttpTransport(options);
  }
}
