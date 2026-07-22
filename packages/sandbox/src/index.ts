// Export the main Sandbox class and utilities

// Export core SDK types for consumers
export type {
  BackupOptions,
  BucketCredentials,
  BucketProvider,
  CheckChangesOptions,
  CheckChangesResult,
  CreateTerminalOptions,
  DirectoryBackup,
  ExecOptions,
  FileChunk,
  FileMetadata,
  FileStreamEvent,
  // File watch types
  FileWatchSSEEvent,
  ISandbox,
  ListFilesOptions,
  LocalMountBucketOptions,
  MountBucketOptions,
  NamedTunnelInfo,
  ProcessExit,
  ProcessFailure,
  ProcessLogCursor,
  ProcessLogEvent,
  ProcessLogsOptions,
  ProcessOutput,
  ProcessOutputOptions,
  ProcessStatus,
  ProcessTextOutputOptions,
  QuickTunnelInfo,
  RemoteMountBucketOptions,
  RestoreBackupResult,
  SandboxCommand,
  SandboxOptions,
  SandboxProcess,
  Terminal,
  TerminalOutputCursor,
  TerminalOutputEvent,
  TerminalOutputOptions,
  TerminalSnapshot,
  TunnelInfo,
  TunnelOptions,
  WaitForExitOptions,
  WaitForLogOptions,
  WaitForLogResult,
  WaitForPortOptions,
  WatchOptions
} from '@repo/shared';
export type { RPCTransportContext, RPCTransportErrorKind } from './errors';
// Export backup and process readiness errors
export {
  BackupCreateError,
  BackupExpiredError,
  BackupNotFoundError,
  BackupRestoreError,
  ContainerUnavailableError,
  InvalidBackupConfigError,
  InvalidProcessCursorError,
  InvalidProcessCwdError,
  InvalidProcessEnvironmentError,
  InvalidTerminalCursorError,
  InvalidTerminalCwdError,
  OperationInterruptedError,
  ProcessAbortedError,
  ProcessError,
  ProcessExitedBeforeLogError,
  ProcessExitedBeforeReadyError,
  ProcessNotFoundError,
  ProcessReadyTimeoutError,
  ProcessSpawnFailedError,
  ProcessWaitTimeoutError,
  // RPC transport error (raised on capnweb WebSocket session failures)
  RPCTransportError,
  RuntimeControlProtocolError,
  RuntimeIdentityInactiveError,
  StaleProcessHandleError,
  StaleTerminalHandleError,
  TerminalControlError,
  TerminalNotFoundError
} from './errors';
// Export file streaming utilities for binary file support
export { collectFile, streamFile } from './file-stream';
export {
  isDurableObjectCodeUpdateReset,
  isPlatformTransientError
} from './platform-errors';
export { proxyTerminal } from './pty';
// Re-export request handler utilities
export { proxyToSandbox, type SandboxEnv } from './request-handler';
// Required export for egress intercepting
export { ContainerProxy, getSandbox, Sandbox } from './sandbox';
// Export SSE parser for converting ReadableStream to AsyncIterable
export {
  asyncIterableToSSEStream,
  parseSSEStream,
  responseToAsyncIterable
} from './sse-parser';
// Export bucket mounting errors
export {
  BucketMountError,
  BucketUnmountError,
  InvalidMountConfigError,
  MissingCredentialsError,
  S3FSMountError
} from './storage-mount/errors';
