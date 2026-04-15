/**
 * Wire types and configuration types for the Cloudflare Sandbox Bridge.
 *
 * These types define the JSON payloads exchanged between HTTP clients
 * (e.g. the Python `CloudflareSandboxClient`) and the bridge worker.
 */

import type { Sandbox } from '../sandbox';

// ---------------------------------------------------------------------------
// Bridge configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for the bridge() factory.
 */
export interface BridgeConfig {
  /**
   * Override the default binding names used to look up Durable Objects.
   *
   * @default { sandbox: "Sandbox", warmPool: "WarmPool" }
   */
  bindings?: {
    /** Name of the Sandbox Durable Object binding. @default "Sandbox" */
    sandbox?: string;
    /** Name of the WarmPool Durable Object binding. @default "WarmPool" */
    warmPool?: string;
  };
  /**
   * URL prefix for all bridge API routes.
   *
   * @default "/v1"
   */
  apiRoutePrefix?: string;
  /**
   * Path for the health-check endpoint.
   *
   * @default "/health"
   */
  healthRoute?: string;
}

/**
 * The user-provided worker handlers that bridge() wraps.
 *
 * The bridge wraps `fetch` and `scheduled` with its own logic;
 * all other properties are passed through unchanged.
 */
export interface WorkerHandlers {
  fetch?(
    request: Request,
    env: any,
    ctx: ExecutionContext
  ): Response | Promise<Response>;
  scheduled?(
    controller: ScheduledController,
    env: any,
    ctx: ExecutionContext
  ): void | Promise<void>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Environment type
// ---------------------------------------------------------------------------

/**
 * Minimum environment shape required by the bridge.
 * The actual bindings are looked up dynamically by name.
 */
export interface BridgeEnv {
  SANDBOX_API_KEY?: string;
  WARM_POOL_TARGET?: string;
  WARM_POOL_REFRESH_INTERVAL?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// JSON wire types — shared between HTTP clients and this worker
// ---------------------------------------------------------------------------

/** Sent by the client for /exec requests. */
export interface ExecRequest {
  /** Argv array — already shell-expanded by the client layer if shell=True. */
  argv: string[];
  /** Per-call timeout in milliseconds (optional). */
  timeout_ms?: number;
  /** Working directory for the command (optional, defaults to sandbox cwd). */
  cwd?: string;
}

/** Returned by /write on success. */
export interface WriteResponse {
  ok: true;
}

/** Returned by /running. */
export interface RunningResponse {
  running: boolean;
}

/** Returned by all error paths. */
export interface ErrorResponse {
  error: string;
  /** Stable machine-readable code; mirrors UC ErrorCode values where possible. */
  code: string;
}

/** Credentials for mounting an S3-compatible bucket. */
export interface MountBucketCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Options nested inside a MountBucketRequest. */
export interface MountBucketRequestOptions {
  /** S3-compatible endpoint URL (required). */
  endpoint: string;
  /** Mount filesystem as read-only (default: false). */
  readOnly?: boolean;
  /** Optional prefix/subdirectory within the bucket to mount. */
  prefix?: string;
  /** Explicit credentials. Omit to use auto-detected Worker secrets. */
  credentials?: MountBucketCredentials;
}

/** Sent by the client for /mount requests. */
export interface MountBucketRequest {
  /** Bucket name. */
  bucket: string;
  /** Absolute path in the container to mount at. */
  mountPath: string;
  /** Mount configuration. */
  options: MountBucketRequestOptions;
}

/** Sent by the client for /unmount requests. */
export interface UnmountBucketRequest {
  /** Absolute path where the bucket is currently mounted. */
  mountPath: string;
}
