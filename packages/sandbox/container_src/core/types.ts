// Core architectural types and interfaces for the refactored container

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS';

export interface Handler<TRequest, TResponse> {
  handle(request: TRequest, context: RequestContext): Promise<TResponse>;
}

export interface RequestContext {
  sessionId?: string;
  corsHeaders: Record<string, string>;
  requestId: string;
  timestamp: Date;
}

// Extended context with validation data
export interface ValidatedRequestContext<T = unknown> extends RequestContext {
  originalRequest?: Request;
  validatedData?: T;
}

export interface ValidationResult<T = unknown> {
  isValid: boolean;
  data?: T;
  errors: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: ServiceError;
}

export interface ServiceError {
  message: string;
  code: string;
  details?: Record<string, unknown>;
}

export interface Middleware {
  handle(
    request: Request,
    context: RequestContext,
    next: NextFunction
  ): Promise<Response>;
}

export type NextFunction = () => Promise<Response>;

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handler: RequestHandler;
  middleware?: Middleware[];
}

export type RequestHandler = (
  request: Request,
  context: RequestContext
) => Promise<Response>;

// Logger interface
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: Error, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

// Session types
export interface SessionData {
  id: string;
  sessionId: string; // Keep for backwards compatibility
  activeProcess: string | null;
  createdAt: Date;
  expiresAt?: Date;
  env?: Record<string, string>;
  cwd?: string;
}

// Process types (enhanced from existing)
export type ProcessStatus =
  | 'starting'
  | 'running' 
  | 'completed'
  | 'failed'
  | 'killed'
  | 'error';

export interface ProcessRecord {
  id: string;
  pid?: number;
  command: string;
  status: ProcessStatus;
  startTime: Date;
  endTime?: Date;
  exitCode?: number;
  sessionId?: string;
  stdout: string;
  stderr: string;
  outputListeners: Set<(stream: 'stdout' | 'stderr', data: string) => void>;
  statusListeners: Set<(status: ProcessStatus) => void>;
  // For Bun subprocess
  subprocess?: { 
    kill: (signal?: number) => void; 
    stdout?: ReadableStream; 
    stderr?: ReadableStream; 
    exited: Promise<number> 
  };
}

export type { ProcessOptions } from '../validation/schemas';

export interface CommandResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

// File operation types
export interface FileStats {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  modified: Date;
  created: Date;
}

export interface ReadOptions {
  encoding?: string;
}

export interface WriteOptions {
  encoding?: string;
  mode?: string;
}

export interface MkdirOptions {
  recursive?: boolean;
  mode?: string;
}

// Port management types  
export interface PortInfo {
  port: number;
  name?: string;
  exposedAt: Date;
  status: 'active' | 'inactive';
}

// Git operation types
export interface GitResult {
  success: boolean;
  message: string;
  targetDirectory?: string;
  error?: string;
}

export interface CloneOptions {
  branch?: string;
  targetDir?: string;
  sessionId?: string;
}

// Import request types from Zod schemas - single source of truth!
export type { ExecuteRequest } from '../validation/schemas';

export interface ExecuteResponse {
  success: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  processId?: string;
}

export type { ReadFileRequest } from '../validation/schemas';

export interface ReadFileResponse {
  content: string;
  path: string;
}

export type { WriteFileRequest } from '../validation/schemas';

export interface WriteFileResponse {
  success: boolean;
  path: string;
  bytesWritten: number;
}

export type { DeleteFileRequest } from '../validation/schemas';

export interface DeleteFileResponse {
  success: boolean;
  path: string;
}

export type { RenameFileRequest } from '../validation/schemas';

export type { MoveFileRequest } from '../validation/schemas';

export type { GitCheckoutRequest } from '../validation/schemas';

export type { MkdirRequest } from '../validation/schemas';

export type { ExposePortRequest } from '../validation/schemas';

export type { StartProcessRequest } from '../validation/schemas';

// Import union types from Zod schemas
export type { FileRequest, FileOperation } from '../validation/schemas';