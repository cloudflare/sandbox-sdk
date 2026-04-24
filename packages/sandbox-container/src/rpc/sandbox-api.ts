import type {
  CheckChangesRequest,
  CheckChangesResult,
  DesktopCursorPosition,
  DesktopMouseButton,
  DesktopMouseClickRequest,
  DesktopMouseDownRequest,
  DesktopMouseDragRequest,
  DesktopMouseScrollRequest,
  DesktopMouseUpRequest,
  DesktopScreenSize,
  DesktopScreenshotRegionRequest,
  DesktopScreenshotRequest,
  DesktopScreenshotResult,
  DesktopScrollDirection,
  DesktopStartRequest,
  DesktopStartResult,
  DesktopStatusResult,
  DesktopStopResult,
  ExecutionError,
  FileInfo,
  ListFilesOptions,
  Logger,
  OutputMessage,
  Result,
  SandboxAPI as SandboxAPIInterface,
  WatchRequest
} from '@repo/shared';
import { RpcTarget } from 'capnweb';
import type {
  CommandResult,
  ProcessRecord,
  ServiceError,
  ServiceResult
} from '../core/types';
import type { BackupService } from '../services/backup-service';
import type { DesktopService } from '../services/desktop-service';
import type { FileService } from '../services/file-service';
import type { GitService } from '../services/git-service';
import type {
  Context,
  ExecutionEvent,
  InterpreterService
} from '../services/interpreter-service';
import type { PortService } from '../services/port-service';
import type { ProcessService } from '../services/process-service';
import type { SessionManager } from '../services/session-manager';
import type { WatchService } from '../services/watch-service';

export interface SandboxAPIDeps {
  processService: ProcessService;
  fileService: FileService;
  portService: PortService;
  gitService: GitService;
  interpreterService: InterpreterService;
  backupService: BackupService;
  desktopService: DesktopService;
  watchService: WatchService;
  sessionManager: SessionManager;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// RPC error wrapper
// ---------------------------------------------------------------------------

class RPCError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any ServiceResult variant
function throwIfError(result: ServiceResult<any, any>): void {
  if (!result.success) {
    const err = result.error;
    throw new RPCError(`[${err.code}] ${err.message}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any ServiceResult variant
function extractData<T>(result: ServiceResult<any, any>): T {
  throwIfError(result);
  return (result as { data: T }).data;
}

/**
 * Native RPC API exposed to capnweb clients.
 *
 * Each domain is exposed as a nested RpcTarget so the client can access
 * them directly as `rpc.commands`, `rpc.files`, etc. Top-level methods
 * handle utility and session management.
 */
export class SandboxAPI extends RpcTarget implements SandboxAPIInterface {
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
  get interpreter() {
    return new InterpreterRPCAPI(this.#deps.interpreterService);
  }
  get utils() {
    return new UtilsRPCAPI(this.#deps.sessionManager);
  }
  get backup() {
    return new BackupRPCAPI(this.#deps.backupService);
  }
  get desktop() {
    return new DesktopRPCAPI(this.#deps.desktopService);
  }
  get watch() {
    return new WatchRPCAPI(this.#deps.watchService);
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
  }> {
    const result = await this.#svc.executeCommand(command, {
      sessionId,
      timeoutMs: options?.timeoutMs,
      env: options?.env,
      cwd: options?.cwd
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

  async executeStream(
    command: string,
    sessionId: string,
    options?: {
      timeoutMs?: number;
      env?: Record<string, string | undefined>;
      cwd?: string;
    }
  ): Promise<ReadableStream<Uint8Array>> {
    const encoder = new TextEncoder();
    const result = await this.#svc.startProcess(command, {
      sessionId,
      timeoutMs: options?.timeoutMs,
      env: options?.env,
      cwd: options?.cwd
    });

    if (!result.success) {
      return new ReadableStream({
        start(controller) {
          const event = {
            type: 'error',
            error: result.error.message,
            timestamp: new Date().toISOString()
          };
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify(event)}\n\n`)
          );
          controller.close();
        }
      });
    }

    const proc: ProcessRecord = result.data;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: start\ndata: ${JSON.stringify({ type: 'start', command, sessionId, pid: proc.pid, timestamp: new Date().toISOString() })}\n\n`
          )
        );
        if (proc.stdout) {
          controller.enqueue(
            encoder.encode(
              `event: stdout\ndata: ${JSON.stringify({ type: 'stdout', data: proc.stdout, timestamp: new Date().toISOString() })}\n\n`
            )
          );
        }
        if (proc.stderr) {
          controller.enqueue(
            encoder.encode(
              `event: stderr\ndata: ${JSON.stringify({ type: 'stderr', data: proc.stderr, timestamp: new Date().toISOString() })}\n\n`
            )
          );
        }

        const outputListener = (stream: 'stdout' | 'stderr', data: string) => {
          try {
            controller.enqueue(
              encoder.encode(
                `event: ${stream}\ndata: ${JSON.stringify({ type: stream, data, timestamp: new Date().toISOString() })}\n\n`
              )
            );
          } catch {
            /* Stream closed */
          }
        };

        const statusListener = (status: string) => {
          if (['completed', 'failed', 'killed', 'error'].includes(status)) {
            try {
              controller.enqueue(
                encoder.encode(
                  `event: complete\ndata: ${JSON.stringify({ type: 'complete', exitCode: proc.exitCode, timestamp: new Date().toISOString() })}\n\n`
                )
              );
              controller.close();
            } catch {
              /* Stream closed */
            }
            proc.outputListeners.delete(outputListener);
            proc.statusListeners.delete(statusListener);
          }
        };

        proc.outputListeners.add(outputListener);
        proc.statusListeners.add(statusListener);
        if (['completed', 'failed', 'killed', 'error'].includes(proc.status)) {
          statusListener(proc.status);
        }
      }
    });
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
    sessionId: string,
    options?: { encoding?: string }
  ) {
    const result = await this.#svc.readFile(path, options, sessionId);
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
      encoding: (metadata?.encoding ?? (options?.encoding || 'utf-8')) as
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
    sessionId: string
  ): Promise<ReadableStream<Uint8Array>> {
    return this.#svc.readFileStreamOperation(path, sessionId);
  }

  async writeFile(
    path: string,
    content: string,
    sessionId: string,
    options?: { encoding?: string; permissions?: string }
  ) {
    const result = await this.#svc.writeFile(path, content, options, sessionId);
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
    sessionId: string
  ) {
    const result = await this.#svc.writeFileStream(path, stream, sessionId);
    throwIfError(result);
    const data = (result as { data?: { bytesWritten: number } }).data;
    return {
      success: true,
      path,
      bytesWritten: data?.bytesWritten ?? 0,
      timestamp: new Date().toISOString()
    };
  }

  async deleteFile(path: string, sessionId: string) {
    const result = await this.#svc.deleteFile(path, sessionId);
    throwIfError(result);
    return { success: true, path, timestamp: new Date().toISOString() };
  }

  async renameFile(oldPath: string, newPath: string, sessionId: string) {
    const result = await this.#svc.renameFile(oldPath, newPath, sessionId);
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
    sessionId: string
  ) {
    const result = await this.#svc.moveFile(
      sourcePath,
      destinationPath,
      sessionId
    );
    throwIfError(result);
    return {
      success: true,
      path: sourcePath,
      newPath: destinationPath,
      timestamp: new Date().toISOString()
    };
  }

  async mkdir(
    path: string,
    sessionId: string,
    options?: { recursive?: boolean }
  ) {
    const result = await this.#svc.createDirectory(path, options, sessionId);
    throwIfError(result);
    return {
      success: true,
      path,
      recursive: options?.recursive ?? false,
      timestamp: new Date().toISOString()
    };
  }

  async listFiles(
    path: string,
    sessionId: string,
    options?: ListFilesOptions
  ): Promise<{
    success: boolean;
    files: FileInfo[];
    count: number;
    path: string;
    timestamp: string;
  }> {
    const result = await this.#svc.listFiles(path, options, sessionId);
    const files = extractData<FileInfo[]>(result);
    return {
      success: true,
      files,
      count: files.length,
      path,
      timestamp: new Date().toISOString()
    };
  }

  async exists(path: string, sessionId: string) {
    const result = await this.#svc.exists(path, sessionId);
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

  async startProcess(
    command: string,
    sessionId: string,
    options?: { processId?: string; timeoutMs?: number }
  ) {
    const result = await this.#svc.startProcess(command, {
      sessionId,
      ...options
    });
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

  async exposePort(port: number, _sessionId: string, name?: string) {
    const result = await this.#portSvc.exposePort(port, name);
    throwIfError(result);
    return {
      success: true,
      port,
      url: '',
      timestamp: new Date().toISOString()
    };
  }

  async getExposedPorts(_sessionId: string) {
    const result = await this.#portSvc.getExposedPorts();
    const ports = extractData<Array<{ port: number; name?: string }>>(result);
    return {
      success: true,
      ports: ports.map((p) => ({
        port: p.port,
        url: '',
        status: 'active' as const
      })),
      timestamp: new Date().toISOString()
    };
  }

  async unexposePort(port: number, _sessionId: string) {
    const result = await this.#portSvc.unexposePort(port);
    throwIfError(result);
    return { success: true, port, timestamp: new Date().toISOString() };
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

  async checkout(
    repoUrl: string,
    sessionId: string,
    options?: {
      branch?: string;
      targetDir?: string;
      depth?: number;
      timeoutMs?: number;
    }
  ) {
    const result = await this.#svc.cloneRepository(repoUrl, {
      branch: options?.branch,
      targetDir: options?.targetDir,
      depth: options?.depth,
      timeoutMs: options?.timeoutMs,
      sessionId
    });
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
// Code Interpreter
// ===========================================================================

class InterpreterRPCAPI extends RpcTarget {
  #svc: InterpreterService;
  constructor(svc: InterpreterService) {
    super();
    this.#svc = svc;
  }

  async createCodeContext(options?: {
    language?: string;
    cwd?: string;
  }): Promise<{
    id: string;
    language: string;
    cwd: string;
    createdAt: Date;
    lastUsed: Date;
  }> {
    const result = await this.#svc.createContext(options || {});
    const ctx = extractData<Context>(result);
    return {
      id: ctx.id,
      language: ctx.language,
      cwd: ctx.cwd,
      createdAt: new Date(ctx.createdAt),
      lastUsed: new Date(ctx.lastUsed)
    };
  }

  async streamCode(
    contextId: string,
    code: string,
    language?: string
  ): Promise<ReadableStream<Uint8Array>> {
    const result = await this.#svc.executeCodeEvents(contextId, code, language);
    const events = extractData<ExecutionEvent[]>(result);
    const encoder = new TextEncoder();

    return new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        }
        controller.close();
      }
    });
  }

  /**
   * Execute code and dispatch results via callbacks.
   *
   * capnweb stubs the callback functions so calls route back to the
   * caller transparently.
   */
  async runCodeStream(
    contextId: string | undefined,
    code: string,
    language: string | undefined,
    callbacks: {
      onStdout?: (output: OutputMessage) => void | Promise<void>;
      onStderr?: (output: OutputMessage) => void | Promise<void>;
      onResult?: (result: Result) => void | Promise<void>;
      onError?: (error: ExecutionError) => void | Promise<void>;
    },
    _timeoutMs?: number
  ): Promise<void> {
    const result = await this.#svc.executeCodeEvents(
      contextId ?? '',
      code,
      language
    );
    const events = extractData<ExecutionEvent[]>(result);

    for (const event of events) {
      await this.#dispatchEvent(event, callbacks);
    }
  }

  async #dispatchEvent(
    event: ExecutionEvent,
    cb: {
      onStdout?: (output: OutputMessage) => void | Promise<void>;
      onStderr?: (output: OutputMessage) => void | Promise<void>;
      onResult?: (result: Result) => void | Promise<void>;
      onError?: (error: ExecutionError) => void | Promise<void>;
    }
  ): Promise<void> {
    switch (event.type) {
      case 'stdout':
        await cb.onStdout?.({
          text: event.text,
          timestamp: Date.now()
        });
        break;
      case 'stderr':
        await cb.onStderr?.({
          text: event.text,
          timestamp: Date.now()
        });
        break;
      case 'result':
        // Send as a plain object — capnweb cannot serialize class instances.
        await cb.onResult?.({
          text: event.text as string | undefined,
          html: event.html as string | undefined,
          png: event.png as string | undefined,
          jpeg: event.jpeg as string | undefined,
          svg: event.svg as string | undefined,
          latex: event.latex as string | undefined,
          markdown: event.markdown as string | undefined,
          javascript: event.javascript as string | undefined,
          json: event.json as string | undefined,
          data: event.data as Record<string, unknown> | undefined
        } as Result);
        break;
      case 'error':
        await cb.onError?.({
          name: event.ename,
          message: event.evalue,
          traceback: event.traceback
        });
        break;
    }
  }

  async listCodeContexts(): Promise<
    Array<{
      id: string;
      language: string;
      cwd: string;
      createdAt: Date;
      lastUsed: Date;
    }>
  > {
    const result = await this.#svc.listContexts();
    const contexts = extractData<Context[]>(result);
    return contexts.map((c) => ({
      id: c.id,
      language: c.language,
      cwd: c.cwd,
      createdAt: new Date(c.createdAt),
      lastUsed: new Date(c.lastUsed)
    }));
  }

  async deleteCodeContext(contextId: string): Promise<void> {
    const result = await this.#svc.deleteContext(contextId);
    throwIfError(result);
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
    throwIfError(result);
    return {
      success: true,
      id: options.id,
      message: `Session ${options.id} created`,
      timestamp: new Date().toISOString()
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
    sessionId: string,
    options?: { excludes?: string[]; gitignore?: boolean }
  ) {
    const result = await this.#svc.createArchive(
      dir,
      archivePath,
      sessionId,
      options?.gitignore ?? false,
      options?.excludes ?? []
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

  async restoreArchive(dir: string, archivePath: string, sessionId: string) {
    const result = await this.#svc.restoreArchive(dir, archivePath, sessionId);
    throwIfError(result);
    return { success: true, dir };
  }
}

// ===========================================================================
// Desktop
// ===========================================================================

class DesktopRPCAPI extends RpcTarget {
  #svc: DesktopService;
  constructor(svc: DesktopService) {
    super();
    this.#svc = svc;
  }

  async start(options?: {
    resolution?: [number, number];
    dpi?: number;
  }): Promise<DesktopStartResult> {
    return extractData<DesktopStartResult>(
      await this.#svc.start(options as DesktopStartRequest)
    );
  }
  async stop(): Promise<DesktopStopResult> {
    return extractData<DesktopStopResult>(await this.#svc.stop());
  }
  async status(): Promise<DesktopStatusResult> {
    return extractData<DesktopStatusResult>(await this.#svc.status());
  }
  async screenshot(
    options?: DesktopScreenshotRequest
  ): Promise<DesktopScreenshotResult> {
    return extractData<DesktopScreenshotResult>(
      await this.#svc.screenshot(options)
    );
  }
  async screenshotRegion(
    request: DesktopScreenshotRegionRequest
  ): Promise<DesktopScreenshotResult> {
    return extractData<DesktopScreenshotResult>(
      await this.#svc.screenshotRegion(request)
    );
  }

  async click(
    x: number,
    y: number,
    options?: { button?: DesktopMouseButton; clickCount?: number }
  ): Promise<void> {
    throwIfError(
      await this.#svc.click({ x, y, ...options } as DesktopMouseClickRequest)
    );
  }
  async doubleClick(x: number, y: number): Promise<void> {
    await this.click(x, y, { clickCount: 2 });
  }
  async tripleClick(x: number, y: number): Promise<void> {
    await this.click(x, y, { clickCount: 3 });
  }
  async rightClick(x: number, y: number): Promise<void> {
    await this.click(x, y, { button: 'right' });
  }
  async middleClick(x: number, y: number): Promise<void> {
    await this.click(x, y, { button: 'middle' });
  }

  async mouseDown(
    x?: number,
    y?: number,
    options?: { button?: DesktopMouseButton }
  ): Promise<void> {
    throwIfError(
      await this.#svc.mouseDown({ x, y, ...options } as DesktopMouseDownRequest)
    );
  }
  async mouseUp(
    x?: number,
    y?: number,
    options?: { button?: DesktopMouseButton }
  ): Promise<void> {
    throwIfError(
      await this.#svc.mouseUp({ x, y, ...options } as DesktopMouseUpRequest)
    );
  }
  async moveMouse(x: number, y: number): Promise<void> {
    throwIfError(await this.#svc.moveMouse({ x, y }));
  }
  async drag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    options?: { button?: DesktopMouseButton }
  ): Promise<void> {
    throwIfError(
      await this.#svc.drag({
        startX,
        startY,
        endX,
        endY,
        ...options
      } as DesktopMouseDragRequest)
    );
  }
  async scroll(
    x: number,
    y: number,
    direction: DesktopScrollDirection,
    amount?: number
  ): Promise<void> {
    throwIfError(
      await this.#svc.scroll({
        x,
        y,
        direction,
        amount
      } as DesktopMouseScrollRequest)
    );
  }

  async getCursorPosition(): Promise<DesktopCursorPosition> {
    return extractData<DesktopCursorPosition>(
      await this.#svc.getCursorPosition()
    );
  }
  async type(text: string, options?: { delay?: number }): Promise<void> {
    throwIfError(await this.#svc.typeText({ text, ...options }));
  }
  async press(key: string): Promise<void> {
    throwIfError(await this.#svc.keyPress({ key }));
  }
  async keyDown(key: string): Promise<void> {
    throwIfError(await this.#svc.keyDown({ key }));
  }
  async keyUp(key: string): Promise<void> {
    throwIfError(await this.#svc.keyUp({ key }));
  }
  async getScreenSize(): Promise<DesktopScreenSize> {
    return extractData<DesktopScreenSize>(await this.#svc.getScreenSize());
  }
  async getProcessStatus(_name: string): Promise<DesktopStatusResult> {
    return this.status();
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
