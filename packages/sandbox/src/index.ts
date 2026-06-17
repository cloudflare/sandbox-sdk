// Export the main Sandbox class and utilities

// Export core SDK types for consumers
export type {
  BackupOptions,
  BaseExecOptions,
  BucketCredentials,
  BucketProvider,
  CheckChangesOptions,
  CheckChangesResult,
  DirectoryBackup,
  ExecEvent,
  ExecOptions,
  ExecResult,
  ExecutionSession,
  FileChunk,
  FileMetadata,
  FileStreamEvent,
  // File watch types
  FileWatchSSEEvent,
  GitCheckoutResult,
  ISandbox,
  ListFilesOptions,
  LocalMountBucketOptions,
  LogEvent,
  MountBucketOptions,
  NamedTunnelInfo,
  Process,
  ProcessOptions,
  ProcessStatus,
  PtyOptions,
  QuickTunnelInfo,
  RemoteMountBucketOptions,
  RestoreBackupResult,
  SandboxOptions,
  SessionOptions,
  TerminalOptions,
  TunnelInfo,
  TunnelOptions,
  WaitForLogResult,
  WaitForPortOptions,
  WatchOptions
} from '@repo/shared';
// Export type guards for runtime validation
export { isExecResult, isProcess, isProcessStatus } from '@repo/shared';
export type { RPCTransportContext, RPCTransportErrorKind } from './errors';
// Export backup and process readiness errors
export {
  BackupCreateError,
  BackupExpiredError,
  BackupNotFoundError,
  BackupRestoreError,
  ContainerUnavailableError,
  InvalidBackupConfigError,
  ProcessExitedBeforeReadyError,
  ProcessReadyTimeoutError,
  // RPC transport error (raised on capnweb WebSocket session failures)
  RPCTransportError,
  SessionTerminatedError
} from './errors';
// Export file streaming utilities for binary file support
export { collectFile, streamFile } from './file-stream';
export {
  isDurableObjectCodeUpdateReset,
  isPlatformTransientError
} from './platform-errors';
export { createSandboxTerminal, proxyTerminal } from './pty';
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
