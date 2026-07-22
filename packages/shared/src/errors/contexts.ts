import type { OperationType } from './types';

/**
 * File system error contexts
 */
export interface FileNotFoundContext {
  path: string;
  operation: OperationType;
}

export interface FileExistsContext {
  path: string;
  operation: OperationType;
}

export interface FileTooLargeContext {
  path: string;
  operation: OperationType;
  maxSize: number;
  actualSize: number;
}

export interface FileSystemContext {
  path: string;
  operation: OperationType;
  stderr?: string;
  exitCode?: number;
}

/**
 * Command error contexts
 */
export interface CommandNotFoundContext {
  command: string;
}

export interface CommandErrorContext {
  command: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Process error contexts
 */
export interface ProcessNotFoundContext {
  processId: string;
}

export interface ProcessErrorContext {
  processId: string;
  pid?: number;
  exitCode?: number;
  stderr?: string;
}

export interface SessionAlreadyExistsContext {
  sessionId: string;
  /**
   * `CLOUDFLARE_PLACEMENT_ID` captured from the container at the moment the
   * duplicate create was detected. Included so a restarted DO can learn the
   * container's placement ID from an idempotent session-create. `null` when
   * the env var is not set (for example, in local development).
   */
  containerPlacementId?: string | null;
}

export interface SessionDestroyedContext {
  sessionId: string;
}

export interface SessionTerminatedContext {
  sessionId: string;
  exitCode: number | null;
}

/**
 * Process readiness error contexts
 */
export interface ProcessReadyTimeoutContext {
  processId: string;
  command: string;
  condition: string;
  timeout: number;
}

export interface ProcessExitedBeforeReadyContext {
  processId: string;
  command: string;
  condition: string;
  exitCode: number;
}

/**
 * Port error contexts
 */
export interface PortAlreadyExposedContext {
  port: number;
  portName?: string;
}

export interface PortNotExposedContext {
  port: number;
}

export interface InvalidPortContext {
  port: number;
  reason: string;
}

export interface PortErrorContext {
  port: number;
  portName?: string;
  stderr?: string;
}

/**
 * Git error contexts
 */
export interface GitRepositoryNotFoundContext {
  repository: string; // Full URL
}

export interface GitAuthFailedContext {
  repository: string;
}

export interface GitBranchNotFoundContext {
  branch: string;
  repository?: string;
}

export interface GitErrorContext {
  repository?: string;
  branch?: string;
  targetDir?: string;
  stderr?: string;
  exitCode?: number;
}

/**
 * Code interpreter error contexts
 */
export interface InterpreterNotReadyContext {
  retryAfter?: number; // Seconds
  progress?: number; // 0-100
}

export interface ContextNotFoundContext {
  contextId: string;
}

export interface CodeExecutionContext {
  contextId?: string;
  ename?: string; // Error name
  evalue?: string; // Error value
  traceback?: string[]; // Stack trace
}

/**
 * Validation error contexts
 */
export interface ValidationFailedContext {
  validationErrors: Array<{
    field: string;
    message: string;
    code?: string;
  }>;
}

/**
 * Bucket mounting error contexts
 */
export interface BucketMountContext {
  bucket: string;
  mountPath: string;
  endpoint: string;
  stderr?: string;
  exitCode?: number;
}

export interface MissingCredentialsContext {
  bucket: string;
  endpoint: string;
}

export interface InvalidMountConfigContext {
  bucket?: string;
  mountPath?: string;
  endpoint?: string;
  reason?: string;
}

/**
 * Backup error contexts
 */
export interface BackupCreateContext {
  dir: string;
  backupId?: string;
  stderr?: string;
  exitCode?: number;
}

export interface BackupRestoreContext {
  dir: string;
  backupId: string;
  stderr?: string;
  exitCode?: number;
}

export interface BackupNotFoundContext {
  backupId: string;
}

export interface BackupExpiredContext {
  backupId: string;
  expiredAt?: string;
}

export interface InvalidBackupConfigContext {
  reason: string;
}

/**
 * OpenCode error contexts
 */
export interface OpencodeStartupContext {
  port: number;
  stderr?: string;
  command?: string;
}

/**
 * Generic error contexts
 */
export interface InternalErrorContext {
  originalError?: string;
  stack?: string;
  [key: string]: unknown; // Allow extension
}

/**
 * Reason the sandbox container could not accept the incoming RPC connection.
 * Callers may branch on this to distinguish container-startup unavailability
 * from account-level capacity limits. `retryable` is always true regardless
 * of reason.
 */
export type ContainerUnavailableReason =
  /** The container is still booting. */
  | 'container_starting'
  /** The container is temporarily unhealthy. */
  | 'container_unhealthy'
  /** The container was replaced while the connection attempt was in progress. */
  | 'container_replaced'
  /** The WebSocket upgrade retry budget was exhausted. */
  | 'rpc_upgrade_failed'
  /**
   * The Containers platform could not allocate an instance for the Durable
   * Object during connection startup ("There is no container instance that
   * can be provided to this Durable Object, try again later").
   */
  | 'no_container_instance_available'
  /**
   * The account reached its configured concurrent-instance ceiling
   * ("Maximum number of running container instances exceeded. Try again
   * later, or try configuring a higher value for max_instances").
   */
  | 'max_container_instances_exceeded'
  /**
   * The RPC connection was torn down before the container ever became
   * reachable, and the underlying platform cause was not captured (e.g. the
   * Durable Object was evicted mid-startup under capacity pressure). The
   * container was never admitted — this is unavailability, not a cold start
   * in progress.
   */
  | 'container_unreachable';

/**
 * Container availability error context. Surfaced when the sandbox container
 * cannot accept the incoming RPC connection. The container may be starting
 * up, undergoing a runtime replacement, or temporarily unhealthy. The
 * caller should retry the same operation.
 */
export interface ContainerUnavailableContext {
  /**
   * Categorical reason distinguishing startup unavailability from runtime
   * replacement, exhausted upgrade retries, and account capacity limits.
   */
  reason: ContainerUnavailableReason;
  /**
   * Always true — this error represents a transient unavailability, not a
   * permanent failure. Callers should retry the same operation.
   */
  retryable: true;
  /** Suggested delay in milliseconds before the next retry attempt. */
  retryAfterMs?: number;
  /**
   * Original platform/transport error message, preserved verbatim when the
   * unavailability was detected from a lower-level error (e.g. the platform
   * container-allocation failure) rather than a structured response body.
   */
  originalMessage?: string;
}

/**
 * RPC transport error contexts. Surfaced when the capnweb WebSocket session
 * fails on the SDK side rather than the container reporting a structured
 * error. Always retryable — the next call will open a fresh connection.
 */
export type RPCTransportErrorKind =
  /** Server closed the WebSocket (container crash, DO eviction, network blip). */
  | 'peer_closed'
  /** Underlying socket fired the `error` event. */
  | 'connection_failed'
  /** WebSocket upgrade failed before the session was established. */
  | 'upgrade_failed'
  /** Peer sent a non-string frame; capnweb's wire format is JSON text only. */
  | 'invalid_frame'
  /** Peer sent a frame the wire-format parser rejected (capnweb readLoop SyntaxError). */
  | 'protocol_error'
  /** Session was disposed (locally or remotely) while a call was pending. */
  | 'session_disposed'
  /** Anything else that bubbled up from the transport with no recognisable shape. */
  | 'unknown';

export interface RPCTransportContext {
  /** Categorical bucket so callers can branch on `peer_closed` vs `upgrade_failed` etc. */
  kind: RPCTransportErrorKind;
  /** Original error message, verbatim from capnweb / our DeferredTransport. */
  originalMessage: string;
  /**
   * The underlying Error's `name` property. capnweb preserves this across
   * the wire for the standard built-ins (TypeError, SyntaxError, etc.), so
   * it's a more reliable hint than the message string for those cases.
   */
  errorName: string;
  /** WebSocket close code, when available (kind === 'peer_closed'). */
  closeCode?: number;
  /** WebSocket close reason, when available (kind === 'peer_closed'). */
  closeReason?: string;
}

/**
 * Reason a sandbox-owned operation was interrupted. Callers may branch on
 * this to decide whether to retry the full operation.
 */
export type OperationInterruptedReason =
  /** The container runtime was replaced while the operation was in progress. */
  | 'runtime_replaced'
  /** The RPC session was disposed mid-operation. */
  | 'transport_disposed'
  /** The sandbox lifetime changed (destroy() was called). Not retryable. */
  | 'sandbox_lifetime_changed'
  /** Internal recovery attempts were exhausted. Not retryable. */
  | 'recovery_exhausted';

/**
 * Operation interruption context. Surfaced when a sandbox-owned operation
 * (such as backup restore) was interrupted by a runtime replacement or
 * sandbox lifetime change. Public-safe: does not include internal ids.
 */
export interface OperationInterruptedContext {
  /**
   * Categorical reason. Use `retryable` to decide whether to retry rather
   * than branching on the reason string.
   */
  reason: OperationInterruptedReason;
  /** Name of the operation that was interrupted (e.g. 'backup.restore'). */
  operation: string;
  /** Lifecycle phase at which the interruption was detected. */
  phase: string;
  /**
   * Whether the operation's container-local side effects reached the runtime.
   * `false` means the operation was interrupted before admission; `true`
   * means effects were committed; `'unknown'` means the operation may or may
   * not have committed.
   */
  admitted: boolean | 'unknown';
  /**
   * Whether the caller can safely retry the full operation from the beginning.
   * `sandbox_lifetime_changed` and `recovery_exhausted` set this to false.
   */
  retryable: boolean;
  /** Number of internal recovery attempts made before surfacing this error. */
  recoveryAttempts?: number;
  /** Maximum number of internal recovery attempts allowed. */
  maxRecoveryAttempts?: number;
  /**
   * Container process exit code reported by the platform when the runtime
   * stopped mid-operation (`reason === 'runtime_replaced'`). Preserved from
   * the base container `onStop` params so a trace distinguishes an OOM kill
   * (137) or signal (143) from a clean exit (0). Absent when the interruption
   * was not driven by a container stop.
   */
  containerExitCode?: number;
  /**
   * Container stop reason reported by the platform (`'exit'` for a process
   * exit, `'runtime_signal'` for a signalled shutdown/eviction). Preserved
   * from the base container `onStop` params. Absent when not driven by a
   * container stop.
   */
  stopReason?: string;
}
