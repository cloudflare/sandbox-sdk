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
  // Base client types
  HttpClientOptions as SandboxClientOptions,
  ContainerStub,
  BaseApiResponse,
  ErrorResponse,
  RequestConfig,
  ResponseHandler,
  SessionRequest,

  // Command client types
  ExecuteRequest,
  ExecuteResponse as CommandExecuteResponse,

  // File client types
  MkdirRequest,
  MkdirResponse,
  WriteFileRequest,
  WriteFileResponse,
  ReadFileRequest,
  ReadFileResponse,
  FileOperationRequest,
  FileOperationResponse,

  // Process client types
  StartProcessRequest,
  StartProcessResponse,
  ListProcessesResponse,
  GetProcessResponse,
  GetProcessLogsResponse,
  KillProcessResponse,
  KillAllProcessesResponse,
  ProcessInfo,

  // Port client types
  ExposePortRequest,
  ExposePortResponse,
  UnexposePortRequest,
  UnexposePortResponse,
  ExposedPortInfo,
  GetExposedPortsResponse,

  // Git client types
  GitCheckoutRequest,
  GitCheckoutResponse,

  // Utility client types
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
