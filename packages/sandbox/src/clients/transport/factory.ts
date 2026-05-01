import { HttpTransport } from './http-transport';
import type { ITransport, RouteTransportMode, TransportConfig } from './types';
import { WebSocketTransport } from './ws-transport';

/**
 * Transport options with mode selection
 */
export interface TransportOptions extends TransportConfig {
  /** Route-based transport mode */
  mode: RouteTransportMode;
}

/**
 * Create a route-based compatibility transport instance based on mode.
 *
 * Selects the HTTP or custom WebSocket transport for the route-based client
 * layer.
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
    case 'http':
      return new HttpTransport(options);
    case 'websocket':
      return new WebSocketTransport(options);
  }
}
