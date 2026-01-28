import type { Config } from '@opencode-ai/sdk/v2';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { ErrorCode, type OpencodeStartupContext } from '@repo/shared/errors';

/**
 * Configuration options for starting OpenCode server
 */
export interface OpencodeOptions {
  /** Port for OpenCode server (default: 4096) */
  port?: number;
  /** Working directory for OpenCode (default: container's cwd) */
  directory?: string;
  /** OpenCode configuration */
  config?: Config;
}

/**
 * Server lifecycle management
 */
export interface OpencodeServer {
  /** Port the server is running on */
  port: number;
  /** Base URL for SDK client (http://localhost:{port}) */
  url: string;
  /** Close the server gracefully */
  close(): Promise<void>;
}

/**
 * Result from createOpencode()
 * Client type comes from @opencode-ai/sdk (user's version)
 */
export interface OpencodeResult<TClient = OpencodeClient> {
  /** OpenCode SDK client with Sandbox transport */
  client: TClient;
  /** Server lifecycle management */
  server: OpencodeServer;
}

/**
 * Error thrown when OpenCode server fails to start
 */
export class OpencodeStartupError extends Error {
  public readonly code = ErrorCode.OPENCODE_STARTUP_FAILED;
  public readonly context: OpencodeStartupContext;

  constructor(
    message: string,
    context: OpencodeStartupContext,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'OpencodeStartupError';
    this.context = context;
  }
}
