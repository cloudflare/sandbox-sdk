/**
 * SandboxClient implementation backed by direct capnweb RPC calls.
 *
 * Exposes the same field-level interface as SandboxClient (commands, files,
 * processes, etc.) so sandbox.ts can use either client without changes.
 * Each sub-object delegates to ContainerConnection.rpc() and maps the
 * RPC response to the return type the caller expects.
 */

import type {
  CodeContext,
  CreateBackupResponse,
  CreateContextOptions,
  DeleteFileResult,
  DesktopMouseButton,
  DesktopMouseClickRequest,
  DesktopMouseDownRequest,
  DesktopMouseDragRequest,
  DesktopMouseScrollRequest,
  DesktopMouseUpRequest,
  DesktopScreenshotRegionRequest,
  DesktopScreenshotRequest,
  DesktopScrollDirection,
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
  RestoreBackupResponse,
  WatchRequest,
  WriteFileResult
} from '@repo/shared';
import type { ContainerConnection } from '../container-connection';
import type { ExecuteResponse } from './index';

// Inline the types that were previously imported from deleted files
type TransportMode = 'capnweb';

interface ExecutionCallbacks {
  onStdout?: (output: { text: string; timestamp: number }) => void;
  onStderr?: (output: { text: string; timestamp: number }) => void;
  onResult?: (result: Record<string, unknown>) => void | Promise<void>;
  onError?: (error: {
    name: string;
    message: string;
    traceback?: string[];
  }) => void;
}

interface CreateSessionResponse {
  success: boolean;
  id: string;
  message?: string;
  timestamp: string;
}

interface DeleteSessionResponse {
  success: boolean;
  sessionId: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Sub-client implementations
// ---------------------------------------------------------------------------

class RPCCommandClient {
  constructor(private conn: ContainerConnection) {}

  async execute(
    command: string,
    sessionId: string,
    options?: {
      timeoutMs?: number;
      env?: Record<string, string | undefined>;
      cwd?: string;
      origin?: string;
    }
  ): Promise<ExecuteResponse> {
    const rpc = await this.conn.rpc();
    const r = await rpc.execute(command, sessionId, options);
    return {
      success: r.success,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      command: r.command,
      timestamp: r.timestamp
    };
  }

  async executeStream(
    command: string,
    sessionId: string,
    options?: {
      timeoutMs?: number;
      env?: Record<string, string | undefined>;
      cwd?: string;
      origin?: string;
    }
  ): Promise<ReadableStream<Uint8Array>> {
    const rpc = await this.conn.rpc();
    return rpc.executeStream(command, sessionId, options);
  }
}

class RPCFileClient {
  constructor(private conn: ContainerConnection) {}

  async mkdir(
    path: string,
    sessionId: string,
    options?: { recursive?: boolean }
  ): Promise<MkdirResult> {
    const rpc = await this.conn.rpc();
    const r = await rpc.mkdir(path, sessionId, options);
    return {
      success: r.success,
      path: r.path,
      recursive: options?.recursive ?? false,
      timestamp: r.timestamp
    };
  }

  async writeFile(
    path: string,
    content: string,
    sessionId: string,
    options?: { encoding?: string }
  ): Promise<WriteFileResult> {
    const rpc = await this.conn.rpc();
    const r = await rpc.writeFile(path, content, sessionId, options);
    return { success: r.success, path: r.path, timestamp: r.timestamp };
  }

  async readFile(
    path: string,
    sessionId: string,
    options?: { encoding?: string }
  ): Promise<ReadFileResult> {
    const rpc = await this.conn.rpc();
    const r = await rpc.readFile(path, sessionId, options);
    return {
      success: true,
      path: r.path,
      content: r.content,
      encoding: r.encoding as 'utf-8' | 'base64',
      size: r.size,
      mimeType: r.mimeType,
      timestamp: r.timestamp
    };
  }

  async readFileStream(
    path: string,
    sessionId: string
  ): Promise<ReadableStream<Uint8Array>> {
    const rpc = await this.conn.rpc();
    return rpc.readFileStream(path, sessionId);
  }

  async deleteFile(path: string, sessionId: string): Promise<DeleteFileResult> {
    const rpc = await this.conn.rpc();
    const r = await rpc.deleteFile(path, sessionId);
    return { success: r.success, path: r.path, timestamp: r.timestamp };
  }

  async renameFile(
    oldPath: string,
    newPath: string,
    sessionId: string
  ): Promise<RenameFileResult> {
    const rpc = await this.conn.rpc();
    const r = await rpc.renameFile(oldPath, newPath, sessionId);
    return {
      success: r.success,
      path: oldPath,
      newPath,
      timestamp: r.timestamp
    };
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string,
    sessionId: string
  ): Promise<MoveFileResult> {
    const rpc = await this.conn.rpc();
    const r = await rpc.moveFile(sourcePath, destinationPath, sessionId);
    return {
      success: r.success,
      path: sourcePath,
      newPath: destinationPath,
      timestamp: r.timestamp
    };
  }

  async listFiles(
    path: string,
    sessionId: string,
    options?: ListFilesOptions
  ): Promise<ListFilesResult> {
    const rpc = await this.conn.rpc();
    const r = await rpc.listFiles(path, sessionId, options);
    return {
      success: true,
      files: r.files,
      count: r.files.length,
      path: r.path,
      timestamp: r.timestamp
    };
  }

  async exists(path: string, sessionId: string): Promise<FileExistsResult> {
    const rpc = await this.conn.rpc();
    const r = await rpc.exists(path, sessionId);
    return {
      success: true,
      exists: r.exists,
      path: r.path,
      timestamp: r.timestamp
    };
  }
}

class RPCProcessClient {
  constructor(private conn: ContainerConnection) {}

  async startProcess(
    command: string,
    sessionId: string,
    options?: { processId?: string; timeoutMs?: number }
  ): Promise<ProcessStartResult> {
    const rpc = await this.conn.rpc();
    const r = await rpc.startProcess(command, sessionId, options);
    return {
      success: true,
      processId: r.id,
      pid: r.pid,
      command: r.command,
      timestamp: r.timestamp
    };
  }

  async listProcesses(): Promise<ProcessListResult> {
    const rpc = await this.conn.rpc();
    const r = await rpc.listProcesses();
    return {
      success: true,
      processes: r.map((p) => ({
        id: p.id,
        pid: p.pid,
        command: p.command,
        status: p.status as ProcessListResult['processes'][0]['status'],
        startTime: p.startTime,
        exitCode: p.exitCode
      })),
      timestamp: new Date().toISOString()
    };
  }

  async getProcess(processId: string): Promise<ProcessInfoResult> {
    const rpc = await this.conn.rpc();
    const r = await rpc.getProcess(processId);
    return {
      success: true,
      process: {
        id: r.id,
        pid: r.pid,
        command: r.command,
        status: r.status as ProcessInfoResult['process']['status'],
        startTime: r.startTime,
        exitCode: r.exitCode
      },
      timestamp: new Date().toISOString()
    };
  }

  async killProcess(processId: string): Promise<ProcessKillResult> {
    const rpc = await this.conn.rpc();
    await rpc.killProcess(processId);
    return {
      success: true,
      processId,
      timestamp: new Date().toISOString()
    };
  }

  async killAllProcesses(): Promise<ProcessCleanupResult> {
    const rpc = await this.conn.rpc();
    const count = await rpc.killAllProcesses();
    return {
      success: true,
      cleanedCount: count,
      timestamp: new Date().toISOString()
    };
  }

  async getProcessLogs(processId: string): Promise<ProcessLogsResult> {
    const rpc = await this.conn.rpc();
    const r = await rpc.getProcessLogs(processId);
    return {
      success: true,
      processId,
      stdout: r.stdout,
      stderr: r.stderr,
      timestamp: new Date().toISOString()
    };
  }

  async streamProcessLogs(
    processId: string
  ): Promise<ReadableStream<Uint8Array>> {
    const rpc = await this.conn.rpc();
    return rpc.streamProcessLogs(processId);
  }
}

class RPCPortClient {
  constructor(private conn: ContainerConnection) {}

  async exposePort(
    port: number,
    sessionId: string,
    name?: string
  ): Promise<PortExposeResult> {
    const rpc = await this.conn.rpc();
    await rpc.exposePort(port, sessionId, name);
    return {
      success: true,
      port,
      url: '',
      timestamp: new Date().toISOString()
    };
  }

  async unexposePort(
    port: number,
    _sessionId: string
  ): Promise<PortCloseResult> {
    const rpc = await this.conn.rpc();
    await rpc.unexposePort(port);
    return {
      success: true,
      port,
      timestamp: new Date().toISOString()
    };
  }

  async getExposedPorts(_sessionId: string): Promise<PortListResult> {
    const rpc = await this.conn.rpc();
    const r = await rpc.listExposedPorts();
    return {
      success: true,
      ports: r.ports.map((p) => ({
        port: p.port,
        url: '',
        status: 'active' as const
      })),
      timestamp: new Date().toISOString()
    };
  }

  async watchPort(
    request: PortWatchRequest
  ): Promise<ReadableStream<Uint8Array>> {
    const rpc = await this.conn.rpc();
    return rpc.watchPorts(request);
  }
}

class RPCGitClient {
  constructor(private conn: ContainerConnection) {}

  async checkout(
    repoUrl: string,
    sessionId: string,
    options?: { branch?: string; targetDir?: string; depth?: number }
  ): Promise<GitCheckoutResult> {
    const rpc = await this.conn.rpc();
    const r = await rpc.gitCheckout(repoUrl, sessionId, options);
    return {
      success: r.success,
      repoUrl: r.repoUrl,
      branch: r.branch ?? '',
      targetDir: r.targetDir,
      timestamp: r.timestamp
    };
  }
}

class RPCUtilityClient {
  constructor(private conn: ContainerConnection) {}

  async ping(): Promise<string> {
    const rpc = await this.conn.rpc();
    const r = await rpc.ping();
    return r.status;
  }

  async getCommands(): Promise<string[]> {
    // Not exposed via RPC — return empty for now
    return [];
  }

  async createSession(options: {
    id: string;
    env?: Record<string, string | undefined>;
    cwd?: string;
  }): Promise<CreateSessionResponse> {
    const rpc = await this.conn.rpc();
    const r = await rpc.createSession(options);
    return {
      success: true,
      id: r.sessionId,
      message: `Session ${r.sessionId} created`,
      timestamp: new Date().toISOString()
    };
  }

  async deleteSession(sessionId: string): Promise<DeleteSessionResponse> {
    const rpc = await this.conn.rpc();
    await rpc.deleteSession(sessionId);
    return {
      success: true,
      sessionId,
      timestamp: new Date().toISOString()
    };
  }

  async getVersion(): Promise<string> {
    try {
      const rpc = await this.conn.rpc();
      const r = await rpc.getVersion();
      return r.version;
    } catch {
      return 'unknown';
    }
  }
}

class RPCInterpreterClient {
  constructor(private conn: ContainerConnection) {}

  async createCodeContext(
    options: CreateContextOptions = {}
  ): Promise<CodeContext> {
    const rpc = await this.conn.rpc();
    const r = await rpc.createCodeContext({
      language: options.language || 'python',
      cwd: options.cwd || '/workspace'
    });
    return {
      id: r.contextId,
      language: r.language,
      cwd: options.cwd || '/workspace',
      createdAt: new Date(),
      lastUsed: new Date()
    };
  }

  async runCodeStream(
    contextId: string | undefined,
    code: string,
    language: string | undefined,
    callbacks: ExecutionCallbacks,
    _timeoutMs?: number
  ): Promise<void> {
    const rpc = await this.conn.rpc();
    const response = await rpc.executeCode(contextId ?? '', code, language);

    if (!response.body) return;

    // Parse SSE stream — same format as the HTTP path
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        if (done) break;

        let idx = buffer.indexOf('\n');
        while (idx !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.startsWith('data: ')) {
            await this.dispatch(line.substring(6), callbacks);
          }
          idx = buffer.indexOf('\n');
        }
      }
      if (buffer.startsWith('data: ')) {
        await this.dispatch(buffer.substring(6), callbacks);
      }
    } finally {
      reader.releaseLock();
    }
  }

  async listCodeContexts(): Promise<CodeContext[]> {
    const rpc = await this.conn.rpc();
    const r = await rpc.listCodeContexts();
    return r.map((c) => ({
      id: c.id,
      language: c.language,
      cwd: '/workspace',
      createdAt: new Date(),
      lastUsed: new Date()
    }));
  }

  async deleteCodeContext(contextId: string): Promise<void> {
    const rpc = await this.conn.rpc();
    await rpc.deleteCodeContext(contextId);
  }

  async streamCode(
    contextId: string,
    code: string,
    language?: string
  ): Promise<ReadableStream<Uint8Array>> {
    const rpc = await this.conn.rpc();
    const response = await rpc.executeCode(contextId, code, language);
    if (!response.body) {
      throw new Error('No response body from code execution');
    }
    return response.body;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SSE data has dynamic shape
  private async dispatch(json: string, cb: ExecutionCallbacks): Promise<void> {
    try {
      const data = JSON.parse(json);
      switch (data.type) {
        case 'stdout':
          await cb.onStdout?.({
            text: data.text,
            timestamp: data.timestamp ?? Date.now()
          });
          break;
        case 'stderr':
          await cb.onStderr?.({
            text: data.text,
            timestamp: data.timestamp ?? Date.now()
          });
          break;
        case 'result':
          // Import ResultImpl lazily to avoid circular deps
          if (cb.onResult) {
            const { ResultImpl } = await import('@repo/shared');
            await cb.onResult(
              new ResultImpl(data) as unknown as Record<string, unknown>
            );
          }
          break;
        case 'error':
          await cb.onError?.({
            name: data.ename ?? 'Error',
            message: data.evalue ?? 'Unknown error',
            traceback: data.traceback ?? []
          });
          break;
      }
    } catch {
      // Ignore malformed lines
    }
  }
}

class RPCBackupClient {
  constructor(private conn: ContainerConnection) {}

  async createArchive(
    dir: string,
    archivePath: string,
    sessionId: string,
    _options?: { excludes?: string[]; gitignore?: boolean }
  ): Promise<CreateBackupResponse> {
    const rpc = await this.conn.rpc();
    const sizeBytes = (await rpc.createBackup(
      dir,
      archivePath,
      sessionId
    )) as number;
    return { success: true, sizeBytes, archivePath };
  }

  async restoreArchive(
    dir: string,
    archivePath: string,
    sessionId: string
  ): Promise<RestoreBackupResponse> {
    const rpc = await this.conn.rpc();
    await rpc.restoreBackup(dir, archivePath, sessionId);
    return { success: true, dir };
  }
}

class RPCDesktopClient {
  constructor(private conn: ContainerConnection) {}

  async start(options?: { resolution?: [number, number]; dpi?: number }) {
    const rpc = await this.conn.rpc();
    return rpc.desktopStart(options);
  }
  async stop() {
    const rpc = await this.conn.rpc();
    return rpc.desktopStop();
  }
  async status() {
    const rpc = await this.conn.rpc();
    return rpc.desktopStatus();
  }
  async screenshot(options?: DesktopScreenshotRequest) {
    const rpc = await this.conn.rpc();
    return rpc.desktopScreenshot(options);
  }
  async screenshotRegion(request: DesktopScreenshotRegionRequest) {
    const rpc = await this.conn.rpc();
    return rpc.desktopScreenshotRegion(request);
  }
  async click(
    x: number,
    y: number,
    options?: { button?: DesktopMouseButton; clickCount?: number }
  ) {
    const rpc = await this.conn.rpc();
    await rpc.desktopClick({ x, y, ...options } as DesktopMouseClickRequest);
  }
  async doubleClick(x: number, y: number) {
    await this.click(x, y, { clickCount: 2 });
  }
  async tripleClick(x: number, y: number) {
    await this.click(x, y, { clickCount: 3 });
  }
  async rightClick(x: number, y: number) {
    await this.click(x, y, { button: 'right' });
  }
  async middleClick(x: number, y: number) {
    await this.click(x, y, { button: 'middle' });
  }
  async mouseDown(
    x?: number,
    y?: number,
    options?: { button?: DesktopMouseButton }
  ) {
    const rpc = await this.conn.rpc();
    await rpc.desktopMouseDown({ x, y, ...options } as DesktopMouseDownRequest);
  }
  async mouseUp(
    x?: number,
    y?: number,
    options?: { button?: DesktopMouseButton }
  ) {
    const rpc = await this.conn.rpc();
    await rpc.desktopMouseUp({ x, y, ...options } as DesktopMouseUpRequest);
  }
  async moveMouse(x: number, y: number) {
    const rpc = await this.conn.rpc();
    await rpc.desktopMoveMouse({ x, y });
  }
  async drag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    options?: { button?: DesktopMouseButton }
  ) {
    const rpc = await this.conn.rpc();
    await rpc.desktopDrag({
      startX,
      startY,
      endX,
      endY,
      ...options
    } as DesktopMouseDragRequest);
  }
  async scroll(
    x: number,
    y: number,
    direction: DesktopScrollDirection,
    amount?: number
  ) {
    const rpc = await this.conn.rpc();
    await rpc.desktopScroll({
      x,
      y,
      direction,
      amount
    } as DesktopMouseScrollRequest);
  }
  async getCursorPosition() {
    const rpc = await this.conn.rpc();
    return rpc.desktopGetCursorPosition();
  }
  async type(text: string, options?: { delay?: number }) {
    const rpc = await this.conn.rpc();
    await rpc.desktopType({ text, ...options });
  }
  async press(key: string) {
    const rpc = await this.conn.rpc();
    await rpc.desktopKeyPress({ key });
  }
  async keyDown(key: string) {
    const rpc = await this.conn.rpc();
    await rpc.desktopKeyDown({ key });
  }
  async keyUp(key: string) {
    const rpc = await this.conn.rpc();
    await rpc.desktopKeyUp({ key });
  }
  async getScreenSize() {
    const rpc = await this.conn.rpc();
    return rpc.desktopGetScreenSize();
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- match DesktopClient interface
  async getProcessStatus(_name: string) {
    const rpc = await this.conn.rpc();
    return rpc.desktopStatus();
  }
}

class RPCWatchClient {
  constructor(private conn: ContainerConnection) {}

  async watch(request: WatchRequest): Promise<ReadableStream<Uint8Array>> {
    const rpc = await this.conn.rpc();
    return rpc.watch(request.path, request.sessionId ?? 'default', {
      recursive: request.recursive,
      include: request.include,
      exclude: request.exclude
    });
  }
}

// ---------------------------------------------------------------------------
// Public client
// ---------------------------------------------------------------------------

/**
 * SandboxClient backed by direct capnweb RPC.
 *
 * Drop-in replacement for SandboxClient when the capnweb transport is active.
 * All operations call the container's SandboxRPCAPI directly over capnweb,
 * bypassing the HTTP handler/router layer entirely.
 */
export class RPCSandboxClient {
  public readonly backup: RPCBackupClient;
  public readonly commands: RPCCommandClient;
  public readonly files: RPCFileClient;
  public readonly processes: RPCProcessClient;
  public readonly ports: RPCPortClient;
  public readonly git: RPCGitClient;
  public readonly interpreter: RPCInterpreterClient;
  public readonly utils: RPCUtilityClient;
  public readonly desktop: RPCDesktopClient;
  public readonly watch: RPCWatchClient;

  private readonly conn: ContainerConnection;

  constructor(conn: ContainerConnection) {
    this.conn = conn;
    this.backup = new RPCBackupClient(conn);
    this.commands = new RPCCommandClient(conn);
    this.files = new RPCFileClient(conn);
    this.processes = new RPCProcessClient(conn);
    this.ports = new RPCPortClient(conn);
    this.git = new RPCGitClient(conn);
    this.interpreter = new RPCInterpreterClient(conn);
    this.utils = new RPCUtilityClient(conn);
    this.desktop = new RPCDesktopClient(conn);
    this.watch = new RPCWatchClient(conn);
  }

  setRetryTimeoutMs(_ms: number): void {
    // RPC transport does not use HTTP retry budgets
  }

  getTransportMode(): TransportMode {
    return 'capnweb';
  }

  isWebSocketConnected(): boolean {
    return this.conn.isConnected();
  }

  async connect(): Promise<void> {
    await this.conn.connect();
  }

  disconnect(): void {
    this.conn.disconnect();
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
    const rpc = await this.conn.rpc();
    return rpc.writeFileStream(path, stream, sessionId);
  }
}
