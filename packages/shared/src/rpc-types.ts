/**
 * Shared interface types for the container-control path.
 *
 * Defines the contract between the SDK control client and the container
 * control-plane API. The current wire implementation uses capnweb RPC.
 */

import type {
  DesktopCursorPosition,
  DesktopMouseButton,
  DesktopProcessHealth,
  DesktopScreenSize,
  DesktopScreenshotBytesResult,
  DesktopScreenshotOptions,
  DesktopScreenshotRegion,
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
  RestoreBackupResponse,
  UploadedPart,
  UploadPartsResponse
} from './request-types.js';
import type {
  BackupCompressionOptions,
  CheckChangesRequest,
  CheckChangesResult,
  DeleteFileResult,
  FileEncoding,
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
  ReadFileStreamResult,
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
  tunnels: SandboxTunnelsAPI;
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
    options: { encoding: 'none' }
  ): Promise<ReadFileStreamResult>;
  readFile(
    path: string,
    sessionId: string,
    options?: { encoding?: Exclude<FileEncoding, 'none'> }
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
    containerPlacementId?: string | null;
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
    options?: {
      excludes?: string[];
      gitignore?: boolean;
      compression?: BackupCompressionOptions;
    }
  ): Promise<CreateBackupResponse>;
  restoreArchive(
    dir: string,
    archivePath: string,
    sessionId: string
  ): Promise<RestoreBackupResponse>;
  uploadParts(request: {
    archivePath: string;
    parts: Array<{
      partNumber: number;
      url: string;
      offset: number;
      size: number;
    }>;
    sessionId?: string;
  }): Promise<UploadPartsResponse>;
}

export type { UploadedPart, UploadPartsResponse };

export interface SandboxDesktopAPI {
  start(options?: {
    resolution?: [number, number];
    dpi?: number;
  }): Promise<DesktopStartResult>;
  stop(): Promise<DesktopStopResult>;
  status(): Promise<DesktopStatusResult>;
  screenshot(
    options?: DesktopScreenshotOptions & { format?: 'base64' }
  ): Promise<DesktopScreenshotResult>;
  screenshot(
    options: DesktopScreenshotOptions & { format: 'bytes' }
  ): Promise<DesktopScreenshotBytesResult>;
  screenshot(
    options?: DesktopScreenshotOptions
  ): Promise<DesktopScreenshotResult | DesktopScreenshotBytesResult>;
  screenshotRegion(
    region: DesktopScreenshotRegion,
    options?: DesktopScreenshotOptions & { format?: 'base64' }
  ): Promise<DesktopScreenshotResult>;
  screenshotRegion(
    region: DesktopScreenshotRegion,
    options: DesktopScreenshotOptions & { format: 'bytes' }
  ): Promise<DesktopScreenshotBytesResult>;
  screenshotRegion(
    region: DesktopScreenshotRegion,
    options?: DesktopScreenshotOptions
  ): Promise<DesktopScreenshotResult | DesktopScreenshotBytesResult>;
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
  type(text: string, options?: { delayMs?: number }): Promise<void>;
  press(key: string): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  getScreenSize(): Promise<DesktopScreenSize>;
  getProcessStatus(name: string): Promise<DesktopProcessHealth>;
}

export interface SandboxWatchAPI {
  watch(request: WatchRequest): Promise<ReadableStream<Uint8Array>>;
  checkChanges(request: CheckChangesRequest): Promise<CheckChangesResult>;
}

/**
 * Public-facing tunnel record.
 *
 * Today only quick tunnels (`*.trycloudflare.com`) are supported. Future
 * PRs will add named tunnels, which will carry a `name: string` field;
 * `TunnelInfo` will then become a discriminated union keyed on the
 * presence of `name`. The quick variant declares `name?: never` so the
 * narrowing works without a breaking change here.
 */
export interface TunnelInfo {
  id: string;
  port: number;
  url: string;
  hostname: string;
  createdAt: string;
  /** Reserved for the named-tunnel variant in a future PR. */
  name?: never;
}

export interface SandboxTunnelsAPI {
  /** Spawn `cloudflared tunnel --url`. No credentials required. */
  runQuickTunnel(id: string, port: number): Promise<TunnelInfo>;
  /**
   * Spawn `cloudflared tunnel run --token <token> --url http://localhost:<port>`.
   *
   * The SDK is the source of truth for the hostname this tunnel binds to;
   * the container only sees the opaque token and the local port. The
   * returned `TunnelInfo` carries empty `url`/`hostname` fields — the SDK
   * enriches them with the values from the Cloudflare API before handing
   * the record to user code.
   *
   * The token must never be logged, persisted, or echoed back to callers.
   */
  runNamedTunnel(id: string, token: string, port: number): Promise<TunnelInfo>;
  /** Stop the cloudflared process for the given tunnel id. */
  destroyTunnel(id: string): Promise<{ success: true; id: string }>;
  /** List tunnels currently running inside the container. */
  listTunnels(): Promise<TunnelInfo[]>;
}

/**
 * RPC surface the Sandbox DO exposes to the container over the existing
 * capnweb session. The container reaches it via
 * `session.getRemoteMain<SandboxControlCallback>()` and invokes methods
 * to push control-plane events (today: tunnel exits) back to the DO.
 *
 * One stable target per sandbox; not per-tunnel. Reusable seam for
 * future container→DO events.
 */
export interface SandboxControlCallback {
  /**
   * Called by the container when a `cloudflared` process exits for any
   * reason — SIGTERM from `destroyTunnel`, container-initiated SIGKILL,
   * network failure, segfault. `exitCode` is `null` if the process was
   * signalled rather than exited cleanly.
   */
  onTunnelExit(
    id: string,
    port: number,
    exitCode: number | null
  ): Promise<void>;
}
