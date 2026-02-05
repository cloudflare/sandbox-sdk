/**
 * Connection state for the SandboxAddon.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

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
   * getWebSocketUrl: ({ sandboxId, sessionId }) =>
   *   `/ws/terminal?sandboxId=${sandboxId}&sessionId=${sessionId ?? ''}`
   * ```
   */
  getWebSocketUrl: (params: {
    sandboxId: string;
    sessionId?: string;
  }) => string;

  /**
   * Sandbox ID to connect to.
   */
  sandboxId: string;

  /**
   * Session ID (optional).
   * If omitted, uses the sandbox's default session.
   */
  sessionId?: string;

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
