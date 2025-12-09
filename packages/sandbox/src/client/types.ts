import type { ISandbox } from '@repo/shared';

export interface ClientOptions {
  /** API key for authentication (or set SANDBOX_API_KEY env var) */
  apiKey?: string;
  /** Bridge Worker URL (or set SANDBOX_BRIDGE_URL env var) */
  baseUrl?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /**
   * Custom headers to include in all requests.
   * Useful for:
   * - X-Sandbox-Type: Select container type (e.g., 'python')
   * - X-Sandbox-KeepAlive: Keep sandbox alive ('true')
   * - X-Session-Id: Default session for all requests
   */
  headers?: Record<string, string>;
}

export interface SandboxClient extends ISandbox {
  readonly id: string;
}
