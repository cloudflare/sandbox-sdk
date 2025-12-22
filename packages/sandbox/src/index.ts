// Export the main Sandbox class and utilities

// Export the new client architecture
export {
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
  BaseExecOptions,
  BucketCredentials,
  BucketProvider,
  CodeContext,
  CreateContextOptions,
  ExecEvent,
  ExecOptions,
  ExecResult,
  ExecutionResult,
  ExecutionSession,
  FileChunk,
  FileMetadata,
  FileStreamEvent,
  GitCheckoutResult,
  ISandbox,
  ListFilesOptions,
  LogEvent,
  MountBucketOptions,
  Process,
  ProcessOptions,
  ProcessStatus,
  RunCodeOptions,
  SandboxOptions,
  SessionOptions,
  StreamOptions,
  // Process readiness types
  WaitForLogResult,
  WaitForPortOptions
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

  // Port client types
  ExposePortRequest,
  FileOperationRequest,

  // Git client types
  GitCheckoutRequest,
  // Base client types
  HttpClientOptions as SandboxClientOptions,

  // File client types
  MkdirRequest,
  PingResponse,
  PortCloseResult,
  PortExposeResult,
  PortListResult,
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
  UnexposePortRequest,
  WriteFileRequest
} from './clients';
export type {
  ExecutionCallbacks,
  InterpreterClient
} from './clients/interpreter-client.js';
// Export PTY types
export type { Pty } from './clients/pty-client.js';
// Export process readiness errors
export {
  ProcessExitedBeforeReadyError,
  ProcessReadyTimeoutError
} from './errors';
// Export file streaming utilities for binary file support
export { collectFile, streamFile } from './file-stream';
// Export interpreter functionality
export { CodeInterpreter } from './interpreter.js';
// Re-export request handler utilities
export {
  proxyToSandbox,
  type RouteInfo,
  type SandboxEnv
} from './request-handler';
// Export SSE parser for converting ReadableStream to AsyncIterable
export {
  asyncIterableToSSEStream,
  parseSSEStream,
  responseToAsyncIterable
} from './sse-parser';
// Export bucket mounting errors
export {
  BucketMountError,
  InvalidMountConfigError,
  MissingCredentialsError,
  S3FSMountError
} from './storage-mount/errors';
