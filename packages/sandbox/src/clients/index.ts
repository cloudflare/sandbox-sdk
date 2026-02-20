// =============================================================================
// Main client exports
// =============================================================================

// Main aggregated client
export { SandboxClient } from './sandbox-client';

// =============================================================================
// Domain-specific clients
// =============================================================================

export { BackupClient } from './backup-client';
export { CommandClient } from './command-client';
export { FileClient } from './file-client';
export { GitClient } from './git-client';
export { InterpreterClient } from './interpreter-client';
export { PortClient } from './port-client';
export { ProcessClient } from './process-client';
export { UtilityClient } from './utility-client';

// =============================================================================
// Transport layer
// =============================================================================

export type {
  ITransport,
  TransportConfig,
  TransportMode,
  TransportOptions
} from './transport';
export {
  BaseTransport,
  createTransport,
  HttpTransport,
  WebSocketTransport
} from './transport';

// =============================================================================
// Client types and interfaces
// =============================================================================

// Command client types
export type { ExecuteRequest, ExecuteResponse } from './command-client';
// File client types
export type {
  FileOperationRequest,
  MkdirRequest,
  ReadFileRequest,
  WriteFileRequest
} from './file-client';
// Git client types
export type { GitCheckoutRequest, GitCheckoutResult } from './git-client';
// Interpreter client types
export type { ExecutionCallbacks } from './interpreter-client';
// Port client types
export type {
  ExposePortRequest,
  PortCloseResult,
  PortExposeResult,
  PortListResult,
  UnexposePortRequest
} from './port-client';
// Process client types
export type {
  ProcessCleanupResult,
  ProcessInfoResult,
  ProcessKillResult,
  ProcessListResult,
  ProcessLogsResult,
  ProcessStartResult,
  StartProcessRequest
} from './process-client';
// Core types
export type {
  BaseApiResponse,
  ContainerStub,
  ErrorResponse,
  HttpClientOptions,
  RequestConfig,
  ResponseHandler,
  SessionRequest
} from './types';

// Utility client types
export type {
  CommandsResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  PingResponse,
  VersionResponse
} from './utility-client';
