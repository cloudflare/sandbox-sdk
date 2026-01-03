/**
 * Shared types for Cloudflare Sandbox SDK
 * Used by both client SDK and container runtime
 */

// Export environment utilities
export { getEnvString } from './env.js';
// Export git utilities
export { GitLogger, redactCredentials, sanitizeGitData } from './git.js';
// Export all interpreter types
export type {
  ChartData,
  CodeContext,
  CreateContextOptions,
  ExecutionError,
  ExecutionResult,
  OutputMessage,
  Result,
  RunCodeOptions
} from './interpreter-types.js';
export { Execution, ResultImpl } from './interpreter-types.js';
// Export logger infrastructure
export type { LogContext, Logger, LogLevel } from './logger/index.js';
export {
  createLogger,
  createNoOpLogger,
  LogLevelEnum,
  TraceContext
} from './logger/index.js';
// Export all request types (enforce contract between client and container)
export type {
  DeleteFileRequest,
  ExecuteRequest,
  ExposePortRequest,
  FileExistsRequest,
  GitCheckoutRequest,
  MkdirRequest,
  MoveFileRequest,
  ReadFileRequest,
  RenameFileRequest,
  SessionCreateRequest,
  SessionDeleteRequest,
  StartProcessRequest,
  WriteFileRequest
} from './request-types.js';
// Export shell utilities
export { shellEscape } from './shell-escape.js';
// Export all types from types.ts
export type {
  BaseExecOptions,
  // Bucket mounting types
  BucketCredentials,
  BucketProvider,
  ContextCreateResult,
  ContextDeleteResult,
  ContextListResult,
  DeleteFileResult,
  EnvSetResult,
  ExecEvent,
  ExecOptions,
  ExecResult,
  ExecutionSession,
  // File streaming types
  FileChunk,
  FileExistsResult,
  FileInfo,
  FileMetadata,
  FileStreamEvent,
  // File watch types
  FileWatchEventType,
  FileWatchSSEEvent,
  GitCheckoutResult,
  // Miscellaneous result types
  HealthCheckResult,
  // Code interpreter result types
  InterpreterHealthResult,
  ISandbox,
  ListFilesOptions,
  ListFilesResult,
  LogEvent,
  MkdirResult,
  MountBucketOptions,
  MoveFileResult,
  PortCheckRequest,
  PortCheckResponse,
  PortCloseResult,
  // Port management result types
  PortExposeResult,
  PortListResult,
  PortStatusResult,
  PortWatchEvent,
  PortWatchRequest,
  Process,
  ProcessCleanupResult,
  ProcessInfoResult,
  ProcessKillResult,
  ProcessListResult,
  ProcessLogsResult,
  ProcessOptions,
  // Process management result types
  ProcessStartResult,
  ProcessStatus,
  ReadFileResult,
  RenameFileResult,
  // Sandbox configuration options
  SandboxOptions,
  // Session management result types
  SessionCreateResult,
  SessionDeleteResult,
  SessionOptions,
  ShutdownResult,
  StreamOptions,
  // Process readiness types
  WaitForExitResult,
  WaitForLogResult,
  WaitForPortOptions,
  // File watch types (user-facing)
  WatchErrorCallback,
  WatchEvent,
  WatchEventCallback,
  WatchEventType,
  WatchHandle,
  WatchOptions,
  // File watch types
  WatchRequest,
  WatchStopResult,
  WriteFileResult
} from './types.js';
export {
  isExecResult,
  isProcess,
  isProcessStatus,
  isTerminalStatus
} from './types.js';
// Export WebSocket protocol types
export type {
  WSClientMessage,
  WSError,
  WSMethod,
  WSRequest,
  WSResponse,
  WSServerMessage,
  WSStreamChunk
} from './ws-types.js';
export {
  generateRequestId,
  isWSError,
  isWSRequest,
  isWSResponse,
  isWSStreamChunk
} from './ws-types.js';
