// Zod validation schemas - single source of truth for request validation and TypeScript types
import { z } from 'zod';

// Process options schema
export const ProcessOptionsSchema = z.object({
  sessionId: z.string().optional(),
  processId: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
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
  timeoutMs: z.number().positive().optional(),
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

export const ListFilesRequestSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty'),
  options: z.object({
    recursive: z.boolean().optional(),
    includeHidden: z.boolean().optional(),
  }).optional(),
  sessionId: z.string().optional(),
});

// Process management schemas
// Uses flat structure consistent with other endpoints
export const StartProcessRequestSchema = z.object({
  command: z.string().min(1, 'Command cannot be empty'),
  sessionId: z.string().optional(),
  processId: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  encoding: z.string().optional(),
  autoCleanup: z.boolean().optional(),
});

// Port management schemas
// Phase 0: Allow all ports 1-65535 (services will validate - only the control plane port is blocked, default: 3000)
export const ExposePortRequestSchema = z.object({
  port: z.number().int().min(1).max(65535, 'Port must be between 1 and 65535'),
  name: z.string().optional(),
});

// Git operation schemas
// Phase 0: Accept any non-empty string (services will validate format)
// This allows SSH URLs like git@github.com:user/repo.git
export const GitCheckoutRequestSchema = z.object({
  repoUrl: z.string().min(1, 'Repository URL cannot be empty'),
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
export type ListFilesRequest = z.infer<typeof ListFilesRequestSchema>;
// Note: StartProcessRequest is now imported from @repo/shared for type safety
// The Zod schema is still used for runtime validation
export type ExposePortRequest = z.infer<typeof ExposePortRequestSchema>;
export type GitCheckoutRequest = z.infer<typeof GitCheckoutRequestSchema>;

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
  listFiles: ListFilesRequestSchema,
} as const;

export type FileOperation = keyof typeof FileRequestSchemas;