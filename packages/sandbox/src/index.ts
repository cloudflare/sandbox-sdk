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
} from "./clients";
export { getSandbox, Sandbox, connect } from "./sandbox";

// Legacy types are now imported from the new client architecture

// Export core SDK types for consumers
export type {
  BaseExecOptions,
  ExecEvent,
  ExecOptions,
  ExecResult,FileChunk, FileMetadata, FileStreamEvent, 
  ISandbox,
  LogEvent,
  Process,
  ProcessOptions,
  ProcessStatus,
  StreamOptions 
} from "@repo/shared";
export * from '@repo/shared';
// Export type guards for runtime validation
export {
  isExecResult,
  isProcess,
  isProcessStatus
} from "@repo/shared";
// Export all client types from new architecture
export type {
  BaseApiResponse,
  CommandsResponse,
  ContainerStub,
  ErrorResponse,

  // Command client types
  ExecuteRequest,
  ExecuteResponse as CommandExecuteResponse,

  // Port client types
  ExposePortRequest,
  FileOperationRequest,

  // Git client types
  GitCheckoutRequest,
  GitCheckoutResult,
  // Base client types
  HttpClientOptions as SandboxClientOptions,

  // File client types
  MkdirRequest,

  // Utility client types
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
} from "./clients";
export type { ExecutionCallbacks, InterpreterClient } from './clients/interpreter-client.js';
// Export file streaming utilities for binary file support
export { collectFile, streamFile } from './file-stream';
// Export interpreter functionality
export { CodeInterpreter } from './interpreter.js';
// Re-export request handler utilities
export {
  proxyToSandbox, type RouteInfo, type SandboxEnv
} from './request-handler';
// Export SSE parser for converting ReadableStream to AsyncIterable
export { asyncIterableToSSEStream, parseSSEStream, responseToAsyncIterable } from "./sse-parser";
