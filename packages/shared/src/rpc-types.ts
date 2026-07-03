/**
 * Shared interface types for the container-control path.
 *
 * Defines the contract between the SDK control client and the container
 * control-plane API. The current wire implementation uses capnweb RPC.
 */

import type { TerminalCreateOptions } from './pty-types.js';
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
  utils: SandboxUtilsAPI;
  backup: SandboxBackupAPI;
  watch: SandboxWatchAPI;
  tunnels: SandboxTunnelsAPI;
  terminals: SandboxTerminalsAPI;
  extensions: SandboxExtensionsAPI;
}

export interface CommandExecuteOptions {
  sessionId?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
  origin?: 'user' | 'internal';
}

export interface SandboxCommandsAPI {
  execute(
    command: string,
    options?: CommandExecuteOptions
  ): Promise<{
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    command: string;
    timestamp: string;
  }>;
}

export interface FileSessionOptions {
  sessionId?: string;
}

export interface ReadFileStreamOptions extends FileSessionOptions {}

export interface ReadFileBinaryOptions extends FileSessionOptions {
  encoding: 'none';
}

export interface ReadFileOptions extends FileSessionOptions {
  encoding?: Exclude<FileEncoding, 'none'>;
}

export interface WriteFileOptions extends FileSessionOptions {
  encoding?: string;
  permissions?: string;
}

export interface MkdirOptions extends FileSessionOptions {
  recursive?: boolean;
}

export interface SandboxFilesAPI {
  readFile(
    path: string,
    options: ReadFileBinaryOptions
  ): Promise<ReadFileStreamResult>;
  readFile(path: string, options?: ReadFileOptions): Promise<ReadFileResult>;
  readFileStream(
    path: string,
    options?: ReadFileStreamOptions
  ): Promise<ReadableStream<Uint8Array>>;
  writeFile(
    path: string,
    content: string,
    options?: WriteFileOptions
  ): Promise<WriteFileResult>;
  writeFileStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    options?: FileSessionOptions
  ): Promise<{
    success: boolean;
    path: string;
    bytesWritten: number;
    timestamp: string;
  }>;
  deleteFile(
    path: string,
    options?: FileSessionOptions
  ): Promise<DeleteFileResult>;
  renameFile(
    oldPath: string,
    newPath: string,
    options?: FileSessionOptions
  ): Promise<RenameFileResult>;
  moveFile(
    sourcePath: string,
    destinationPath: string,
    options?: FileSessionOptions
  ): Promise<MoveFileResult>;
  mkdir(path: string, options?: MkdirOptions): Promise<MkdirResult>;
  listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult>;
  exists(path: string, options?: FileSessionOptions): Promise<FileExistsResult>;
}

export interface ProcessStartOptions {
  sessionId?: string;
  processId?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
  encoding?: string;
  autoCleanup?: boolean;
  origin?: 'user' | 'internal';
  stdout?: 'pipe' | 'ignore';
  stderr?: 'pipe' | 'ignore' | 'combined';
}

export interface SandboxProcessesAPI {
  startProcess(
    command: string,
    options?: ProcessStartOptions,
    stdin?: ReadableStream<Uint8Array>
  ): Promise<ProcessStartResult>;
  listProcesses(): Promise<ProcessListResult>;
  getProcess(id: string): Promise<ProcessInfoResult>;
  killProcess(id: string, signal?: number): Promise<ProcessKillResult>;
  killAllProcesses(): Promise<ProcessCleanupResult>;
  getProcessLogs(id: string): Promise<ProcessLogsResult>;
  streamProcessLogs(id: string): Promise<ReadableStream<Uint8Array>>;
}

export interface SandboxPortsAPI {
  watchPort(request: PortWatchRequest): Promise<ReadableStream<Uint8Array>>;
}

export interface SessionCreateOptions {
  id: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  commandTimeoutMs?: number;
}

export interface SandboxUtilsAPI {
  ping(): Promise<string>;
  getVersion(): Promise<string>;
  getCommands(): Promise<string[]>;
  createSession(options: SessionCreateOptions): Promise<{
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

export interface BackupCreateArchiveOptions {
  sessionId?: string;
  excludes?: string[];
  gitignore?: boolean;
  compression?: BackupCompressionOptions;
}

export interface BackupRestoreArchiveOptions {
  sessionId?: string;
}

export interface SandboxBackupAPI {
  createArchive(
    dir: string,
    archivePath: string,
    options?: BackupCreateArchiveOptions
  ): Promise<CreateBackupResponse>;
  restoreArchive(
    dir: string,
    archivePath: string,
    options?: BackupRestoreArchiveOptions
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

export type TunnelRunMode = 'quick' | 'named';

export interface TunnelRunIdentity {
  tunnelId: string;
  runId: string;
}

export type TunnelRunRef = TunnelRunIdentity;

export interface EnsureQuickTunnelRunRequest extends TunnelRunIdentity {
  mode: 'quick';
  port: number;
  readyTimeoutMs?: number;
  stopGraceMs?: number;
}

export interface EnsureNamedTunnelRunRequest extends TunnelRunIdentity {
  mode: 'named';
  port: number;
  cloudflaredToken: string;
  readyTimeoutMs?: number;
  stopGraceMs?: number;
}

export type EnsureTunnelRunRequest =
  | EnsureQuickTunnelRunRequest
  | EnsureNamedTunnelRunRequest;

export interface QuickTunnelRunSnapshot extends TunnelRunIdentity {
  mode: 'quick';
  port: number;
  url: string;
  hostname: string;
  startedAt: string;
}

export interface NamedTunnelRunSnapshot extends TunnelRunIdentity {
  mode: 'named';
  port: number;
  startedAt: string;
}

export type TunnelRunSnapshot = QuickTunnelRunSnapshot | NamedTunnelRunSnapshot;

export interface EnsureTunnelRunResult {
  run: TunnelRunSnapshot;
  started: boolean;
}

export type StopTunnelRunRequest = TunnelRunRef;

export interface StopTunnelRunResult {
  stopped: boolean;
}

export interface TunnelRunExitEvent extends TunnelRunIdentity {
  mode: TunnelRunMode;
  port: number;
  exitCode: number | null;
}

export interface SandboxTerminalsAPI {
  createTerminal(
    options: TerminalCreateOptions
  ): Promise<{ success: true; id: string }>;
  destroyTerminal(id: string): Promise<{ success: true; id: string }>;
}

export interface SandboxTunnelsAPI {
  /** Ensure a runtime-local cloudflared process for a DO-issued run id. */
  ensureTunnelRun(
    request: EnsureTunnelRunRequest
  ): Promise<EnsureTunnelRunResult>;
  /** Stop the matching runtime-local cloudflared process. */
  stopTunnelRun(request: StopTunnelRunRequest): Promise<StopTunnelRunResult>;
}

// ---------------------------------------------------------------------------
// Extensions (sidecar host)
// ---------------------------------------------------------------------------

/**
 * Author-facing description of a sidecar extension. An extension is an
 * npm-style package: an `.tgz` whose embedded `package.json` declares the
 * sidecar entrypoint (via `bin`) and any extension metadata (under the
 * `sandboxExtension` key).
 *
 * The SDK ships the tarball bytes; the container hashes them, provisions a
 * dedicated directory keyed by content hash, derives identity from the
 * embedded `package.json`, installs the package with `bun add`, and spawns
 * the declared bin under Bun.
 *
 * `ExtensionPackage` carries tarball bytes produced by an extension build.
 * The SDK sends those bytes only when the container has not provisioned the
 * package hash yet.
 */
export interface ExtensionPackage {
  /** Raw `.tgz` bytes. */
  tarball: Uint8Array;
  /**
   * Bin entry to run when the embedded `package.json` declares more than one.
   * Defaults to the value of `sandboxExtension.bin` in `package.json`, then
   * to the single bin entry if there is exactly one.
   */
  bin?: string;
  /**
   * Max time to wait for the sidecar to accept a capnweb connection on its
   * unix socket. Falls back to `sandboxExtension.readinessTimeoutMs` in
   * `package.json`, then to a host default.
   */
  readinessTimeoutMs?: number;
  /**
   * Run lifecycle scripts during `bun add`. Defaults to false — provisioning
   * happens before the sidecar is supervised, so install-time side effects
   * are deliberately opt-in.
   */
  allowInstallScripts?: boolean;
}

/**
 * Container-derived identity for a provisioned extension package. Not
 * authored — produced by the host after extracting the embedded
 * `package.json` from a tarball.
 */
export interface ExtensionRegistration {
  /** Slugified package name (e.g. `@acme/foo` → `acme-foo`). */
  id: string;
  packageName: string;
  version: string;
  /** Hex sha256 of the tarball bytes. */
  packageHash: string;
  /** Resolved bin entry the host spawns. */
  bin: string;
  readinessTimeoutMs: number;
}

/** Health snapshot for a provisioned extension. */
export interface ExtensionHealth {
  packageHash: string;
  id: string;
  version: string;
  /** Tarball is on disk and the package.json has been read. */
  provisioned: boolean;
  /** Sidecar process is currently running. */
  running: boolean;
  pid: number | null;
  /** Whether a `__ping__` round-tripped over capnweb. */
  responsive: boolean;
}

/**
 * Connect request payload. The SDK hashes the tarball locally and first sends
 * only the hash. If the current host process has not provisioned that hash,
 * it responds with an `ExtensionTarballRequired` error and the SDK retries
 * with `tarball` populated.
 */
export interface ExtensionConnectRequest {
  packageHash: string;
  /** Only sent when the host has not seen this hash yet. */
  tarball?: Uint8Array;
  bin?: string;
  readinessTimeoutMs?: number;
  allowInstallScripts?: boolean;
}

/**
 * Error name thrown by the host's `connect` when it has not yet provisioned
 * the requested hash and the request did not carry tarball bytes. The SDK
 * recognises this name via `Error.name` and retries the connect with the
 * bytes attached. Kept as a string constant so it survives capnweb
 * cross-realm error reconstruction.
 */
export const EXTENSION_TARBALL_REQUIRED = 'ExtensionTarballRequired';

/**
 * Control surface for container sidecar extensions.
 *
 * `connect` is the only entry point: it provisions on first use, supervises
 * lazily, and returns the sidecar's capnweb remote main as a stub. Calls on
 * the stub are proxied through the container's capnweb session to the
 * sidecar's capnweb session — callback parameters (including streaming
 * handlers) round-trip across both hops.
 */
export interface SandboxExtensionsAPI {
  /**
   * Provision the package (if new) and return the sidecar's typed remote
   * main. The result is a capnweb stub whose methods correspond to the
   * sidecar's `RpcTarget` surface.
   */
  connect(req: ExtensionConnectRequest): Promise<unknown>;
  /** Health snapshot, probing the sidecar with a `__ping__` when running. */
  health(packageHash: string): Promise<ExtensionHealth>;
  /** Stop a sidecar and release its capnweb session. */
  stop(packageHash: string): Promise<void>;
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
  /** Called by the container when a runtime-local tunnel run exits. */
  onTunnelRunExit(event: TunnelRunExitEvent): Promise<void>;
}
