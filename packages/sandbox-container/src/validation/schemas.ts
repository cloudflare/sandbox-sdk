// Zod validation schemas - single source of truth for request validation and TypeScript types
import { z } from 'zod';

// Process options schema
export const ProcessOptionsSchema = z.object({
  sessionId: z.string().optional(),
  timeout: z.number().positive().optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  encoding: z.string().optional(),
  autoCleanup: z.boolean().optional(),
});

// Execute request schema
export const ExecuteRequestSchema = z.object({
  command: z.string().min(1, 'Command cannot be empty'),
  sessionId: z.string().optional(),
  background: z.boolean().optional(),
});

// File operation schemas
export const ReadFileRequestSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty'),
  encoding: z.string().optional(),
  sessionId: z.string().optional(),
});

export const WriteFileRequestSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty'),
  content: z.string(),
  encoding: z.string().optional(),
  sessionId: z.string().optional(),
});

export const DeleteFileRequestSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty'),
  sessionId: z.string().optional(),
});

export const RenameFileRequestSchema = z.object({
  oldPath: z.string().min(1, 'Old path cannot be empty'),
  newPath: z.string().min(1, 'New path cannot be empty'),
  sessionId: z.string().optional(),
});

export const MoveFileRequestSchema = z.object({
  sourcePath: z.string().min(1, 'Source path cannot be empty'),
  destinationPath: z.string().min(1, 'Destination path cannot be empty'),
  sessionId: z.string().optional(),
});

export const MkdirRequestSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty'),
  recursive: z.boolean().optional(),
  sessionId: z.string().optional(),
});

// Process management schemas
export const StartProcessRequestSchema = z.object({
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
  repoUrl: z.string().url('Repository URL must be valid'),
  branch: z.string().optional(),
  targetDir: z.string().optional(),
  sessionId: z.string().optional(),
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
export type StartProcessRequest = z.infer<typeof StartProcessRequestSchema>;
export type ExposePortRequest = z.infer<typeof ExposePortRequestSchema>;
export type GitCheckoutRequest = z.infer<typeof GitCheckoutRequestSchema>;

// Union type for file requests
export type FileRequest = 
  | ReadFileRequest 
  | WriteFileRequest 
  | DeleteFileRequest 
  | RenameFileRequest 
  | MoveFileRequest 
  | MkdirRequest;

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