/**
 * Shared types for Cloudflare Sandbox SDK
 * Used by both client SDK and container runtime
 */

// Export environment utilities
export { filterEnvVars, getEnvString, partitionEnvVars } from './env.js';
// Export git utilities
export {
  DEFAULT_GIT_CLONE_TIMEOUT_MS,
  extractRepoName,
  FALLBACK_REPO_NAME,
  GitLogger,
  sanitizeGitData
} from './git.js';
export type { LogLevelOptions } from './logger/canonical.js';
// Export canonical event helpers
export {
  buildMessage,
  logCanonicalEvent,
  resolveLogLevel
} from './logger/canonical.js';
export type { CanonicalEventPayload } from './logger/canonical.types.js';
// Export logger infrastructure
export type { LogContext, Logger, LogLevel } from './logger/index.js';
export {
  createLogger,
  createNoOpLogger,
  LogLevelEnum,
  TraceContext
} from './logger/index.js';
// Export sanitize helpers
export {
  redactCommand,
  redactCredentials,
  redactSensitiveParams,
  truncateForLog
} from './logger/sanitize.js';
// Export PTY types
export type {
  PtyControlMessage,
  PtyOptions,
  PtyStatusMessage,
  SandboxTerminal,
  TerminalConnectOptions,
  TerminalCreateOptions,
  TerminalOptions
} from './pty-types.js';
// Export all request types (enforce contract between client and container)
export type {
  CreateBackupRequest,
  CreateBackupResponse,
  DeleteFileRequest,
  ExecuteRequest,
  FileExistsRequest,
  GitCheckoutRequest,
  ListFilesRequest,
  MkdirRequest,
  MoveFileRequest,
  ReadFileRequest,
  RenameFileRequest,
  RestoreBackupRequest,
  RestoreBackupResponse,
  SessionCreateRequest,
  SessionDeleteRequest,
  StartProcessRequest,
  UploadedPart,
  UploadPart,
  UploadPartsRequest,
  UploadPartsResponse,
  WriteFileRequest
} from './request-types.js';
export type {
  BackupCreateArchiveOptions,
  BackupRestoreArchiveOptions,
  CommandExecuteOptions,
  EnsureNamedTunnelRunRequest,
  EnsureQuickTunnelRunRequest,
  EnsureTunnelRunRequest,
  EnsureTunnelRunResult,
  ExtensionConnectRequest,
  ExtensionHealth,
  ExtensionPackage,
  ExtensionRegistration,
  FileSessionOptions,
  GitCheckoutOptions,
  MkdirOptions,
  NamedTunnelInfo,
  NamedTunnelRunSnapshot,
  ProcessStartOptions,
  QuickTunnelInfo,
  QuickTunnelRunSnapshot,
  ReadFileBinaryOptions,
  ReadFileOptions,
  ReadFileStreamOptions,
  SandboxAPI,
  SandboxBackupAPI,
  SandboxCommandsAPI,
  SandboxControlCallback,
  SandboxExtensionsAPI,
  SandboxFilesAPI,
  SandboxGitAPI,
  SandboxPortsAPI,
  SandboxProcessesAPI,
  SandboxTerminalsAPI,
  SandboxTunnelsAPI,
  SandboxUtilsAPI,
  SandboxWatchAPI,
  SessionCreateOptions,
  StopTunnelRunRequest,
  StopTunnelRunResult,
  TunnelInfo,
  TunnelOptions,
  TunnelRunExitEvent,
  TunnelRunIdentity,
  TunnelRunMode,
  TunnelRunSnapshot,
  WriteFileOptions
} from './rpc-types.js';
// RPC interface types (shared between SDK and container)
export { EXTENSION_TARBALL_REQUIRED } from './rpc-types.js';
// Export shell utilities
export { shellEscape } from './shell-escape.js';
// Export SSE utilities
export type { SSEEventFrame, SSEPartialEvent } from './sse.js';
export { parseSSEFrames } from './sse.js';
// Export all types from types.ts
export type {
  // Backup types
  BackupCompressionOptions,
  BackupOptions,
  BaseExecOptions,
  // Bucket mounting types
  BucketCredentials,
  BucketProvider,
  CheckChangesOptions,
  CheckChangesRequest,
  CheckChangesResult,
  DeleteFileResult,
  DirectoryBackup,
  Disposable,
  EnvSetResult,
  ExecEvent,
  ExecOptions,
  ExecResult,
  ExecutionSession,
  // File streaming types
  FileChunk,
  FileEncoding,
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
  ISandbox,
  ListFilesOptions,
  ListFilesResult,
  LocalMountBucketOptions,
  LogEvent,
  MkdirResult,
  MountBucketOptions,
  MoveFileResult,
  PortCheckRequest,
  PortCheckResponse,
  PortExposeResult,
  PortWatchEvent,
  PortWatchRequest,
  Process,
  ProcessCleanupResult,
  ProcessInfoResult,
  ProcessKillResult,
  ProcessListResult,
  ProcessLogsResult,
  ProcessOptions,
  ProcessQueryOptions,
  // Process management result types
  ProcessStartResult,
  ProcessStatus,
  R2BindingMountBucketOptions,
  ReadFileResult,
  ReadFileStreamResult,
  RemoteMountBucketOptions,
  RenameFileResult,
  RestoreBackupResult,
  // Unified exec surface (mirrors ctx.container.exec contract)
  SandboxExecOptions,
  SandboxExecOutput,
  // Sandbox configuration options
  SandboxOptions,
  SandboxProcess,
  SandboxProcessPromise,
  // Session management result types
  SessionCreateResult,
  SessionDeleteResult,
  SessionOptions,
  ShutdownResult,
  // Process readiness types
  WaitForExitResult,
  WaitForLogResult,
  WaitForPortOptions,
  // File watch types
  WatchOptions,
  WatchRequest,
  WriteFileResult
} from './types.js';
export {
  isExecResult,
  isProcess,
  isProcessStatus,
  isTerminalStatus
} from './types.js';
