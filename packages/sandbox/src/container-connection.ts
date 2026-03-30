/**
 * Capnweb RPC connection to the container.
 *
 * Manages a single WebSocket session and exposes typed methods that map
 * 1:1 to the container's SandboxRPCAPI. The Sandbox DO calls these
 * directly instead of going through the HTTP client layer.
 */

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
  ExecResult,
  FileInfo,
  GitCheckoutResult,
  ListFilesOptions,
  Logger,
  ReadFileResult,
  WriteFileResult
} from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import { newWebSocketRpcSession, type RpcStub } from 'capnweb';

// ---------------------------------------------------------------------------
// RPC interface — typed mirror of the container's SandboxRPCAPI
// ---------------------------------------------------------------------------

export interface ContainerRPCAPI {
  // Utility
  ping(): Promise<{ status: string; timestamp: string }>;
  getVersion(): Promise<{ version: string; timestamp: string }>;

  // Sessions
  createSession(options: {
    id: string;
    env?: Record<string, string | undefined>;
    cwd?: string;
  }): Promise<{ sessionId: string }>;
  deleteSession(
    sessionId: string
  ): Promise<{ success: boolean; sessionId: string }>;
  listSessions(): Promise<{ sessions: string[] }>;

  // Commands
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

  // Files
  readFile(
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
  }>;
  readFileStream(
    path: string,
    sessionId: string
  ): Promise<ReadableStream<Uint8Array>>;
  writeFile(
    path: string,
    content: string,
    sessionId: string,
    options?: { encoding?: string; permissions?: string }
  ): Promise<{
    success: boolean;
    path: string;
    bytesWritten: number;
    timestamp: string;
  }>;
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
  deleteFile(
    path: string,
    sessionId: string
  ): Promise<{ success: boolean; path: string; timestamp: string }>;
  renameFile(
    oldPath: string,
    newPath: string,
    sessionId: string
  ): Promise<{
    success: boolean;
    oldPath: string;
    newPath: string;
    timestamp: string;
  }>;
  moveFile(
    sourcePath: string,
    destinationPath: string,
    sessionId: string
  ): Promise<{
    success: boolean;
    sourcePath: string;
    destinationPath: string;
    timestamp: string;
  }>;
  mkdir(
    path: string,
    sessionId: string,
    options?: { recursive?: boolean }
  ): Promise<{ success: boolean; path: string; timestamp: string }>;
  listFiles(
    path: string,
    sessionId: string,
    options?: ListFilesOptions
  ): Promise<{ files: FileInfo[]; path: string; timestamp: string }>;
  exists(
    path: string,
    sessionId: string
  ): Promise<{ exists: boolean; path: string; timestamp: string }>;

  // Processes
  startProcess(
    command: string,
    sessionId: string,
    options?: { processId?: string; timeoutMs?: number }
  ): Promise<{
    id: string;
    pid?: number;
    command: string;
    status: string;
    timestamp: string;
  }>;
  listProcesses(): Promise<
    Array<{
      id: string;
      pid?: number;
      command: string;
      status: string;
      startTime: string;
      exitCode?: number;
    }>
  >;
  getProcess(id: string): Promise<{
    id: string;
    pid?: number;
    command: string;
    status: string;
    startTime: string;
    exitCode?: number;
    stdout: string;
    stderr: string;
  }>;
  killProcess(id: string): Promise<void>;
  killAllProcesses(): Promise<number>;
  getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }>;
  streamProcessLogs(id: string): Promise<ReadableStream<Uint8Array>>;

  // Ports
  exposePort(
    port: number,
    sessionId: string,
    name?: string
  ): Promise<{ port: number; name?: string; timestamp: string }>;
  listExposedPorts(): Promise<{
    ports: Array<{ port: number; name?: string }>;
  }>;
  unexposePort(port: number): Promise<void>;
  watchPorts(request: {
    port: number;
    mode: 'http' | 'tcp';
    path?: string;
    statusMin?: number;
    statusMax?: number;
    processId?: string;
    interval?: number;
  }): Promise<ReadableStream<Uint8Array>>;

  // Git
  gitCheckout(
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
  }>;

  // Code interpreter
  createCodeContext(options?: {
    language?: string;
    cwd?: string;
  }): Promise<{ contextId: string; language: string }>;
  executeCode(
    contextId: string,
    code: string,
    language?: string
  ): Promise<Response>;
  listCodeContexts(): Promise<Array<{ id: string; language: string }>>;
  deleteCodeContext(contextId: string): Promise<void>;

  // Backup
  createBackup(
    dir: string,
    archivePath: string,
    sessionId: string
  ): Promise<unknown>;
  restoreBackup(
    dir: string,
    archivePath: string,
    sessionId: string
  ): Promise<unknown>;

  // Desktop
  desktopStart(request?: DesktopStartRequest): Promise<DesktopStartResult>;
  desktopStop(): Promise<DesktopStopResult>;
  desktopStatus(): Promise<DesktopStatusResult>;
  desktopScreenshot(
    request?: DesktopScreenshotRequest
  ): Promise<DesktopScreenshotResult>;
  desktopScreenshotRegion(
    request: DesktopScreenshotRegionRequest
  ): Promise<DesktopScreenshotResult>;
  desktopClick(request: DesktopMouseClickRequest): Promise<void>;
  desktopMoveMouse(request: DesktopMouseMoveRequest): Promise<void>;
  desktopMouseDown(request: DesktopMouseDownRequest): Promise<void>;
  desktopMouseUp(request: DesktopMouseUpRequest): Promise<void>;
  desktopDrag(request: DesktopMouseDragRequest): Promise<void>;
  desktopScroll(request: DesktopMouseScrollRequest): Promise<void>;
  desktopGetCursorPosition(): Promise<DesktopCursorPosition>;
  desktopType(request: DesktopTypeRequest): Promise<void>;
  desktopKeyPress(request: DesktopKeyPressRequest): Promise<void>;
  desktopKeyDown(request: DesktopKeyPressRequest): Promise<void>;
  desktopKeyUp(request: DesktopKeyPressRequest): Promise<void>;
  desktopGetScreenSize(): Promise<DesktopScreenSize>;

  // Watch
  watch(
    path: string,
    sessionId: string,
    options?: {
      recursive?: boolean;
      include?: string[];
      exclude?: string[];
    }
  ): Promise<ReadableStream<Uint8Array>>;
}

// ---------------------------------------------------------------------------
// Connection manager
// ---------------------------------------------------------------------------

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Stub that can issue a WebSocket-upgrade fetch through the DO's Container base class. */
export interface ContainerFetchStub {
  fetch(request: Request): Promise<Response>;
}

export interface ContainerConnectionOptions {
  stub: ContainerFetchStub;
  port?: number;
  logger?: Logger;
}

/**
 * Manages a capnweb WebSocket RPC session to the container.
 *
 * The Sandbox DO creates one of these and calls `api()` to get the typed
 * stub for making RPC calls. Connection is established lazily on first
 * access and re-established automatically after disconnect.
 */
export class ContainerConnection {
  private stub: RpcStub<ContainerRPCAPI> | null = null;
  private ws: WebSocket | null = null;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private readonly containerStub: ContainerFetchStub;
  private readonly port: number;
  private readonly logger: Logger;

  constructor(options: ContainerConnectionOptions) {
    this.containerStub = options.stub;
    this.port = options.port ?? 3000;
    this.logger = options.logger ?? createNoOpLogger();
  }

  /**
   * Get the typed RPC stub. Connects lazily on first call.
   */
  async rpc(): Promise<RpcStub<ContainerRPCAPI>> {
    if (!this.isConnected()) {
      await this.connect();
    }
    return this.stub!;
  }

  isConnected(): boolean {
    return this.connected && this.stub !== null;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  disconnect(): void {
    if (this.stub) {
      try {
        (
          this.stub as unknown as {
            [Symbol.dispose]?: () => void;
          }
        )[Symbol.dispose]?.();
      } catch {
        // Stub may already be disposed
      }
      this.stub = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // WebSocket may already be closed
      }
      this.ws = null;
    }
    this.connected = false;
    this.connectPromise = null;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async doConnect(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DEFAULT_CONNECT_TIMEOUT_MS
    );

    try {
      const url = `http://localhost:${this.port}/capnweb`;
      const request = new Request(url, {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade'
        },
        signal: controller.signal
      });

      const response = await this.containerStub.fetch(request);
      clearTimeout(timeout);

      if (response.status !== 101) {
        throw new Error(
          `WebSocket upgrade failed: ${response.status} ${response.statusText}`
        );
      }

      const ws = (response as unknown as { webSocket?: WebSocket }).webSocket;
      if (!ws) {
        throw new Error('No WebSocket in upgrade response');
      }

      (ws as unknown as { accept: () => void }).accept();

      this.ws = ws;
      this.stub = newWebSocketRpcSession<ContainerRPCAPI>(ws);
      this.connected = true;

      this.logger.debug('ContainerConnection established', {
        port: this.port
      });
    } catch (error) {
      clearTimeout(timeout);
      this.connected = false;
      this.logger.error(
        'ContainerConnection failed',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }
}
