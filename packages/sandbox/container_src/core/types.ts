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
  subprocess?: any;
}

export interface ProcessOptions {
  sessionId?: string;
  timeout?: number;
  env?: Record<string, string>;
  cwd?: string;
  encoding?: string;
  autoCleanup?: boolean;
}

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

// Request/Response types (from existing types.ts)
export interface ExecuteRequest {
  command: string;
  sessionId?: string;
  background?: boolean;
}

export interface ExecuteResponse {
  success: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  processId?: string;
}

export interface ReadFileRequest {
  path: string;
  encoding?: string;
  sessionId?: string;
}

export interface ReadFileResponse {
  content: string;
  path: string;
}

export interface WriteFileRequest {
  path: string;
  content: string;
  encoding?: string;
  sessionId?: string;
}

export interface WriteFileResponse {
  success: boolean;
  path: string;
  bytesWritten: number;
}

export interface DeleteFileRequest {
  path: string;
  sessionId?: string;
}

export interface DeleteFileResponse {
  success: boolean;
  path: string;
}

export interface RenameFileRequest {
  oldPath: string;
  newPath: string;
  sessionId?: string;
}

export interface MoveFileRequest {
  sourcePath: string;
  destinationPath: string;
  sessionId?: string;
}

export interface GitCheckoutRequest {
  repoUrl: string;
  branch?: string;
  targetDir?: string;
  sessionId?: string;
}

export interface MkdirRequest {
  path: string;
  recursive?: boolean;
  sessionId?: string;
}

export interface ExposePortRequest {
  port: number;
  name?: string;
}

export interface StartProcessRequest {
  command: string;
  options?: ProcessOptions;
}