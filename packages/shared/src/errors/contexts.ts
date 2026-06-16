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

export type ContainerUnavailableReason =
  | 'provisioning'
  | 'startup'
  | 'container_restarted';

export interface ContainerUnavailableContext {
  reason?: ContainerUnavailableReason;
  sessionId?: string;
}

export type OperationInterruptedReason =
  | 'runtime_replaced'
  | 'container_stopped'
  | 'transport_disposed'
  | 'sandbox_destroyed'
  | 'incarnation_changed'
  | 'recovery_exhausted'
  | 'unknown';

export interface OperationInterruptedContext {
  reason: OperationInterruptedReason;
  operation: string;
  phase?: string;
  admitted: true | 'unknown';
  retryable: boolean;
  operationId?: string;
  operationKey?: string;
  idempotencyKey?: string;
  recoveryAttempts?: number;
  maxRecoveryAttempts?: number;
  backupId?: string;
  dir?: string;
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
