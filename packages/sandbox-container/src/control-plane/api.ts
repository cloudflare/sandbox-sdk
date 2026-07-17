import type {
  BackupCreateArchiveOptions,
  CheckChangesRequest,
  CheckChangesResult,
  EnsureTunnelRunRequest,
  EnsureTunnelRunResult,
  ExtensionConnectRequest,
  ExtensionHealth,
  FileEncoding,
  FileInfo,
  ListFilesOptions,
  Logger,
  MkdirOptions,
  PortWatchEvent,
  PortWatchRPCOptions,
  PortWatchSubscriptionAPI,
  ReadFileBinaryOptions,
  ReadFileOptions,
  ReadFileStreamOptions,
  SandboxAPI,
  SandboxPortsAPI,
  StopTunnelRunRequest,
  StopTunnelRunResult,
  TunnelInfo,
  WatchRequest,
  WriteFileOptions
} from '@repo/shared';
import { RpcTarget } from 'capnweb';

type InternalReadFileBinaryOptions = ReadFileBinaryOptions;
type InternalReadFileOptions = ReadFileOptions;
type InternalWriteFileOptions = WriteFileOptions;
type InternalMkdirOptions = MkdirOptions;

import type { ServiceError, ServiceResult } from '../core/types';
import type { ExtensionHost } from '../extensions';
import type { BackupService } from '../services/backup-service';
import type { CommandContextService } from '../services/command-context-service';
import type { FileService } from '../services/file-service';
import { MountService } from '../services/mount-service';
import type { PortService } from '../services/port-service';
import type { ProcessService } from '../services/process-service';
import type { TerminalManager } from '../services/terminal-manager';
import type { TunnelService } from '../services/tunnel-service';
import type { WatchService } from '../services/watch-service';
import { WorkspaceArchiveService } from '../services/workspace-archive-service';
import { MountsRPCAPI } from './mounts-rpc';
import { ProcessesRPCAPI } from './processes-rpc';
import { StreamSubscriptionRPC } from './subscription-rpc';
import { TerminalsRPCAPI } from './terminals-rpc';
import { WorkspaceRPCAPI } from './workspace-rpc';

export interface SandboxAPIDeps {
  fileService: FileService;
  portService: PortService;
  processService: ProcessService;
  backupService: BackupService;
  watchService: WatchService;
  tunnelService: TunnelService;
  terminalManager: TerminalManager;
  extensionHost: ExtensionHost;
  commandContextService: CommandContextService;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// RPC error helpers
// ---------------------------------------------------------------------------

interface ServiceResultLike {
  success: boolean;
  error?: ServiceError;
}

function throwIfError(result: ServiceResultLike): void {
  if (!result.success && result.error) {
    const { code, message, details } = result.error;
    throw Object.assign(new Error(message), { code, details });
  }
}

function extractData<T>(
  result: { success: true; data: T } | { success: false; error: ServiceError }
): T {
  throwIfError(result);
  return (result as { success: true; data: T }).data;
}

/**
 * Container control-plane API exposed over capnweb.
 *
 * Each domain is exposed as a nested RpcTarget so the client can access
 * them directly as `files`, `ports`, etc.
 */
export class SandboxControlAPI extends RpcTarget implements SandboxAPI {
  #deps: SandboxAPIDeps;
  constructor(deps: SandboxAPIDeps) {
    super();
    this.#deps = deps;
  }

  get files() {
    return new FilesRPCAPI(this.#deps.fileService);
  }
  get ports() {
    return new PortsRPCAPI(this.#deps.portService);
  }
  get processes() {
    return new ProcessesRPCAPI(this.#deps.processService);
  }
  get mounts() {
    return new MountsRPCAPI(new MountService(this.#deps.commandContextService));
  }
  get workspace() {
    const service = new WorkspaceArchiveService(
      this.#deps.commandContextService
    );
    return new WorkspaceRPCAPI(service);
  }
  get utils() {
    return new UtilsRPCAPI();
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
    options: InternalReadFileBinaryOptions
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
    options?: InternalReadFileOptions
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
  async readFile(path: string, options: { encoding?: FileEncoding } = {}) {
    if (options.encoding === 'none') {
      const result = await this.#svc.readFileBinaryStream(path);
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
    const result = await this.#svc.readFile(path, options);
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
    options: Record<string, never> = {}
  ): Promise<ReadableStream<Uint8Array>> {
    void options;
    return this.#svc.readFileStreamOperation(path);
  }

  async writeFile(
    path: string,
    content: string,
    options: InternalWriteFileOptions = {}
  ) {
    const result = await this.#svc.writeFile(path, content, options);
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
    options: Record<string, never> = {}
  ) {
    void options;
    const result = await this.#svc.writeFileStream(path, stream);
    throwIfError(result);
    const data = (result as { data?: { bytesWritten: number } }).data;
    return {
      success: true,
      path,
      bytesWritten: data?.bytesWritten ?? 0,
      timestamp: new Date().toISOString()
    };
  }

  async deleteFile(path: string, options: Record<string, never> = {}) {
    void options;
    const result = await this.#svc.deleteFile(path);
    throwIfError(result);
    return { success: true, path, timestamp: new Date().toISOString() };
  }

  async renameFile(
    oldPath: string,
    newPath: string,
    options: Record<string, never> = {}
  ) {
    void options;
    const result = await this.#svc.renameFile(oldPath, newPath);
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
    options: Record<string, never> = {}
  ) {
    void options;
    const result = await this.#svc.moveFile(sourcePath, destinationPath);
    throwIfError(result);
    return {
      success: true,
      path: sourcePath,
      newPath: destinationPath,
      timestamp: new Date().toISOString()
    };
  }

  async mkdir(path: string, options: InternalMkdirOptions = {}) {
    const result = await this.#svc.createDirectory(path, options);
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
    const result = await this.#svc.listFiles(path, options);
    const files = extractData<FileInfo[]>(result);
    return {
      success: true,
      files,
      count: files.length,
      path,
      timestamp: new Date().toISOString()
    };
  }

  async exists(path: string, options: Record<string, never> = {}) {
    void options;
    const result = await this.#svc.exists(path);
    const exists = extractData<boolean>(result);
    return { success: true, exists, path, timestamp: new Date().toISOString() };
  }
}

// ===========================================================================
// Ports
// ===========================================================================

class PortsRPCAPI extends RpcTarget implements SandboxPortsAPI {
  #portSvc: PortService;
  constructor(portSvc: PortService) {
    super();
    this.#portSvc = portSvc;
  }

  async openWatch(
    port: number,
    options?: PortWatchRPCOptions
  ): Promise<PortWatchSubscriptionAPI> {
    return new StreamSubscriptionRPC<PortWatchEvent>(
      this.#portSvc.openWatch(port, options)
    );
  }
}

// ===========================================================================
// Utility
// ===========================================================================

class UtilsRPCAPI extends RpcTarget {
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
}

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

  async restoreArchive(dir: string, archivePath: string) {
    const result = await this.#svc.restoreArchive(dir, archivePath);
    throwIfError(result);
    return { success: true, dir };
  }

  async uploadArchive(request: {
    archivePath: string;
    url: string;
    timeoutMs: number;
  }) {
    const result = await this.#svc.uploadArchive(request);
    throwIfError(result);
  }

  async uploadParts(request: {
    archivePath: string;
    parts: Array<{
      partNumber: number;
      url: string;
      offset: number;
      size: number;
    }>;
  }) {
    const result = await this.#svc.uploadParts(
      request.archivePath,
      request.parts
    );
    const data = extractData<{
      parts: Array<{ partNumber: number; etag: string }>;
    }>(result);
    return { success: true, parts: data.parts };
  }

  async prepareRestore(request: {
    dir: string;
    backupId: string;
    archivePath: string;
  }) {
    const result = await this.#svc.prepareRestore(request);
    return extractData<{ existingSize: number }>(result);
  }

  async downloadArchive(request: {
    archivePath: string;
    expectedSize: number;
    parts: Array<{ url: string; offset: number; range?: string }>;
    timeoutMs: number;
  }) {
    const result = await this.#svc.downloadArchive(request);
    throwIfError(result);
  }

  async extractArchive(dir: string, archivePath: string) {
    const result = await this.#svc.extractArchive(dir, archivePath);
    throwIfError(result);
  }

  async cleanupArchive(archivePath: string) {
    const result = await this.#svc.cleanupArchive(archivePath);
    throwIfError(result);
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

  async watch(request: WatchRequest) {
    const result = await this.#svc.watchDirectory(request.path, {
      path: request.path,
      recursive: request.recursive,
      include: request.include,
      exclude: request.exclude
    });
    return new StreamSubscriptionRPC(
      extractData<ReadableStream<Uint8Array>>(result)
    );
  }

  async checkChanges(
    request: CheckChangesRequest
  ): Promise<CheckChangesResult> {
    const result = await this.#svc.checkChanges(request.path, {
      path: request.path,
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
