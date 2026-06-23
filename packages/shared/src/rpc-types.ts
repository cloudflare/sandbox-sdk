/**
 * Shared interface types for the container-control path.
 *
 * Defines the contract between the SDK control client and the container
 * control-plane API. The current wire implementation uses capnweb RPC.
 */

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
      origin?: 'user' | 'internal';
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
      origin?: 'user' | 'internal';
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

export interface SandboxWatchAPI {
  watch(request: WatchRequest): Promise<ReadableStream<Uint8Array>>;
  checkChanges(request: CheckChangesRequest): Promise<CheckChangesResult>;
}

/**
 * Public-facing tunnel record. Discriminated on the presence of `name`:
 * quick tunnels (`*.trycloudflare.com`) omit it, named tunnels carry the
 * label that was passed to `get(port, { name })`.
 */
export type TunnelInfo = QuickTunnelInfo | NamedTunnelInfo;

export interface QuickTunnelInfo {
  id: string;
  port: number;
  /** `https://<random>.trycloudflare.com`. */
  url: string;
  /** Hostname portion of `url`. */
  hostname: string;
  createdAt: string;
  /** Absent on quick tunnels; narrows the union. */
  name?: never;
}

export interface NamedTunnelInfo {
  /** Cloudflare tunnel UUID (8-4-4-4-12). */
  id: string;
  port: number;
  /** `https://<hostname>`. */
  url: string;
  /** Full hostname bound to the tunnel (without scheme). */
  hostname: string;
  createdAt: string;
  /** Label originally passed via `TunnelOptions.name`. */
  name: string;
}

/**
 * Options accepted by `sandbox.tunnels.get(port, options)`. Omitting
 * `name` (or omitting the options object) selects the zero-config quick
 * tunnel; setting `name` selects the named-tunnel flow.
 */
export interface TunnelOptions {
  /**
   * Single DNS label under the configured zone. The full hostname is
   * `<name>.<zone-name>`. See `validateTunnelName` for the format rules.
   */
  name?: string;
}

// ---------------------------------------------------------------------------
// Runtime-run tunnel control types
// ---------------------------------------------------------------------------

/**
 * Stable logical identity for a single cloudflared process run.
 * `tunnelId` is SDK-issued; `runId` is a per-run nonce minted by the SDK
 * to support idempotent admission and stale-callback fencing.
 */
export interface TunnelRunIdentity {
  tunnelId: string;
  runId: string;
}

/** Discriminator for quick vs. named cloudflared modes. */
export type TunnelRunMode = 'quick' | 'named';

/** Request to start or replay a quick tunnel run. */
export interface EnsureQuickTunnelRunRequest {
  tunnelId: string;
  runId: string;
  mode: 'quick';
  port: number;
}

/**
 * Request to start or replay a named tunnel run.
 * `token` is named-mode only and must never be persisted or logged.
 */
export interface EnsureNamedTunnelRunRequest {
  tunnelId: string;
  runId: string;
  mode: 'named';
  port: number;
  /** Opaque Cloudflare tunnel token. Never logged or stored. */
  token: string;
}

export type EnsureTunnelRunRequest =
  | EnsureQuickTunnelRunRequest
  | EnsureNamedTunnelRunRequest;

/**
 * Runtime-local snapshot of a running cloudflared process.
 * Quick tunnels carry `url` and `hostname`; named tunnels leave them absent
 * because the SDK owns the hostname via the Cloudflare API.
 */
export interface TunnelRunSnapshot {
  tunnelId: string;
  runId: string;
  mode: TunnelRunMode;
  port: number;
  /** Public URL for quick tunnels (absent on named). */
  url?: string;
  /** Hostname portion of `url` for quick tunnels (absent on named). */
  hostname?: string;
  startedAt: string;
}

export interface EnsureTunnelRunResult {
  run: TunnelRunSnapshot;
  /** `true` when this call spawned the process; `false` on idempotent replay. */
  started: boolean;
}

export type StopTunnelRunRequest = TunnelRunIdentity;

export interface StopTunnelRunResult {
  /** `true` when the exact run was found and stopped; `false` otherwise. */
  stopped: boolean;
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
  /**
   * Start or replay a cloudflared process run identified by `(tunnelId, runId)`.
   * Same `runId` with same params is idempotent (`started: false`).
   * Same `runId` with different params, or a different active run on the
   * same port or tunnelId, returns a `TUNNEL_RUN_CONFLICT` error.
   */
  ensureTunnelRun(
    request: EnsureTunnelRunRequest
  ): Promise<EnsureTunnelRunResult>;
  /**
   * Stop the cloudflared process identified by the exact `(tunnelId, runId)` pair.
   * Returns `{ stopped: true }` when the run was found and stopped;
   * `{ stopped: false }` when no matching run is active (service success).
   */
  stopTunnelRun(request: StopTunnelRunRequest): Promise<StopTunnelRunResult>;
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
    exitCode: number | null,
    runId?: string
  ): Promise<void>;
}
