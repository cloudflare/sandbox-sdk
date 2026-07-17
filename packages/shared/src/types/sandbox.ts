import type { ProcessStatus, SandboxCommand } from '../process-types.js';
import type { CreateTerminalOptions, Terminal } from '../pty-types.js';
import type {
  BackupOptions,
  DirectoryBackup,
  MountBucketOptions,
  RestoreBackupResult
} from './backup-mounts.js';
import type {
  ExecOptions,
  SandboxProcess,
  WaitForPortOptions
} from './core.js';
import type {
  CheckChangesOptions,
  CheckChangesResult,
  DeleteFileResult,
  FileEncoding,
  FileExistsResult,
  ListFilesOptions,
  ListFilesResult,
  MkdirResult,
  MoveFileResult,
  ReadFileResult,
  ReadFileStreamResult,
  RenameFileResult,
  WatchOptions,
  WriteFileResult
} from './filesystem.js';

// Main Sandbox interface
export interface ISandbox {
  // Command execution
  exec(command: SandboxCommand, options?: ExecOptions): Promise<SandboxProcess>;
  getProcess(id: string): Promise<SandboxProcess | null>;
  listProcesses(): Promise<ProcessStatus[]>;

  // File operations
  writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options?: { encoding?: string }
  ): Promise<WriteFileResult>;
  readFile(
    path: string,
    options: { encoding: 'none' }
  ): Promise<ReadFileStreamResult>;
  readFile(
    path: string,
    options?: { encoding?: Exclude<FileEncoding, 'none'> }
  ): Promise<ReadFileResult>;
  readFileStream(path: string): Promise<ReadableStream<Uint8Array>>;
  watch(
    path: string,
    options?: WatchOptions
  ): Promise<ReadableStream<Uint8Array>>;
  checkChanges(
    path: string,
    options?: CheckChangesOptions
  ): Promise<CheckChangesResult>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<MkdirResult>;
  deleteFile(path: string): Promise<DeleteFileResult>;
  renameFile(
    oldPath: string,
    newPath: string,
    options?: Record<string, never>
  ): Promise<RenameFileResult>;
  moveFile(
    sourcePath: string,
    destinationPath: string,
    options?: Record<string, never>
  ): Promise<MoveFileResult>;
  listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult>;
  exists(path: string): Promise<FileExistsResult>;

  // Environment management
  setEnvVars(envVars: Record<string, string | undefined>): Promise<void>;

  // Bucket mounting operations
  mountBucket(
    bucket: string,
    mountPath: string,
    options: MountBucketOptions
  ): Promise<void>;
  unmountBucket(mountPath: string): Promise<void>;

  // Backup operations
  createBackup(options: BackupOptions): Promise<DirectoryBackup>;
  restoreBackup(backup: DirectoryBackup): Promise<RestoreBackupResult>;

  // WebSocket connection
  wsConnect(request: Request, port: number): Promise<Response>;

  // Terminal resources
  createTerminal(options: CreateTerminalOptions): Promise<Terminal>;
  getTerminal(id: string): Promise<Terminal | null>;
  listTerminals(): Promise<Terminal[]>;
}
