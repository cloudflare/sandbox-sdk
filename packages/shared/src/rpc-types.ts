/**
 * Shared RPC interface types for the capnweb transport layer.
 *
 * Defines the contract between the SDK client (ContainerConnection) and the
 * container server (SandboxAPI). Both sides must implement or satisfy
 * these interfaces to ensure type-safe communication.
 */

import type {
  DesktopCursorPosition,
  DesktopMouseButton,
  DesktopScreenSize,
  DesktopScreenshotRegionRequest,
  DesktopScreenshotRequest,
  DesktopScreenshotResult,
  DesktopScrollDirection,
  DesktopStartResult,
  DesktopStatusResult,
  DesktopStopResult
} from './desktop-types.js';
import type {
  CodeContext,
  CreateContextOptions,
  ExecutionError,
  OutputMessage,
  Result
} from './interpreter-types.js';
import type {
  CreateBackupResponse,
  RestoreBackupResponse
} from './request-types.js';
import type {
  CheckChangesRequest,
  CheckChangesResult,
  DeleteFileResult,
  FileExistsResult,
  GitCheckoutResult,
  ListFilesOptions,
  ListFilesResult,
  MkdirResult,
  MoveFileResult,
  PortCloseResult,
  PortExposeResult,
  PortListResult,
  PortWatchRequest,
  ProcessCleanupResult,
  ProcessInfoResult,
  ProcessKillResult,
  ProcessListResult,
  ProcessLogsResult,
  ProcessStartResult,
  ReadFileResult,
  RenameFileResult,
  WatchRequest,
  WriteFileResult
} from './types.js';

export interface SandboxAPI {
  commands: SandboxCommandsAPI;
  files: SandboxFilesAPI;
  processes: SandboxProcessesAPI;
  ports: SandboxPortsAPI;
  git: SandboxGitAPI;
  interpreter: SandboxInterpreterAPI;
  utils: SandboxUtilsAPI;
  backup: SandboxBackupAPI;
  desktop: SandboxDesktopAPI;
  watch: SandboxWatchAPI;
}

export interface SandboxCommandsAPI {
  execute(
    command: string,
    sessionId: string,
    options?: {
      timeoutMs?: number;
      env?: Record<string, string | undefined>;
      cwd?: string;
    }
  ): Promise<{
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    command: string;
    timestamp: string;
  }>;
  executeStream(
    command: string,
    sessionId: string,
    options?: {
      timeoutMs?: number;
      env?: Record<string, string | undefined>;
      cwd?: string;
    }
  ): Promise<ReadableStream<Uint8Array>>;
}

export interface SandboxFilesAPI {
  readFile(
    path: string,
    sessionId: string,
    options?: { encoding?: string }
  ): Promise<ReadFileResult>;
  readFileStream(
    path: string,
    sessionId: string
  ): Promise<ReadableStream<Uint8Array>>;
  writeFile(
    path: string,
    content: string,
    sessionId: string,
    options?: { encoding?: string; permissions?: string }
  ): Promise<WriteFileResult>;
  writeFileStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    sessionId: string
  ): Promise<{
    success: boolean;
    path: string;
    bytesWritten: number;
    timestamp: string;
  }>;
  deleteFile(path: string, sessionId: string): Promise<DeleteFileResult>;
  renameFile(
    oldPath: string,
    newPath: string,
    sessionId: string
  ): Promise<RenameFileResult>;
  moveFile(
    sourcePath: string,
    destinationPath: string,
    sessionId: string
  ): Promise<MoveFileResult>;
  mkdir(
    path: string,
    sessionId: string,
    options?: { recursive?: boolean }
  ): Promise<MkdirResult>;
  listFiles(
    path: string,
    sessionId: string,
    options?: ListFilesOptions
  ): Promise<ListFilesResult>;
  exists(path: string, sessionId: string): Promise<FileExistsResult>;
}

export interface SandboxProcessesAPI {
  startProcess(
    command: string,
    sessionId: string,
    options?: { processId?: string; timeoutMs?: number }
  ): Promise<ProcessStartResult>;
  listProcesses(): Promise<ProcessListResult>;
  getProcess(id: string): Promise<ProcessInfoResult>;
  killProcess(id: string): Promise<ProcessKillResult>;
  killAllProcesses(): Promise<ProcessCleanupResult>;
  getProcessLogs(id: string): Promise<ProcessLogsResult>;
  streamProcessLogs(id: string): Promise<ReadableStream<Uint8Array>>;
}

export interface SandboxPortsAPI {
  exposePort(
    port: number,
    sessionId: string,
    name?: string
  ): Promise<PortExposeResult>;
  getExposedPorts(sessionId: string): Promise<PortListResult>;
  unexposePort(port: number, sessionId: string): Promise<PortCloseResult>;
  watchPort(request: PortWatchRequest): Promise<ReadableStream<Uint8Array>>;
}

export interface SandboxGitAPI {
  checkout(
    repoUrl: string,
    sessionId: string,
    options?: {
      branch?: string;
      targetDir?: string;
      depth?: number;
      timeoutMs?: number;
    }
  ): Promise<GitCheckoutResult>;
}

export interface SandboxInterpreterAPI {
  createCodeContext(options?: CreateContextOptions): Promise<CodeContext>;
  streamCode(
    contextId: string,
    code: string,
    language?: string
  ): Promise<ReadableStream<Uint8Array>>;
  runCodeStream(
    contextId: string | undefined,
    code: string,
    language: string | undefined,
    callbacks: {
      onStdout?: (output: OutputMessage) => void | Promise<void>;
      onStderr?: (output: OutputMessage) => void | Promise<void>;
      onResult?: (result: Result) => void | Promise<void>;
      onError?: (error: ExecutionError) => void | Promise<void>;
    },
    timeoutMs?: number
  ): Promise<void>;
  listCodeContexts(): Promise<CodeContext[]>;
  deleteCodeContext(contextId: string): Promise<void>;
}

export interface SandboxUtilsAPI {
  ping(): Promise<string>;
  getVersion(): Promise<string>;
  getCommands(): Promise<string[]>;
  createSession(options: {
    id: string;
    env?: Record<string, string | undefined>;
    cwd?: string;
  }): Promise<{
    success: boolean;
    id: string;
    message: string;
    timestamp: string;
  }>;
  deleteSession(
    sessionId: string
  ): Promise<{ success: boolean; sessionId: string; timestamp: string }>;
  listSessions(): Promise<{ sessions: string[] }>;
}

export interface SandboxBackupAPI {
  createArchive(
    dir: string,
    archivePath: string,
    sessionId: string,
    options?: { excludes?: string[]; gitignore?: boolean }
  ): Promise<CreateBackupResponse>;
  restoreArchive(
    dir: string,
    archivePath: string,
    sessionId: string
  ): Promise<RestoreBackupResponse>;
}

export interface SandboxDesktopAPI {
  start(options?: {
    resolution?: [number, number];
    dpi?: number;
  }): Promise<DesktopStartResult>;
  stop(): Promise<DesktopStopResult>;
  status(): Promise<DesktopStatusResult>;
  screenshot(
    options?: DesktopScreenshotRequest
  ): Promise<DesktopScreenshotResult>;
  screenshotRegion(
    request: DesktopScreenshotRegionRequest
  ): Promise<DesktopScreenshotResult>;
  click(
    x: number,
    y: number,
    options?: { button?: DesktopMouseButton; clickCount?: number }
  ): Promise<void>;
  doubleClick(x: number, y: number): Promise<void>;
  tripleClick(x: number, y: number): Promise<void>;
  rightClick(x: number, y: number): Promise<void>;
  middleClick(x: number, y: number): Promise<void>;
  mouseDown(
    x?: number,
    y?: number,
    options?: { button?: DesktopMouseButton }
  ): Promise<void>;
  mouseUp(
    x?: number,
    y?: number,
    options?: { button?: DesktopMouseButton }
  ): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;
  drag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    options?: { button?: DesktopMouseButton }
  ): Promise<void>;
  scroll(
    x: number,
    y: number,
    direction: DesktopScrollDirection,
    amount?: number
  ): Promise<void>;
  getCursorPosition(): Promise<DesktopCursorPosition>;
  type(text: string, options?: { delay?: number }): Promise<void>;
  press(key: string): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  getScreenSize(): Promise<DesktopScreenSize>;
  getProcessStatus(name: string): Promise<DesktopStatusResult>;
}

export interface SandboxWatchAPI {
  watch(request: WatchRequest): Promise<ReadableStream<Uint8Array>>;
  checkChanges(request: CheckChangesRequest): Promise<CheckChangesResult>;
}
