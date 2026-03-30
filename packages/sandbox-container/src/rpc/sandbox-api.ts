import type {
  DesktopCursorPosition,
  DesktopKeyPressRequest,
  DesktopMouseClickRequest,
  DesktopMouseDownRequest,
  DesktopMouseDragRequest,
  DesktopMouseMoveRequest,
  DesktopMouseScrollRequest,
  DesktopMouseUpRequest,
  DesktopScreenSize,
  DesktopScreenshotRegionRequest,
  DesktopScreenshotRequest,
  DesktopScreenshotResult,
  DesktopStartRequest,
  DesktopStartResult,
  DesktopStatusResult,
  DesktopStopResult,
  DesktopTypeRequest,
  FileInfo,
  ListFilesOptions,
  Logger
} from '@repo/shared';
import { RpcTarget } from 'capnweb';
import type { CommandResult, ProcessRecord } from '../core/types';
import type { BackupService } from '../services/backup-service';
import type { DesktopService } from '../services/desktop-service';
import type { FileService } from '../services/file-service';
import type { GitService } from '../services/git-service';
import type {
  Context,
  InterpreterService
} from '../services/interpreter-service';
import type { PortService } from '../services/port-service';
import type { ProcessService } from '../services/process-service';
import type { SessionManager } from '../services/session-manager';
import type { WatchService } from '../services/watch-service';

export interface SandboxRPCAPIDeps {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ServiceResult has complex conditional types
function throwIfError(result: any): void {
  if (result && !result.success && result.error) {
    const err = new Error(result.error.message);
    (err as unknown as Record<string, unknown>).code = result.error.code;
    if (result.error.details) {
      (err as unknown as Record<string, unknown>).details =
        result.error.details;
    }
    throw err;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ServiceResult has complex conditional types
function extractData<T>(result: any): T {
  throwIfError(result);
  return result.data as T;
}

/**
 * Native RPC API exposed to capnweb clients.
 *
 * Each method calls the corresponding service directly, bypassing the
 * HTTP handler/router layer. ServiceResult errors are converted to
 * thrown exceptions which capnweb propagates back to the caller.
 */
export class SandboxRPCAPI extends RpcTarget {
  #deps: SandboxRPCAPIDeps;

  constructor(deps: SandboxRPCAPIDeps) {
    super();
    this.#deps = deps;
  }

  // =========================================================================
  // Utility
  // =========================================================================

  async ping(): Promise<{ status: string; timestamp: string }> {
    return { status: 'healthy', timestamp: new Date().toISOString() };
  }

  async getVersion(): Promise<{ version: string; timestamp: string }> {
    return {
      version: process.env.SANDBOX_VERSION || 'unknown',
      timestamp: new Date().toISOString()
    };
  }

  // =========================================================================
  // Sessions
  // =========================================================================

  async createSession(options: {
    id: string;
    env?: Record<string, string | undefined>;
    cwd?: string;
  }): Promise<{ sessionId: string }> {
    const result = await this.#deps.sessionManager.createSession(options);
    throwIfError(result);
    return { sessionId: options.id };
  }

  async deleteSession(
    sessionId: string
  ): Promise<{ success: boolean; sessionId: string }> {
    const result = await this.#deps.sessionManager.deleteSession(sessionId);
    throwIfError(result);
    return { success: true, sessionId };
  }

  async listSessions(): Promise<{ sessions: string[] }> {
    const result = await this.#deps.sessionManager.listSessions();
    const sessions = extractData<string[]>(result);
    return { sessions };
  }

  // =========================================================================
  // Commands
  // =========================================================================

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
    const result = await this.#deps.processService.executeCommand(command, {
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

    const result = await this.#deps.processService.startProcess(command, {
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
        // Send start event
        controller.enqueue(
          encoder.encode(
            `event: start\ndata: ${JSON.stringify({
              type: 'start',
              command,
              sessionId,
              pid: proc.pid,
              timestamp: new Date().toISOString()
            })}\n\n`
          )
        );

        // Send buffered output
        if (proc.stdout) {
          controller.enqueue(
            encoder.encode(
              `event: stdout\ndata: ${JSON.stringify({
                type: 'stdout',
                data: proc.stdout,
                timestamp: new Date().toISOString()
              })}\n\n`
            )
          );
        }
        if (proc.stderr) {
          controller.enqueue(
            encoder.encode(
              `event: stderr\ndata: ${JSON.stringify({
                type: 'stderr',
                data: proc.stderr,
                timestamp: new Date().toISOString()
              })}\n\n`
            )
          );
        }

        const outputListener = (stream: 'stdout' | 'stderr', data: string) => {
          try {
            controller.enqueue(
              encoder.encode(
                `event: ${stream}\ndata: ${JSON.stringify({
                  type: stream,
                  data,
                  timestamp: new Date().toISOString()
                })}\n\n`
              )
            );
          } catch {
            // Stream closed
          }
        };

        const statusListener = (status: string) => {
          if (['completed', 'failed', 'killed', 'error'].includes(status)) {
            try {
              controller.enqueue(
                encoder.encode(
                  `event: complete\ndata: ${JSON.stringify({
                    type: 'complete',
                    exitCode: proc.exitCode,
                    timestamp: new Date().toISOString()
                  })}\n\n`
                )
              );
              controller.close();
            } catch {
              // Stream closed
            }
            proc.outputListeners.delete(outputListener);
            proc.statusListeners.delete(statusListener);
          }
        };

        proc.outputListeners.add(outputListener);
        proc.statusListeners.add(statusListener);

        // If already completed
        if (['completed', 'failed', 'killed', 'error'].includes(proc.status)) {
          statusListener(proc.status);
        }
      }
    });
  }

  // =========================================================================
  // Files
  // =========================================================================

  async readFile(
    path: string,
    sessionId: string,
    options?: { encoding?: string }
  ): Promise<{
    content: string;
    path: string;
    encoding: string;
    size: number;
    mimeType: string;
    timestamp: string;
  }> {
    const result = await this.#deps.fileService.readFile(
      path,
      options,
      sessionId
    );
    const content = extractData<string>(result);
    return {
      content,
      path,
      encoding: options?.encoding || 'utf-8',
      size: content.length,
      mimeType: 'text/plain',
      timestamp: new Date().toISOString()
    };
  }

  async readFileStream(
    path: string,
    sessionId: string
  ): Promise<ReadableStream<Uint8Array>> {
    return this.#deps.fileService.readFileStreamOperation(path, sessionId);
  }

  async writeFile(
    path: string,
    content: string,
    sessionId: string,
    options?: { encoding?: string; permissions?: string }
  ): Promise<{
    success: boolean;
    path: string;
    bytesWritten: number;
    timestamp: string;
  }> {
    const result = await this.#deps.fileService.writeFile(
      path,
      content,
      options,
      sessionId
    );
    throwIfError(result);
    return {
      success: true,
      path,
      bytesWritten: content.length,
      timestamp: new Date().toISOString()
    };
  }

  async writeFileStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    sessionId: string
  ): Promise<{
    success: boolean;
    path: string;
    bytesWritten: number;
    timestamp: string;
  }> {
    const result = await this.#deps.fileService.writeFileStream(
      path,
      stream,
      sessionId
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

  async deleteFile(
    path: string,
    sessionId: string
  ): Promise<{ success: boolean; path: string; timestamp: string }> {
    const result = await this.#deps.fileService.deleteFile(path, sessionId);
    throwIfError(result);
    return { success: true, path, timestamp: new Date().toISOString() };
  }

  async renameFile(
    oldPath: string,
    newPath: string,
    sessionId: string
  ): Promise<{
    success: boolean;
    oldPath: string;
    newPath: string;
    timestamp: string;
  }> {
    const result = await this.#deps.fileService.renameFile(
      oldPath,
      newPath,
      sessionId
    );
    throwIfError(result);
    return {
      success: true,
      oldPath,
      newPath,
      timestamp: new Date().toISOString()
    };
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string,
    sessionId: string
  ): Promise<{
    success: boolean;
    sourcePath: string;
    destinationPath: string;
    timestamp: string;
  }> {
    const result = await this.#deps.fileService.moveFile(
      sourcePath,
      destinationPath,
      sessionId
    );
    throwIfError(result);
    return {
      success: true,
      sourcePath,
      destinationPath,
      timestamp: new Date().toISOString()
    };
  }

  async mkdir(
    path: string,
    sessionId: string,
    options?: { recursive?: boolean }
  ): Promise<{ success: boolean; path: string; timestamp: string }> {
    const result = await this.#deps.fileService.createDirectory(
      path,
      options,
      sessionId
    );
    throwIfError(result);
    return { success: true, path, timestamp: new Date().toISOString() };
  }

  async listFiles(
    path: string,
    sessionId: string,
    options?: ListFilesOptions
  ): Promise<{ files: FileInfo[]; path: string; timestamp: string }> {
    const result = await this.#deps.fileService.listFiles(
      path,
      options,
      sessionId
    );
    const files = extractData<FileInfo[]>(result);
    return { files, path, timestamp: new Date().toISOString() };
  }

  async exists(
    path: string,
    sessionId: string
  ): Promise<{ exists: boolean; path: string; timestamp: string }> {
    const result = await this.#deps.fileService.exists(path, sessionId);
    const exists = extractData<boolean>(result);
    return { exists, path, timestamp: new Date().toISOString() };
  }

  // =========================================================================
  // Processes
  // =========================================================================

  async startProcess(
    command: string,
    sessionId: string,
    options?: { processId?: string; timeoutMs?: number }
  ): Promise<{
    id: string;
    pid?: number;
    command: string;
    status: string;
    timestamp: string;
  }> {
    const result = await this.#deps.processService.startProcess(command, {
      sessionId,
      ...options
    });
    const proc = extractData<ProcessRecord>(result);
    return {
      id: proc.id,
      pid: proc.pid,
      command: proc.command,
      status: proc.status,
      timestamp: proc.startTime.toISOString()
    };
  }

  async listProcesses(): Promise<
    Array<{
      id: string;
      pid?: number;
      command: string;
      status: string;
      startTime: string;
      exitCode?: number;
    }>
  > {
    const result = await this.#deps.processService.listProcesses();
    const processes = extractData<ProcessRecord[]>(result);
    return processes.map((p) => ({
      id: p.id,
      pid: p.pid,
      command: p.command,
      status: p.status,
      startTime: p.startTime.toISOString(),
      exitCode: p.exitCode
    }));
  }

  async getProcess(id: string): Promise<{
    id: string;
    pid?: number;
    command: string;
    status: string;
    startTime: string;
    exitCode?: number;
    stdout: string;
    stderr: string;
  }> {
    const result = await this.#deps.processService.getProcess(id);
    const proc = extractData<ProcessRecord>(result);
    return {
      id: proc.id,
      pid: proc.pid,
      command: proc.command,
      status: proc.status,
      startTime: proc.startTime.toISOString(),
      exitCode: proc.exitCode,
      stdout: proc.stdout,
      stderr: proc.stderr
    };
  }

  async killProcess(id: string): Promise<void> {
    const result = await this.#deps.processService.killProcess(id);
    throwIfError(result);
  }

  async killAllProcesses(): Promise<number> {
    const result = await this.#deps.processService.killAllProcesses();
    return extractData<number>(result);
  }

  async getProcessLogs(
    id: string
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await this.#deps.processService.getProcess(id);
    const proc = extractData<ProcessRecord>(result);
    return { stdout: proc.stdout, stderr: proc.stderr };
  }

  async streamProcessLogs(id: string): Promise<ReadableStream<Uint8Array>> {
    const encoder = new TextEncoder();
    const result = await this.#deps.processService.getProcess(id);
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
            // Stream closed
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
              // Stream closed
            }
            proc.outputListeners.delete(listener);
            proc.statusListeners.delete(statusListener);
          }
        };
        proc.statusListeners.add(statusListener);
      }
    });
  }

  // =========================================================================
  // Ports
  // =========================================================================

  async exposePort(
    port: number,
    _sessionId: string,
    name?: string
  ): Promise<{ port: number; name?: string; timestamp: string }> {
    const result = await this.#deps.portService.exposePort(port, name);
    throwIfError(result);
    return { port, name, timestamp: new Date().toISOString() };
  }

  async listExposedPorts(): Promise<{
    ports: Array<{ port: number; name?: string }>;
  }> {
    const result = await this.#deps.portService.getExposedPorts();
    const ports = extractData<Array<{ port: number; name?: string }>>(result);
    return {
      ports: ports.map((p) => ({ port: p.port, name: p.name }))
    };
  }

  async unexposePort(port: number): Promise<void> {
    const result = await this.#deps.portService.unexposePort(port);
    throwIfError(result);
  }

  async watchPorts(request: {
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
    const portService = this.#deps.portService;
    const processService = this.#deps.processService;
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
              const processResult = await processService.getProcess(processId);
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

            const result = await portService.checkPortReady({
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

  // =========================================================================
  // Git
  // =========================================================================

  async gitCheckout(
    repoUrl: string,
    sessionId: string,
    options?: {
      branch?: string;
      targetDir?: string;
      depth?: number;
    }
  ): Promise<{
    success: boolean;
    repoUrl: string;
    branch?: string;
    targetDir: string;
    timestamp: string;
  }> {
    const result = await this.#deps.gitService.cloneRepository(repoUrl, {
      branch: options?.branch,
      targetDir: options?.targetDir,
      depth: options?.depth,
      sessionId
    });
    const data = extractData<{ path: string; branch: string }>(result);
    return {
      success: true,
      repoUrl,
      branch: data.branch,
      targetDir: data.path,
      timestamp: new Date().toISOString()
    };
  }

  // =========================================================================
  // Code Interpreter
  // =========================================================================

  async createCodeContext(options?: {
    language?: string;
    cwd?: string;
  }): Promise<{ contextId: string; language: string }> {
    const result = await this.#deps.interpreterService.createContext(
      options || {}
    );
    const ctx = extractData<Context>(result);
    return { contextId: ctx.id, language: ctx.language };
  }

  async executeCode(
    contextId: string,
    code: string,
    language?: string
  ): Promise<Response> {
    return this.#deps.interpreterService.executeCode(contextId, code, language);
  }

  async listCodeContexts(): Promise<Array<{ id: string; language: string }>> {
    const result = await this.#deps.interpreterService.listContexts();
    const contexts = extractData<Context[]>(result);
    return contexts.map((c) => ({ id: c.id, language: c.language }));
  }

  async deleteCodeContext(contextId: string): Promise<void> {
    const result = await this.#deps.interpreterService.deleteContext(contextId);
    throwIfError(result);
  }

  // =========================================================================
  // Backup
  // =========================================================================

  async createBackup(
    dir: string,
    archivePath: string,
    sessionId: string
  ): Promise<unknown> {
    const result = await this.#deps.backupService.createArchive(
      dir,
      archivePath,
      sessionId
    );
    return extractData<number>(result);
  }

  async restoreBackup(
    dir: string,
    archivePath: string,
    sessionId: string
  ): Promise<unknown> {
    const result = await this.#deps.backupService.restoreArchive(
      dir,
      archivePath,
      sessionId
    );
    return extractData<number>(result);
  }

  // =========================================================================
  // Desktop
  // =========================================================================

  async desktopStart(
    request?: DesktopStartRequest
  ): Promise<DesktopStartResult> {
    const result = await this.#deps.desktopService.start(request);
    return extractData<DesktopStartResult>(result);
  }

  async desktopStop(): Promise<DesktopStopResult> {
    const result = await this.#deps.desktopService.stop();
    return extractData<DesktopStopResult>(result);
  }

  async desktopStatus(): Promise<DesktopStatusResult> {
    const result = await this.#deps.desktopService.status();
    return extractData<DesktopStatusResult>(result);
  }

  async desktopScreenshot(
    request?: DesktopScreenshotRequest
  ): Promise<DesktopScreenshotResult> {
    const result = await this.#deps.desktopService.screenshot(request);
    return extractData<DesktopScreenshotResult>(result);
  }

  async desktopScreenshotRegion(
    request: DesktopScreenshotRegionRequest
  ): Promise<DesktopScreenshotResult> {
    const result = await this.#deps.desktopService.screenshotRegion(request);
    return extractData<DesktopScreenshotResult>(result);
  }

  async desktopClick(request: DesktopMouseClickRequest): Promise<void> {
    const result = await this.#deps.desktopService.click(request);
    throwIfError(result);
  }

  async desktopMoveMouse(request: DesktopMouseMoveRequest): Promise<void> {
    const result = await this.#deps.desktopService.moveMouse(request);
    throwIfError(result);
  }

  async desktopMouseDown(request: DesktopMouseDownRequest): Promise<void> {
    const result = await this.#deps.desktopService.mouseDown(request);
    throwIfError(result);
  }

  async desktopMouseUp(request: DesktopMouseUpRequest): Promise<void> {
    const result = await this.#deps.desktopService.mouseUp(request);
    throwIfError(result);
  }

  async desktopDrag(request: DesktopMouseDragRequest): Promise<void> {
    const result = await this.#deps.desktopService.drag(request);
    throwIfError(result);
  }

  async desktopScroll(request: DesktopMouseScrollRequest): Promise<void> {
    const result = await this.#deps.desktopService.scroll(request);
    throwIfError(result);
  }

  async desktopGetCursorPosition(): Promise<DesktopCursorPosition> {
    const result = await this.#deps.desktopService.getCursorPosition();
    return extractData<DesktopCursorPosition>(result);
  }

  async desktopType(request: DesktopTypeRequest): Promise<void> {
    const result = await this.#deps.desktopService.typeText(request);
    throwIfError(result);
  }

  async desktopKeyPress(request: DesktopKeyPressRequest): Promise<void> {
    const result = await this.#deps.desktopService.keyPress(request);
    throwIfError(result);
  }

  async desktopKeyDown(request: DesktopKeyPressRequest): Promise<void> {
    const result = await this.#deps.desktopService.keyDown(request);
    throwIfError(result);
  }

  async desktopKeyUp(request: DesktopKeyPressRequest): Promise<void> {
    const result = await this.#deps.desktopService.keyUp(request);
    throwIfError(result);
  }

  async desktopGetScreenSize(): Promise<DesktopScreenSize> {
    const result = await this.#deps.desktopService.getScreenSize();
    return extractData<DesktopScreenSize>(result);
  }

  // =========================================================================
  // Watch
  // =========================================================================

  async watch(
    path: string,
    sessionId: string,
    options?: {
      recursive?: boolean;
      include?: string[];
      exclude?: string[];
    }
  ): Promise<ReadableStream<Uint8Array>> {
    const result = await this.#deps.watchService.watchDirectory(path, {
      path,
      sessionId,
      ...options
    });
    return extractData<ReadableStream<Uint8Array>>(result);
  }
}
