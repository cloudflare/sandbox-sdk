/**
 * Connection state for the SandboxAddon.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

/**
 * Connection target for the SandboxAddon.
 */
export interface ConnectionTarget {
  sandboxId: string;
  sessionId?: string;
}

/**
 * Options for creating a SandboxAddon.
 */
export interface SandboxAddonOptions {
  /**
   * Build WebSocket URL for connection.
   * Called on every connection attempt.
   *
   * @example
   * ```typescript
   * getWebSocketUrl: ({ origin, sessionId }) =>
   *   `${origin}/ws/terminal/${sessionId ?? ''}`
   * ```
   */
  getWebSocketUrl: (params: {
    sandboxId: string;
    sessionId?: string;
    /** WebSocket origin derived from `window.location` (e.g. `wss://example.com`). */
    origin: string;
  }) => string;

  /**
   * Whether to automatically reconnect on disconnection.
   * Uses exponential backoff with jitter.
   * @default true
   */
  reconnect?: boolean;

  /**
   * Called when connection state changes.
   * Use this to update your UI (spinners, overlays, etc).
   *
   * @param state - The new connection state
   * @param error - Error details if state change was due to an error
   */
  onStateChange?: (state: ConnectionState, error?: Error) => void;
}
