// Export the main Sandbox class and utilities
export { getSandbox, Sandbox } from "./sandbox";

// Export the new client architecture
export { 
  SandboxClient,
  CommandClient,
  FileClient,
  ProcessClient,
  PortClient,
  GitClient,
  UtilityClient
} from "./clients";

// Legacy types are now imported from the new client architecture

// Export all client types from new architecture
export type {
  HttpClientOptions as SandboxClientOptions,
  ExecuteRequest,
  ExecuteResponse as CommandExecuteResponse,
  MkdirRequest,
  MkdirResponse,
  WriteFileRequest,
  WriteFileResponse,
  ReadFileRequest,
  ReadFileResponse,
  FileOperationRequest,
  FileOperationResponse,
  ProcessInfo,
  ExposePortRequest,
  ExposePortResponse,
  UnexposePortRequest,
  UnexposePortResponse,
  ExposedPortInfo,
  GetExposedPortsResponse,
  GitCheckoutRequest,
  GitCheckoutResponse,
  PingResponse,
  CommandsResponse
} from "./clients";

// Export core SDK types for consumers
export type {
  BaseExecOptions,
  ExecOptions,
  ExecResult,
  ProcessOptions,
  ProcessStatus,
  Process,
  ExecEvent,
  LogEvent,
  StreamOptions,
  ISandbox
} from "./types";

// Export type guards for runtime validation
export {
  isExecResult,
  isProcess,
  isProcessStatus
} from "./types";

// Re-export request handler utilities
export {
  proxyToSandbox, type RouteInfo, type SandboxEnv
} from './request-handler';

// Export SSE parser for converting ReadableStream to AsyncIterable
export { asyncIterableToSSEStream, parseSSEStream, responseToAsyncIterable } from "./sse-parser";
