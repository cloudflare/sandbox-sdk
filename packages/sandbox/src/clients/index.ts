// Main client exports
export { SandboxClient } from './sandbox-client';

// Domain-specific clients
export { CommandClient } from './command-client';
export { FileClient } from './file-client';
export { ProcessClient } from './process-client';
export { PortClient } from './port-client';
export { GitClient } from './git-client';
export { UtilityClient } from './utility-client';

// Types and interfaces
export type {
  HttpClientOptions,
  BaseApiResponse,
  ErrorResponse,
  RequestConfig,
  ResponseHandler,
  SessionRequest,
} from './types';

// Command client types
export type {
  ExecuteRequest,
  ExecuteResponse,
} from './command-client';

// File client types
export type {
  MkdirRequest,
  MkdirResponse,
  WriteFileRequest,
  WriteFileResponse,
  ReadFileRequest,
  ReadFileResponse,
  FileOperationRequest,
  FileOperationResponse,
} from './file-client';

// Process client types
export type {
  StartProcessRequest,
  ProcessInfo,
  StartProcessResponse,
  ListProcessesResponse,
  GetProcessResponse,
  GetProcessLogsResponse,
  KillProcessResponse,
  KillAllProcessesResponse,
} from './process-client';

// Port client types
export type {
  ExposePortRequest,
  ExposePortResponse,
  UnexposePortRequest,
  UnexposePortResponse,
  ExposedPortInfo,
  GetExposedPortsResponse,
} from './port-client';

// Git client types
export type {
  GitCheckoutRequest,
  GitCheckoutResponse,
} from './git-client';

// Utility client types
export type {
  PingResponse,
  CommandsResponse,
} from './utility-client';