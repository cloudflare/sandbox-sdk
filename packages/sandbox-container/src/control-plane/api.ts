import type {
  BackupCreateArchiveOptions,
  BackupRestoreArchiveOptions,
  CheckChangesRequest,
  CheckChangesResult,
  CommandExecuteOptions,
  EnsureTunnelRunRequest,
  EnsureTunnelRunResult,
  ExtensionConnectRequest,
  ExtensionHealth,
  FileEncoding,
  FileInfo,
  FileSessionOptions,
  GitCheckoutOptions,
  ListFilesOptions,
  Logger,
  MkdirOptions,
  ProcessStartOptions,
  ReadFileBinaryOptions,
  ReadFileOptions,
  ReadFileStreamOptions,
  SandboxAPI,
  StopTunnelRunRequest,
  StopTunnelRunResult,
  TunnelInfo,
  WatchRequest,
  WriteFileOptions
} from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import { RpcTarget } from 'capnweb';
import type {
  CommandResult,
  ProcessRecord,
  ServiceError,
  ServiceResult
} from '../core/types';
import type { ExtensionHost } from '../extensions';
import type { BackupService } from '../services/backup-service';
import type { FileService } from '../services/file-service';
import type { GitService } from '../services/git-service';
import type { PortService } from '../services/port-service';
import type { ProcessService } from '../services/process-service';
import type { SessionManager } from '../services/session-manager';
import type { TerminalManager } from '../services/terminal-manager';
import type { TunnelService } from '../services/tunnel-service';
import type { WatchService } from '../services/watch-service';

export interface SandboxAPIDeps {
  processService: ProcessService;
  fileService: FileService;
  portService: PortService;
  gitService: GitService;
  backupService: BackupService;
  watchService: WatchService;
  tunnelService: TunnelService;
  terminalManager: TerminalManager;
  extensionHost: ExtensionHost;
  sessionManager: SessionManager;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// RPC error helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any ServiceResult variant
function throwIfError(result: ServiceResult<any, any>): void {
  if (!result.success) {
    const { code, message, details } = result.error;
    throw Object.assign(new Error(message), { code, details });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any ServiceResult variant
function extractData<T>(result: ServiceResult<any, any>): T {
  throwIfError(result);
  return (result as { data: T }).data;
}

/**
 * Container control-plane API exposed over capnweb.
 *
 * Each domain is exposed as a nested RpcTarget so the client can access
 * them directly as `commands`, `files`, etc. Top-level methods handle
 * utility and session management.
 */
export class SandboxControlAPI extends RpcTarget implements SandboxAPI {
  #deps: SandboxAPIDeps;

  constructor(deps: SandboxAPIDeps) {
    super();
    this.#deps = deps;
  }

  // --- Domain sub-stubs (nested RpcTargets) --------------------------------

  get commands() {
    return new CommandsRPCAPI(this.#deps.processService);
  }
  get files() {
    return new FilesRPCAPI(this.#deps.fileService);
  }
  get processes() {
    return new ProcessesRPCAPI(this.#deps.processService);
  }
  get ports() {
    return new PortsRPCAPI(this.#deps.portService, this.#deps.processService);
  }
  get git() {
    return new GitRPCAPI(this.#deps.gitService);
  }
  get utils() {
    return new UtilsRPCAPI(this.#deps.sessionManager);
  }
  get backup() {
    return new BackupRPCAPI(this.#deps.backupService);
  }
  get watch() {
    return new WatchRPCAPI(this.#deps.watchService);
  }
  get tunnels() {
    return new TunnelsRPCAPI(this.#deps.tunnelService);
  }
  get terminals() {
    return new TerminalsRPCAPI(this.#deps.terminalManager);
  }
  get extensions() {
    return new ExtensionsRPCAPI(this.#deps.extensionHost);
  }
}

// ===========================================================================
// Terminals
// ===========================================================================

class TerminalsRPCAPI extends RpcTarget {
  #terminalManager: TerminalManager;

  constructor(terminalManager: TerminalManager) {
    super();
    this.#terminalManager = terminalManager;
  }

  async createTerminal(options: {
    id: string;
    cwd?: string;
    shell?: string;
    cols?: number;
    rows?: number;
  }): Promise<{ success: true; id: string }> {
    await this.#terminalManager.getOrCreateTerminal({
      id: options.id,
      cwd: options.cwd,
      pty: { shell: options.shell, cols: options.cols, rows: options.rows }
    });
    return { success: true, id: options.id };
  }

  async destroyTerminal(id: string): Promise<{ success: true; id: string }> {
    await this.#terminalManager.destroyTerminal(id);
    return { success: true, id };
  }
}

// ===========================================================================
// Commands
// ===========================================================================

class CommandsRPCAPI extends RpcTarget {
  #svc: ProcessService;
  constructor(svc: ProcessService) {
    super();
    this.#svc = svc;
  }

  async execute(
    command: string,
    options?: CommandExecuteOptions
  ): Promise<{
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    command: string;
    timestamp: string;
  }> {
    const result = await this.#svc.executeCommand(command, {
      sessionId: options?.sessionId,
      timeoutMs: options?.timeoutMs,
      env: options?.env,
      cwd: options?.cwd,
      origin: options?.origin
    });
    const data = extractData<CommandResult>(result);
    return {
      success: data.success,
      exitCode: data.exitCode,
      stdout: data.stdout,
      stderr: data.stderr,
      command,
      timestamp: new Date().toISOString()
    };
  }
}

// ===========================================================================
// Files
// ===========================================================================

class FilesRPCAPI extends RpcTarget {
  #svc: FileService;
  constructor(svc: FileService) {
    super();
    this.#svc = svc;
  }

  async readFile(
    path: string,
    options: ReadFileBinaryOptions
  ): Promise<{
    success: true;
    content: ReadableStream<Uint8Array>;
    path: string;
    size: number;
    mimeType: string;
    timestamp: string;
  }>;
  async readFile(
    path: string,
    options?: ReadFileOptions
  ): Promise<{
    success: true;
    content: string;
    path: string;
    encoding: 'utf-8' | 'base64';
    isBinary: boolean | undefined;
    size: number;
    mimeType: string;
    timestamp: string;
  }>;
  async readFile(
    path: string,
    options: { encoding?: FileEncoding; sessionId?: string } = {}
  ) {
    const { sessionId, ...readOptions } = options;

    if (options.encoding === 'none') {
      const result = await this.#svc.readFileBinaryStream(path, sessionId);
      const { content, size, mimeType } = extractData<{
        content: ReadableStream<Uint8Array>;
        size: number;
        mimeType: string;
      }>(result);
      return {
        success: true,
        content,
        path,
        size,
        mimeType,
        timestamp: new Date().toISOString()
      };
    }
    const result = await this.#svc.readFile(path, readOptions, sessionId);
    const content = extractData<string>(result);
    const metadata = (
      result as {
        metadata?: {
          encoding?: string;
          isBinary?: boolean;
          mimeType?: string;
          size?: number;
        };
      }
    ).metadata;
    return {
      success: true,
      content,
      path,
      encoding: (metadata?.encoding ?? (options.encoding || 'utf-8')) as
        | 'utf-8'
        | 'base64',
      isBinary: metadata?.isBinary,
      size: metadata?.size ?? content.length,
      mimeType: metadata?.mimeType ?? 'text/plain',
      timestamp: new Date().toISOString()
    };
  }

  async readFileStream(
    path: string,
    options: ReadFileStreamOptions = {}
  ): Promise<ReadableStream<Uint8Array>> {
    return this.#svc.readFileStreamOperation(path, options.sessionId);
  }

  async writeFile(
    path: string,
    content: string,
    options: WriteFileOptions = {}
  ) {
    const { sessionId, ...writeOptions } = options;
    const result = await this.#svc.writeFile(
      path,
      content,
      writeOptions,
      sessionId
    );
    throwIfError(result);
    return {
      success: true,
      path,
      bytesWritten: new TextEncoder().encode(content).byteLength,
      timestamp: new Date().toISOString()
    };
  }

  async writeFileStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    options: FileSessionOptions = {}
  ) {
    const result = await this.#svc.writeFileStream(
      path,
      stream,
      options.sessionId
    );
    throwIfError(result);
    const data = (result as { data?: { bytesWritten: number } }).data;
    return {
      success: true,
      path,
      bytesWritten: data?.bytesWritten ?? 0,
      timestamp: new Date().toISOString()
    };
  }

  async deleteFile(path: string, options: FileSessionOptions = {}) {
    const result = await this.#svc.deleteFile(path, options.sessionId);
    throwIfError(result);
    return { success: true, path, timestamp: new Date().toISOString() };
  }

  async renameFile(
    oldPath: string,
    newPath: string,
    options: FileSessionOptions = {}
  ) {
    const result = await this.#svc.renameFile(
      oldPath,
      newPath,
      options.sessionId
    );
    throwIfError(result);
    return {
      success: true,
      path: oldPath,
      /** @deprecated */ oldPath,
      newPath,
      timestamp: new Date().toISOString()
    };
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string,
    options: FileSessionOptions = {}
  ) {
    const result = await this.#svc.moveFile(
      sourcePath,
      destinationPath,
      options.sessionId
    );
    throwIfError(result);
    return {
      success: true,
      path: sourcePath,
      newPath: destinationPath,
      timestamp: new Date().toISOString()
    };
  }

  async mkdir(path: string, options: MkdirOptions = {}) {
    const { sessionId, ...mkdirOptions } = options;
    const result = await this.#svc.createDirectory(
      path,
      mkdirOptions,
      sessionId
    );
    throwIfError(result);
    return {
      success: true,
      path,
      recursive: options.recursive ?? false,
      timestamp: new Date().toISOString()
    };
  }

  async listFiles(
    path: string,
    options: ListFilesOptions = {}
  ): Promise<{
    success: boolean;
    files: FileInfo[];
    count: number;
    path: string;
    timestamp: string;
  }> {
    const { sessionId, ...listOptions } = options;
    const result = await this.#svc.listFiles(path, listOptions, sessionId);
    const files = extractData<FileInfo[]>(result);
    return {
      success: true,
      files,
      count: files.length,
      path,
      timestamp: new Date().toISOString()
    };
  }

  async exists(path: string, options: FileSessionOptions = {}) {
    const result = await this.#svc.exists(path, options.sessionId);
    const exists = extractData<boolean>(result);
    return { success: true, exists, path, timestamp: new Date().toISOString() };
  }
}

// ===========================================================================
// Processes
// ===========================================================================

class ProcessesRPCAPI extends RpcTarget {
  #svc: ProcessService;
  constructor(svc: ProcessService) {
    super();
    this.#svc = svc;
  }

  async startProcess(command: string, options: ProcessStartOptions = {}) {
    const result = await this.#svc.startProcess(command, options);
    const proc = extractData<ProcessRecord>(result);
    return {
      success: true,
      processId: proc.id,
      pid: proc.pid,
      command: proc.command,
      timestamp: proc.startTime.toISOString()
    };
  }

  async listProcesses() {
    const result = await this.#svc.listProcesses();
    const procs = extractData<ProcessRecord[]>(result);
    return {
      success: true,
      processes: procs.map((p) => ({
        id: p.id,
        pid: p.pid,
        command: p.command,
        status: p.status,
        startTime: p.startTime.toISOString(),
        exitCode: p.exitCode
      })),
      timestamp: new Date().toISOString()
    };
  }

  async getProcess(id: string) {
    const result = await this.#svc.getProcess(id);
    const proc = extractData<ProcessRecord>(result);
    return {
      success: true,
      process: {
        id: proc.id,
        pid: proc.pid,
        command: proc.command,
        status: proc.status,
        startTime: proc.startTime.toISOString(),
        exitCode: proc.exitCode
      },
      timestamp: new Date().toISOString()
    };
  }

  async killProcess(id: string) {
    const result = await this.#svc.killProcess(id);
    throwIfError(result);
    return {
      success: true,
      processId: id,
      timestamp: new Date().toISOString()
    };
  }

  async killAllProcesses() {
    const result = await this.#svc.killAllProcesses();
    const count = extractData<number>(result);
    return {
      success: true,
      cleanedCount: count,
      timestamp: new Date().toISOString()
    };
  }

  async getProcessLogs(id: string) {
    const result = await this.#svc.getProcess(id);
    const proc = extractData<ProcessRecord>(result);
    return {
      success: true,
      processId: id,
      stdout: proc.stdout,
      stderr: proc.stderr,
      timestamp: new Date().toISOString()
    };
  }

  async streamProcessLogs(id: string): Promise<ReadableStream<Uint8Array>> {
    const encoder = new TextEncoder();
    const result = await this.#svc.getProcess(id);
    const proc = extractData<ProcessRecord>(result);

    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (proc.stdout) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'stdout', data: proc.stdout, processId: id, timestamp: new Date().toISOString() })}\n\n`
            )
          );
        }
        if (proc.stderr) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'stderr', data: proc.stderr, processId: id, timestamp: new Date().toISOString() })}\n\n`
            )
          );
        }
        if (proc.status !== 'running') {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'exit', exitCode: proc.exitCode, processId: id, timestamp: new Date().toISOString() })}\n\n`
            )
          );
          controller.close();
          return;
        }

        const listener = (type: 'stdout' | 'stderr', data: string) => {
          try {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type, data, processId: id, timestamp: new Date().toISOString() })}\n\n`
              )
            );
          } catch {
            /* Stream closed */
          }
        };
        proc.outputListeners.add(listener);

        const statusListener = (status: string) => {
          if (['completed', 'failed', 'killed', 'error'].includes(status)) {
            try {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: 'exit', exitCode: proc.exitCode, processId: id, timestamp: new Date().toISOString() })}\n\n`
                )
              );
              controller.close();
            } catch {
              /* Stream closed */
            }
            proc.outputListeners.delete(listener);
            proc.statusListeners.delete(statusListener);
          }
        };
        proc.statusListeners.add(statusListener);
      }
    });
  }
}

// ===========================================================================
// Ports
// ===========================================================================

class PortsRPCAPI extends RpcTarget {
  #portSvc: PortService;
  #procSvc: ProcessService;
  constructor(portSvc: PortService, procSvc: ProcessService) {
    super();
    this.#portSvc = portSvc;
    this.#procSvc = procSvc;
  }

  async watchPort(request: {
    port: number;
    mode: 'http' | 'tcp';
    path?: string;
    statusMin?: number;
    statusMax?: number;
    processId?: string;
    interval?: number;
  }): Promise<ReadableStream<Uint8Array>> {
    const encoder = new TextEncoder();
    const {
      port,
      mode,
      path,
      statusMin,
      statusMax,
      processId,
      interval = 500
    } = request;
    const portSvc = this.#portSvc;
    const procSvc = this.#procSvc;
    let cancelled = false;
    const clampedInterval = Math.max(100, Math.min(interval, 10000));

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: Record<string, unknown>) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        };
        emit({ type: 'watching', port });
        try {
          while (!cancelled) {
            if (processId) {
              const processResult = await procSvc.getProcess(processId);
              if (!processResult.success) {
                emit({ type: 'error', port, error: 'Process not found' });
                return;
              }
              const proc = processResult.data;
              if (
                ['completed', 'failed', 'killed', 'error'].includes(proc.status)
              ) {
                emit({
                  type: 'process_exited',
                  port,
                  exitCode: proc.exitCode ?? undefined
                });
                return;
              }
            }
            const result = await portSvc.checkPortReady({
              port,
              mode,
              path,
              statusMin,
              statusMax
            });
            if (result.ready) {
              emit({ type: 'ready', port, statusCode: result.statusCode });
              return;
            }
            await new Promise((resolve) =>
              setTimeout(resolve, clampedInterval)
            );
          }
        } catch (error) {
          emit({
            type: 'error',
            port,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        } finally {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      }
    });
  }
}

// ===========================================================================
// Git
// ===========================================================================

class GitRPCAPI extends RpcTarget {
  #svc: GitService;
  constructor(svc: GitService) {
    super();
    this.#svc = svc;
  }

  async checkout(repoUrl: string, options: GitCheckoutOptions = {}) {
    const result = await this.#svc.cloneRepository(repoUrl, options);
    const data = extractData<{ path: string; branch: string }>(result);
    return {
      success: true,
      repoUrl,
      branch: data.branch ?? '',
      targetDir: data.path,
      timestamp: new Date().toISOString()
    };
  }
}

// ===========================================================================
// Utility
// ===========================================================================

class UtilsRPCAPI extends RpcTarget {
  #mgr: SessionManager;
  constructor(mgr: SessionManager) {
    super();
    this.#mgr = mgr;
  }

  async ping(): Promise<string> {
    return 'healthy';
  }

  async getVersion(): Promise<string> {
    try {
      return process.env.SANDBOX_VERSION || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Currently empty — the container does not maintain a command registry. */
  async getCommands(): Promise<string[]> {
    return [];
  }

  async createSession(options: {
    id: string;
    env?: Record<string, string | undefined>;
    cwd?: string;
  }) {
    const result = await this.#mgr.createSession(options);
    if (
      !result.success &&
      result.error.code === ErrorCode.SESSION_ALREADY_EXISTS
    ) {
      // Mirror the HTTP handler: surface placement ID on the duplicate-create
      // path so a restarted DO can capture it from the idempotent retry.
      const { code, message, details } = result.error;
      throw Object.assign(new Error(message), {
        code,
        details: {
          ...details,
          containerPlacementId: process.env.CLOUDFLARE_PLACEMENT_ID ?? null
        }
      });
    }
    throwIfError(result);
    return {
      success: true,
      id: options.id,
      message: `Session ${options.id} created`,
      timestamp: new Date().toISOString(),
      containerPlacementId: process.env.CLOUDFLARE_PLACEMENT_ID ?? null
    };
  }

  async deleteSession(sessionId: string) {
    const result = await this.#mgr.deleteSession(sessionId);
    throwIfError(result);
    return { success: true, sessionId, timestamp: new Date().toISOString() };
  }

  async listSessions() {
    const result = await this.#mgr.listSessions();
    const sessions = extractData<string[]>(result);
    return { sessions };
  }
}

// ===========================================================================
// Backup
// ===========================================================================

class BackupRPCAPI extends RpcTarget {
  #svc: BackupService;
  constructor(svc: BackupService) {
    super();
    this.#svc = svc;
  }

  async createArchive(
    dir: string,
    archivePath: string,
    options?: BackupCreateArchiveOptions
  ) {
    const result = await this.#svc.createArchive(
      dir,
      archivePath,
      options?.sessionId,
      options?.gitignore ?? false,
      options?.excludes ?? [],
      options?.compression
    );
    const data = extractData<{ sizeBytes: number; archivePath: string }>(
      result
    );
    return {
      success: true,
      sizeBytes: data.sizeBytes,
      archivePath: data.archivePath
    };
  }

  async restoreArchive(
    dir: string,
    archivePath: string,
    options?: BackupRestoreArchiveOptions
  ) {
    const result = await this.#svc.restoreArchive(
      dir,
      archivePath,
      options?.sessionId
    );
    throwIfError(result);
    return { success: true, dir };
  }

  async uploadParts(request: {
    archivePath: string;
    parts: Array<{
      partNumber: number;
      url: string;
      offset: number;
      size: number;
    }>;
    sessionId?: string;
  }) {
    const result = await this.#svc.uploadParts(
      request.archivePath,
      request.parts,
      request.sessionId ?? 'default'
    );
    const data = extractData<{
      parts: Array<{ partNumber: number; etag: string }>;
    }>(result);
    return { success: true, parts: data.parts };
  }
}

// ===========================================================================
// Watch
// ===========================================================================

class WatchRPCAPI extends RpcTarget {
  #svc: WatchService;
  constructor(svc: WatchService) {
    super();
    this.#svc = svc;
  }

  async watch(request: WatchRequest): Promise<ReadableStream<Uint8Array>> {
    const result = await this.#svc.watchDirectory(request.path, {
      path: request.path,
      sessionId: request.sessionId ?? 'default',
      recursive: request.recursive,
      include: request.include,
      exclude: request.exclude
    });
    return extractData<ReadableStream<Uint8Array>>(result);
  }

  async checkChanges(
    request: CheckChangesRequest
  ): Promise<CheckChangesResult> {
    const result = await this.#svc.checkChanges(request.path, {
      path: request.path,
      sessionId: request.sessionId ?? 'default',
      recursive: request.recursive,
      include: request.include,
      exclude: request.exclude,
      since: request.since
    });
    return extractData<CheckChangesResult>(result);
  }
}

// ===========================================================================
// Tunnels (cloudflared-based preview alternative)
// ===========================================================================

class TunnelsRPCAPI extends RpcTarget {
  #svc: TunnelService;
  constructor(svc: TunnelService) {
    super();
    this.#svc = svc;
  }

  async ensureTunnelRun(
    request: EnsureTunnelRunRequest
  ): Promise<EnsureTunnelRunResult> {
    const result = await this.#svc.ensureTunnelRun(request);
    return extractData<EnsureTunnelRunResult>(result);
  }

  async stopTunnelRun(
    request: StopTunnelRunRequest
  ): Promise<StopTunnelRunResult> {
    const result = await this.#svc.stopTunnelRun(request);
    return extractData<StopTunnelRunResult>(result);
  }
}

// ===========================================================================
// Extensions (dynamic sidecar bridge)
// ===========================================================================

/**
 * Capnweb surface for sidecar extensions.
 *
 * `connect` provisions an extension package on first use (keyed by tarball
 * content hash) and returns the sidecar's capnweb remote main as a stub.
 * Calls on the stub are proxied through the container's capnweb session into
 * the sidecar's separate capnweb session — callback parameters (including
 * streaming handlers) round-trip across both hops via capnweb's cross-session
 * stub forwarding.
 *
 * Identity lives inside the tarball's `package.json`; the host derives `id`,
 * `version`, `bin`, and readiness timeout from there. The wire payload is
 * the tarball bytes on first connect per hash; subsequent connects send the
 * hash alone.
 */
class ExtensionsRPCAPI extends RpcTarget {
  #host: ExtensionHost;
  constructor(host: ExtensionHost) {
    super();
    this.#host = host;
  }

  async connect(req: ExtensionConnectRequest): Promise<unknown> {
    return this.#host.connect(req);
  }

  async health(packageHash: string): Promise<ExtensionHealth> {
    return this.#host.health(packageHash);
  }

  async stop(packageHash: string): Promise<void> {
    await this.#host.stop(packageHash);
  }
}
