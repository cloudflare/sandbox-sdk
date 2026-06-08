// Export the main Sandbox class and utilities

// Export the new client architecture
export {
  BackupClient,
  CommandClient,
  FileClient,
  GitClient,
  PortClient,
  ProcessClient,
  SandboxClient,
  UtilityClient
} from './clients';
export { getSandbox, Sandbox } from './sandbox';

// Legacy types are now imported from the new client architecture

// Export core SDK types for consumers
export type {
  BackupOptions,
  BaseExecOptions,
  BucketCredentials,
  BucketProvider,
  CheckChangesOptions,
  CheckChangesResult,
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
  RunCodeOptions,
  SandboxOptions,
  SandboxTransport,
  SessionOptions,
  StreamOptions,
  TunnelInfo,
  TunnelOptions,
  WaitForLogResult,
  WaitForPortOptions,
  WatchOptions
} from '@repo/shared';
// Export type guards for runtime validation
export { isExecResult, isProcess, isProcessStatus } from '@repo/shared';
// Export all client types from new architecture
export type {
  BaseApiResponse,
  CommandsResponse,
  ContainerStub,

  // Utility client types
  CreateSessionRequest,
  CreateSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  ErrorResponse,

  // Command client types
  ExecuteRequest,
  ExecuteResponse as CommandExecuteResponse,
  FileOperationRequest,

  // Git client types
  GitCheckoutRequest,
  // Base client types
  HttpClientOptions as SandboxClientOptions,

  // File client types
  MkdirRequest,
  PingResponse,
  ProcessCleanupResult,
  ProcessInfoResult,
  ProcessKillResult,
  ProcessListResult,
  ProcessLogsResult,
  ProcessStartResult,
  ReadFileRequest,
  RequestConfig,
  ResponseHandler,
  SessionRequest,

  // Process client types
  StartProcessRequest,
  WriteFileRequest
} from './clients';
export type {
  ExecutionCallbacks,
  InterpreterClient
} from './clients/interpreter-client.js';
export type { RPCTransportContext, RPCTransportErrorKind } from './errors';
// Export backup and process readiness errors
export {
  BackupCreateError,
  BackupExpiredError,
  BackupNotFoundError,
  BackupRestoreError,
  InvalidBackupConfigError,
  ProcessExitedBeforeReadyError,
  ProcessReadyTimeoutError,
  // RPC transport error (raised on capnweb WebSocket session failures)
  RPCTransportError,
  SessionTerminatedError
} from './errors';
// Export file streaming utilities for binary file support
export { collectFile, streamFile } from './file-stream';
// Export interpreter functionality
export { CodeInterpreter } from './interpreter.js';
export { proxyTerminal } from './pty';
// Re-export request handler utilities
export { proxyToSandbox, type SandboxEnv } from './request-handler';
// Required export for egress intercepting
export { ContainerProxy } from './sandbox';
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
