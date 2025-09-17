// Zod validation schemas - single source of truth for request validation and TypeScript types
import { z } from 'zod';

// Process options schema with isolation support
export const ProcessOptionsSchema = z.object({
  timeout: z.number().positive().optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  encoding: z.string().optional(),
  autoCleanup: z.boolean().optional(),
  isolation: z.boolean().optional(), // Enable PID namespace isolation (requires CAP_SYS_ADMIN)
});

// Execute request schema with isolation support
export const ExecuteRequestSchema = z.object({
  id: z.string().min(1, 'Session ID is required').optional(), // Session ID (optional - uses default if not provided)
  command: z.string().min(1, 'Command cannot be empty'),
  background: z.boolean().optional(),
  isolation: z.boolean().optional(), // Enable PID namespace isolation
  env: z.record(z.string()).optional(), // Environment variables for the command
  cwd: z.string().optional(), // Working directory for the command
});

// File operation schemas
export const ReadFileRequestSchema = z.object({
  id: z.string().min(1, 'Session ID is required').optional(), // Session ID (optional - uses default if not provided)
  path: z.string().min(1, 'Path cannot be empty'),
  encoding: z.string().optional(),
});

export const WriteFileRequestSchema = z.object({
  id: z.string().min(1, 'Session ID is required').optional(), // Session ID (optional - uses default if not provided)
  path: z.string().min(1, 'Path cannot be empty'),
  content: z.string(),
  encoding: z.string().optional(),
});

export const DeleteFileRequestSchema = z.object({
  id: z.string().min(1, 'Session ID is required').optional(), // Session ID (optional - uses default if not provided)
  path: z.string().min(1, 'Path cannot be empty'),
});

export const RenameFileRequestSchema = z.object({
  id: z.string().min(1, 'Session ID is required').optional(), // Session ID (optional - uses default if not provided)
  oldPath: z.string().min(1, 'Old path cannot be empty'),
  newPath: z.string().min(1, 'New path cannot be empty'),
});

export const MoveFileRequestSchema = z.object({
  id: z.string().min(1, 'Session ID is required').optional(), // Session ID (optional - uses default if not provided)
  sourcePath: z.string().min(1, 'Source path cannot be empty'),
  destinationPath: z.string().min(1, 'Destination path cannot be empty'),
});

export const MkdirRequestSchema = z.object({
  id: z.string().min(1, 'Session ID is required').optional(), // Session ID (optional - uses default if not provided)
  path: z.string().min(1, 'Path cannot be empty'),
  recursive: z.boolean().optional(),
});

export const ListFilesRequestSchema = z.object({
  id: z.string().min(1, 'Session ID is required').optional(), // Session ID (optional - uses default if not provided)
  path: z.string().min(1, 'Path cannot be empty'),
});

// Process management schemas
export const StartProcessRequestSchema = z.object({
  id: z.string().min(1, 'Session ID is required').optional(), // Session ID (optional - uses default if not provided)
  command: z.string().min(1, 'Command cannot be empty'),
  options: ProcessOptionsSchema.optional(),
});

// Port management schemas
export const ExposePortRequestSchema = z.object({
  port: z.number().int().min(1024).max(65535, 'Port must be between 1024 and 65535'),
  name: z.string().optional(),
});

// Git operation schemas
export const GitCheckoutRequestSchema = z.object({
  id: z.string().min(1, 'Session ID is required').optional(), // Session ID (optional - uses default if not provided)
  repoUrl: z.string().url('Repository URL must be valid'),
  branch: z.string().optional(),
  targetDir: z.string().optional(),
});

// Session management schemas
export const CreateSessionRequestSchema = z.object({
  id: z.string().min(1, 'Session ID is required'),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  isolation: z.boolean().optional(),
});

// Infer TypeScript types from schemas - single source of truth!
export type ProcessOptions = z.infer<typeof ProcessOptionsSchema>;
export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;
export type ReadFileRequest = z.infer<typeof ReadFileRequestSchema>;
export type WriteFileRequest = z.infer<typeof WriteFileRequestSchema>;
export type DeleteFileRequest = z.infer<typeof DeleteFileRequestSchema>;
export type RenameFileRequest = z.infer<typeof RenameFileRequestSchema>;
export type MoveFileRequest = z.infer<typeof MoveFileRequestSchema>;
export type MkdirRequest = z.infer<typeof MkdirRequestSchema>;
export type ListFilesRequest = z.infer<typeof ListFilesRequestSchema>;
export type StartProcessRequest = z.infer<typeof StartProcessRequestSchema>;
export type ExposePortRequest = z.infer<typeof ExposePortRequestSchema>;
export type GitCheckoutRequest = z.infer<typeof GitCheckoutRequestSchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

// Union type for file requests
export type FileRequest = 
  | ReadFileRequest 
  | WriteFileRequest 
  | DeleteFileRequest 
  | RenameFileRequest 
  | MoveFileRequest 
  | MkdirRequest
  | ListFilesRequest;

// Schema mapping for different file operations
export const FileRequestSchemas = {
  read: ReadFileRequestSchema,
  write: WriteFileRequestSchema,
  delete: DeleteFileRequestSchema,
  rename: RenameFileRequestSchema,
  move: MoveFileRequestSchema,
  mkdir: MkdirRequestSchema,
} as const;

export type FileOperation = keyof typeof FileRequestSchemas;