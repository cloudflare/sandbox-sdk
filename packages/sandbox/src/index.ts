// Export the main Sandbox class and utilities
export { getSandbox, Sandbox } from './sandbox';

// Required export for egress intercepting

// Export core SDK types for consumers
export type {
  BackupOptions,
  BaseExecOptions,
  BucketCredentials,
  BucketProvider,
  CodeContext,
  CreateContextOptions,
  DirectoryBackup,
  ExecEvent,
  ExecOptions,
  ExecResult,
  ExecutionResult,
  ExecutionSession,
  FileChunk,
  FileMetadata,
  FileStreamEvent,
  FileWatchSSEEvent,
  GitCheckoutResult,
  ISandbox,
  ListFilesOptions,
  LocalMountBucketOptions,
  LogEvent,
  MountBucketOptions,
  Process,
  ProcessOptions,
  ProcessStatus,
  PtyOptions,
  RemoteMountBucketOptions,
  RestoreBackupResult,
  RunCodeOptions,
  SandboxOptions,
  SessionOptions,
  StreamOptions,
  WaitForLogResult,
  WaitForPortOptions,
  WatchOptions
} from '@repo/shared';

// Export type guards for runtime validation
export { isExecResult, isProcess, isProcessStatus } from '@repo/shared';

// Export desktop types
export type { Desktop, ExecuteResponse } from './clients';

// Export backup and process readiness errors
export {
  BackupCreateError,
  BackupExpiredError,
  BackupNotFoundError,
  BackupRestoreError,
  DesktopInvalidCoordinatesError,
  DesktopInvalidOptionsError,
  DesktopNotStartedError,
  DesktopProcessCrashedError,
  DesktopStartFailedError,
  DesktopUnavailableError,
  InvalidBackupConfigError,
  ProcessExitedBeforeReadyError,
  ProcessReadyTimeoutError
} from './errors';

// Export interpreter functionality
export { CodeInterpreter } from './interpreter.js';
export { proxyTerminal } from './pty';

// Re-export request handler utilities
export {
  proxyToSandbox,
  type RouteInfo,
  type SandboxEnv
} from './request-handler';

// Export bucket mounting errors
export {
  BucketMountError,
  InvalidMountConfigError,
  MissingCredentialsError,
  S3FSMountError
} from './storage-mount/errors';
