// packages/sandbox/src/opencode/types.ts
import type { Logger, Process } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';

/**
 * Configuration options for starting OpenCode server
 * Uses OpencodeConfig from @opencode-ai/sdk for provider configuration
 */
export interface OpencodeOptions {
  /** Port for OpenCode server (default: 4096) */
  port?: number;
  /** OpenCode configuration - passed via OPENCODE_CONFIG_CONTENT env var */
  config?: Record<string, unknown>;
  /** Logger for debug output */
  logger?: Logger;
}

/**
 * Server lifecycle management
 */
export interface OpencodeServer {
  /** Port the server is running on */
  port: number;
  /** Base URL for SDK client (http://localhost:{port}) */
  url: string;
  /** Underlying Sandbox process handle */
  process: Process;
  /** Stop the server gracefully */
  stop(): Promise<void>;
}

/**
 * Result from createOpencode()
 * Client type comes from @opencode-ai/sdk (user's version)
 */
export interface OpencodeResult<TClient = unknown> {
  /** OpenCode SDK client with Sandbox transport */
  client: TClient;
  /** Server lifecycle management */
  server: OpencodeServer;
}

/**
 * Options for proxyToOpencode()
 */
export interface ProxyToOpencodeOptions {
  /** Port for OpenCode server (default: 4096) */
  port?: number;
  /** OpenCode configuration - passed via OPENCODE_CONFIG_CONTENT env var */
  config?: Record<string, unknown>;
  /** Logger for debug output */
  logger?: Logger;
}

/**
 * Error thrown when OpenCode server fails to start
 */
export class OpencodeStartupError extends Error {
  public readonly code = ErrorCode.OPENCODE_STARTUP_FAILED;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OpencodeStartupError';
  }
}
