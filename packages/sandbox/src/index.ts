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
export { getSandbox, Sandbox } from "./sandbox";

// Legacy types are now imported from the new client architecture

// Export all client types from new architecture
export type {
  BaseApiResponse,
  CommandsResponse, 
  ContainerStub,
  ErrorResponse,

  // Command client types
  ExecuteRequest,
  ExecuteResponse as CommandExecuteResponse,
  ExposedPortInfo,

  // Port client types
  ExposePortRequest,
  ExposePortResponse,
  FileOperationRequest,
  FileOperationResponse,
  GetExposedPortsResponse,
  GetProcessLogsResponse,
  GetProcessResponse,

  // Git client types
  GitCheckoutRequest,
  GitCheckoutResponse,
  // Base client types
  HttpClientOptions as SandboxClientOptions,
  KillAllProcessesResponse,
  KillProcessResponse,
  ListProcessesResponse,

  // File client types
  MkdirRequest,
  MkdirResponse,

  // Utility client types
  PingResponse,
  ProcessInfo,
  ReadFileRequest,
  ReadFileResponse,
  RequestConfig,
  ResponseHandler,
  SessionRequest,

  // Process client types
  StartProcessRequest,
  StartProcessResponse,
  UnexposePortRequest,
  UnexposePortResponse,
  WriteFileRequest,
  WriteFileResponse
} from "./clients";
// Re-export request handler utilities
export {
  proxyToSandbox, type RouteInfo, type SandboxEnv
} from './request-handler';
// Export SSE parser for converting ReadableStream to AsyncIterable
export { asyncIterableToSSEStream, parseSSEStream, responseToAsyncIterable } from "./sse-parser";
// Export core SDK types for consumers
export type {
  BaseExecOptions,
  ExecEvent,
  ExecOptions,
  ExecResult,
  ISandbox, 
  LogEvent,
  Process,
  ProcessOptions,
  ProcessStatus,
  StreamOptions
} from "./types";
// Export type guards for runtime validation
export {
  isExecResult,
  isProcess,
  isProcessStatus
} from "./types";
