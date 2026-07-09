// File operation result types
export interface MkdirResult {
  success: boolean;
  path: string;
  recursive: boolean;
  timestamp: string;
  exitCode?: number;
}

export interface WriteFileResult {
  success: boolean;
  path: string;
  timestamp: string;
  exitCode?: number;
}

/**
 * Valid `encoding` values accepted by `readFile` / `writeFile` options.
 *
 * - `'utf-8'` / `'utf8'` — treat content as text.
 * - `'base64'` — treat content as base64-encoded binary.
 * - `'none'` — streaming variant of `readFile`, returns a
 *   `ReadableStream<Uint8Array>` of raw bytes (see `ReadFileStreamResult`).
 */
export type FileEncoding = 'utf-8' | 'utf8' | 'base64' | 'none';

export interface ReadFileResult {
  success: boolean;
  path: string;
  content: string;
  timestamp: string;
  exitCode?: number;

  /**
   * Encoding used for content (utf-8 for text, base64 for binary)
   */
  encoding?: 'utf-8' | 'base64';

  /**
   * Whether the file is detected as binary
   */
  isBinary?: boolean;

  /**
   * MIME type of the file (e.g., 'image/png', 'text/plain')
   */
  mimeType?: string;

  /**
   * File size in bytes
   */
  size?: number;
}

/**
 * Result of `readFile()` with `encoding: 'none'`.
 *
 * `content` is a raw binary `ReadableStream<Uint8Array>` delivered directly
 * over the capnp channel — no base64 encoding, no SSE framing, no buffering.
 */
export interface ReadFileStreamResult {
  success: true;
  path: string;
  content: ReadableStream<Uint8Array>;
  size: number;
  mimeType: string;
  timestamp: string;
}

export interface DeleteFileResult {
  success: boolean;
  path: string;
  timestamp: string;
  exitCode?: number;
}

export interface RenameFileResult {
  success: boolean;
  path: string;
  newPath: string;
  timestamp: string;
  exitCode?: number;
}

export interface MoveFileResult {
  success: boolean;
  path: string;
  newPath: string;
  timestamp: string;
  exitCode?: number;
}

export interface FileExistsResult {
  success: boolean;
  path: string;
  exists: boolean;
  timestamp: string;
}

export interface FileInfo {
  name: string;
  absolutePath: string;
  relativePath: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
  mode: string;
  permissions: {
    readable: boolean;
    writable: boolean;
    executable: boolean;
  };
}

export interface ListFilesOptions {
  recursive?: boolean;
  includeHidden?: boolean;
}

export interface ListFilesResult {
  success: boolean;
  path: string;
  files: FileInfo[];
  count: number;
  timestamp: string;
  exitCode?: number;
}

// File Streaming Types

/**
 * SSE events for file streaming
 */
export type FileStreamEvent =
  | {
      type: 'metadata';
      mimeType: string;
      size: number;
      isBinary: boolean;
      encoding: 'utf-8' | 'base64';
    }
  | {
      type: 'chunk';
      data: string; // base64 for binary, UTF-8 for text
    }
  | {
      type: 'complete';
      bytesRead: number;
    }
  | {
      type: 'error';
      error: string;
    };

/**
 * File metadata from streaming
 */
export interface FileMetadata {
  mimeType: string;
  size: number;
  isBinary: boolean;
  encoding: 'utf-8' | 'base64';
}

/**
 * File stream chunk - either string (text) or Uint8Array (binary, auto-decoded)
 */
export type FileChunk = string | Uint8Array;

// File Watch Types

/**
 * Options for watching a directory.
 *
 * `watch()` resolves only after the watcher is established on the filesystem.
 * The returned SSE stream can be consumed with `parseSSEStream()`.
 */
export interface WatchOptions {
  /**
   * Watch subdirectories recursively
   * @default true
   */
  recursive?: boolean;

  /**
   * Glob patterns to include (e.g., '*.ts', '*.js').
   * If not specified, all files are included.
   * Cannot be used together with `exclude`.
   */
  include?: string[];

  /**
   * Glob patterns to exclude (e.g., 'node_modules', '.git').
   * Cannot be used together with `include`.
   * @default ['.git', 'node_modules', '.DS_Store']
   */
  exclude?: string[];
}

/**
 * Options for checking whether a path changed while disconnected.
 *
 * Pass the `version` returned from a previous `checkChanges()` call to learn
 * whether the path is unchanged, changed, or needs a full resync because the
 * retained change state was reset. Change state lives only for the current
 * container lifetime and may expire while idle.
 */
export interface CheckChangesOptions extends WatchOptions {
  /**
   * Version returned by a previous `checkChanges()` call.
   */
  since?: string;
}

// Internal types for SSE protocol (not user-facing)

/**
 * @internal SSE event types for container communication
 */
export type FileWatchEventType =
  | 'create'
  | 'modify'
  | 'delete'
  | 'move_from'
  | 'move_to'
  | 'attrib';

/**
 * @internal Request body for starting a file watch
 */
export interface WatchRequest {
  path: string;
  recursive?: boolean;
  events?: FileWatchEventType[];
  include?: string[];
  exclude?: string[];
}

/**
 * @internal Request body for checking retained change state.
 */
export interface CheckChangesRequest extends WatchRequest {
  since?: string;
}

/**
 * SSE events emitted by `sandbox.watch()`.
 */
export type FileWatchSSEEvent =
  | {
      type: 'watching';
      path: string;
      watchId: string;
    }
  | {
      type: 'event';
      eventType: FileWatchEventType;
      path: string;
      isDirectory: boolean;
      timestamp: string;
    }
  | {
      type: 'error';
      error: string;
    }
  | {
      type: 'stopped';
      reason: string;
    };

/**
 * Result returned by `checkChanges()`.
 */
export type CheckChangesResult =
  | {
      success: true;
      status: 'unchanged' | 'changed';
      version: string;
      timestamp: string;
    }
  | {
      success: true;
      status: 'resync';
      reason: 'expired' | 'restarted';
      version: string;
      timestamp: string;
    };

export interface EnvSetResult {
  success: boolean;
  timestamp: string;
}

export interface PortExposeResult {
  url: string;
  port: number;
  name?: string;
}

// Miscellaneous result types
export interface HealthCheckResult {
  success: boolean;
  status: 'healthy' | 'unhealthy';
  timestamp: string;
}

export interface ShutdownResult {
  success: boolean;
  message: string;
  timestamp: string;
}
