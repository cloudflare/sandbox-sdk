/**
 * Wire types and configuration types for the Cloudflare Sandbox Bridge.
 *
 * These types define the JSON payloads exchanged between HTTP clients
 * (e.g. the Python `CloudflareSandboxClient`) and the bridge worker.
 */

import type {
  BucketCredentials,
  MountBucketOptions,
  R2BindingMountBucketOptions,
  RemoteMountBucketOptions
} from '@repo/shared';
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

/** Sent by the client to launch a process. */
export interface ExecRequest {
  /** Argv array — already shell-expanded by the client layer if shell=True. */
  argv: [string, ...string[]];
  /**
   * Remote process lifetime deadline in milliseconds. When reached, the
   * sandbox may stop the process and the process exit outcome reports
   * `timedOut: true`; this is not caller-local observation cancellation.
   */
  timeout?: number;
  /** Working directory for the command (optional, defaults to sandbox cwd). */
  cwd?: string;
  /** Environment overrides for the command. */
  env?: Record<string, string>;
}

/** Returned by /write on success. */
export interface WriteResponse {
  ok: true;
}

/** Returned by /running. */
export interface RunningResponse {
  running: boolean;
}

/** Sent by the client for tunnel creation requests. */
export interface TunnelRequest {
  /** Subdomain prefix for a named tunnel, such as "app". */
  name?: string;
}

/** Returned by all error paths. */
export interface ErrorResponse {
  error: string;
  /** Stable machine-readable code; mirrors UC ErrorCode values where possible. */
  code: string;
}

/** JSON mount options accepted by the bridge; mirrors the SDK mount option variants. */
export type MountBucketRequestOptions =
  | Pick<
      RemoteMountBucketOptions,
      | 'endpoint'
      | 'readOnly'
      | 'prefix'
      | 'credentials'
      | 's3fsOptions'
      | 'credentialProxy'
    >
  | Pick<R2BindingMountBucketOptions, 'readOnly' | 'prefix' | 's3fsOptions'>;

export type {
  BucketCredentials as MountBucketCredentials,
  MountBucketOptions,
  R2BindingMountBucketOptions,
  RemoteMountBucketOptions
};

/** Sent by the client for /mount requests. */
export interface MountBucketRequest {
  /** Remote bucket name for endpoint-based S3-compatible mounts. */
  bucket?: string;
  /** Worker R2 binding name for credential-less R2 binding mounts. */
  binding?: string;
  /** Absolute path in the container to mount at. */
  mountPath: string;
  /** Mount configuration. Provide `endpoint` for remote mounts or `binding` for R2 binding mounts. */
  options: MountBucketRequestOptions;
}

/** Sent by the client for /unmount requests. */
export interface UnmountBucketRequest {
  /** Absolute path where the bucket is currently mounted. */
  mountPath: string;
}
