import path from 'node:path/posix';
import type {
  FileWatchEventType,
  FileWatchSSEEvent,
  Logger
} from '@repo/shared';
import type { SandboxClient } from './clients';
import type { ContainerControlClient } from './container-control';
import { streamFile } from './file-stream';
import { parseSSEStream } from './sse-parser';
import { validatePrefix } from './storage-mount';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_ECHO_SUPPRESS_TTL_MS = 2000;
const MAX_BACKOFF_MS = 30_000;
export const UPLOAD_DEBOUNCE_MS = 1500;
const STREAM_TO_CONTAINER_THRESHOLD_BYTES = 4 * 1024 * 1024;
const DEFAULT_UPLOAD_PART_BYTES = 16 * 1024 * 1024;
const ATOMIC_WRITE_TEMP_PATH =
  /\.tmp\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface R2ObjectSnapshot {
  etag: string;
  size: number;
}

interface LocalMountSyncOptions {
  bucket: R2Bucket;
  mountPath: string;
  prefix: string | undefined;
  readOnly: boolean;
  client: SandboxClient | ContainerControlClient;
  sessionId: string;
  logger: Logger;
  pollIntervalMs?: number;
  echoSuppressTtlMs?: number;
  uploadPartBytes?: number;
}

/**
 * Manages bidirectional sync between an R2 binding and a container directory.
 *
 * R2 -> Container: polls bucket.list() to detect changes, then transfers diffs.
 * Container -> R2: uses inotifywait via the watch API to detect file changes.
 */
export class LocalMountSyncManager {
  private readonly bucket: R2Bucket;
  private readonly mountPath: string;
  private readonly prefix: string | undefined;
  private readonly readOnly: boolean;
  private readonly client: SandboxClient | ContainerControlClient;
  private readonly sessionId: string;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;

  private readonly echoSuppressTtlMs: number;
  private readonly uploadPartBytes: number;

  private snapshot: Map<string, R2ObjectSnapshot> = new Map();
  private echoSuppressSet: Set<string> = new Set();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private watchReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchAbortController: AbortController | null = null;
  private uploadTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private transferQueue: Promise<void> = Promise.resolve();
  private running = false;
  private consecutivePollFailures = 0;
  private consecutiveWatchFailures = 0;

  constructor(options: LocalMountSyncOptions) {
    this.bucket = options.bucket;
    this.mountPath = options.mountPath;
    if (options.prefix !== undefined) {
      validatePrefix(options.prefix);
    }
    // R2 keys never have leading slashes. Convert the validated '/'-prefixed
    // value into bare R2 key format for list() and put().
    this.prefix = options.prefix?.replace(/^\//, '') || undefined;
    this.readOnly = options.readOnly;
    this.client = options.client;
    this.sessionId = options.sessionId;
    this.logger = options.logger.child({ operation: 'local-mount-sync' });
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.echoSuppressTtlMs =
      options.echoSuppressTtlMs ?? DEFAULT_ECHO_SUPPRESS_TTL_MS;
    this.uploadPartBytes = options.uploadPartBytes ?? DEFAULT_UPLOAD_PART_BYTES;
  }

  /**
   * Start bidirectional sync. Performs initial full sync, then starts
   * the R2 poll loop and (if not readOnly) the container watch loop.
   */
  async start(): Promise<void> {
    this.running = true;

    await this.client.files.mkdir(this.mountPath, this.sessionId, {
      recursive: true
    });

    await this.fullSyncR2ToContainer();
    this.schedulePoll();

    if (!this.readOnly) {
      this.startContainerWatch();
    }

    this.logger.info('Local mount sync started', {
      mountPath: this.mountPath,
      prefix: this.prefix,
      readOnly: this.readOnly,
      pollIntervalMs: this.pollIntervalMs
    });
  }

  /**
   * Stop all sync activity and clean up resources.
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.watchReconnectTimer) {
      clearTimeout(this.watchReconnectTimer);
      this.watchReconnectTimer = null;
    }

    if (this.watchAbortController) {
      this.watchAbortController.abort();
      this.watchAbortController = null;
    }

    // Uploads still waiting on their debounce are dropped: the watch stream is
    // gone, so nothing tells us whether those files finished being written.
    const droppedUploads = this.uploadTimers.size;
    for (const timer of this.uploadTimers.values()) {
      clearTimeout(timer);
    }
    this.uploadTimers.clear();

    this.snapshot.clear();
    this.echoSuppressSet.clear();

    this.logger.info('Local mount sync stopped', {
      mountPath: this.mountPath,
      droppedUploads
    });
  }

  private async fullSyncR2ToContainer(): Promise<void> {
    const objects = await this.listAllR2Objects();
    const newSnapshot = new Map<string, R2ObjectSnapshot>();

    // No echo suppression needed: this runs before startContainerWatch() in start().
    // Transfers run one at a time — see transferR2ObjectToContainer().
    for (const obj of objects) {
      const containerPath = this.r2KeyToContainerPath(obj.key);
      newSnapshot.set(obj.key, { etag: obj.etag, size: obj.size });
      await this.ensureParentDir(containerPath);
      await this.transferR2ObjectToContainer(obj.key, containerPath);
    }

    this.snapshot = newSnapshot;
    this.logger.debug('Initial R2 -> Container sync complete', {
      objectCount: objects.length
    });
  }

  private schedulePoll(): void {
    if (!this.running) return;

    const backoffMs =
      this.consecutivePollFailures > 0
        ? Math.min(
            this.pollIntervalMs * 2 ** this.consecutivePollFailures,
            MAX_BACKOFF_MS
          )
        : this.pollIntervalMs;

    this.pollTimer = setTimeout(async () => {
      try {
        await this.enqueueTransfer(async () => {
          if (this.running) await this.pollR2ForChanges();
        });
        this.consecutivePollFailures = 0;
      } catch (error) {
        this.consecutivePollFailures++;
        this.logger.error(
          'R2 poll cycle failed',
          error instanceof Error ? error : new Error(String(error))
        );
      }
      this.schedulePoll();
    }, backoffMs);
  }

  private async pollR2ForChanges(): Promise<void> {
    const objects = await this.listAllR2Objects();
    const newSnapshot = new Map<string, R2ObjectSnapshot>();

    // Collect changed objects first, then transfer them one at a time
    const changed: Array<{ key: string; action: 'created' | 'modified' }> = [];
    for (const obj of objects) {
      newSnapshot.set(obj.key, { etag: obj.etag, size: obj.size });
      const existing = this.snapshot.get(obj.key);
      if (!existing || existing.etag !== obj.etag) {
        changed.push({
          key: obj.key,
          action: existing ? 'modified' : 'created'
        });
      }
    }

    for (const { key, action } of changed) {
      try {
        const containerPath = this.r2KeyToContainerPath(key);
        await this.ensureParentDir(containerPath);
        await this.withEchoSuppression(containerPath, () =>
          this.transferR2ObjectToContainer(key, containerPath)
        );
        this.logger.debug('R2 -> Container: synced object', {
          key,
          action
        });
      } catch (error) {
        this.logger.error(
          `R2 -> Container: failed to sync object ${key}`,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }

    for (const [key] of this.snapshot) {
      if (!newSnapshot.has(key)) {
        const containerPath = this.r2KeyToContainerPath(key);

        try {
          await this.withEchoSuppression(containerPath, () =>
            this.client.files.deleteFile(containerPath, this.sessionId)
          );
          this.logger.debug('R2 -> Container: deleted file', { key });
        } catch (error) {
          this.logger.error(
            'R2 -> Container: failed to delete',
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
    }

    this.snapshot = newSnapshot;
  }

  private async listAllR2Objects(): Promise<
    Array<{ key: string; etag: string; size: number }>
  > {
    const results: Array<{ key: string; etag: string; size: number }> = [];
    let cursor: string | undefined;

    do {
      const listResult = await this.bucket.list({
        ...(this.prefix && { prefix: this.prefix }),
        ...(cursor && { cursor })
      });

      for (const obj of listResult.objects) {
        results.push({ key: obj.key, etag: obj.etag, size: obj.size });
      }

      cursor = listResult.truncated ? listResult.cursor : undefined;
    } while (cursor);

    return results;
  }

  /**
   * Transfer one R2 object into the container.
   *
   * Callers transfer objects one at a time. A streamed transfer holds a stream
   * export open on the shared capnweb RPC session; running transfers
   * concurrently (and, in a `Promise.all`, abandoning an in-flight export when
   * a sibling rejects) tears that session down, which fails every other call
   * on it — including the rest of the sync.
   */
  private async transferR2ObjectToContainer(
    key: string,
    containerPath: string
  ): Promise<void> {
    const obj = await this.bucket.get(key);
    if (!obj) return;

    // Large objects go straight from R2 to the container as a byte stream.
    // Streaming needs writeFileStream, which is rpc-only; http and websocket
    // transports keep using the base64 write below.
    if (
      obj.size > STREAM_TO_CONTAINER_THRESHOLD_BYTES &&
      this.client.getTransportMode() === 'rpc'
    ) {
      await this.client.files.writeFileStream(
        containerPath,
        obj.body,
        this.sessionId
      );
      return;
    }

    const arrayBuffer = await obj.arrayBuffer();
    const base64 = uint8ArrayToBase64(new Uint8Array(arrayBuffer));

    await this.client.files.writeFile(containerPath, base64, this.sessionId, {
      encoding: 'base64'
    });
  }

  private async ensureParentDir(containerPath: string): Promise<void> {
    const parentDir = containerPath.substring(
      0,
      containerPath.lastIndexOf('/')
    );
    if (parentDir && parentDir !== this.mountPath) {
      await this.client.files.mkdir(parentDir, this.sessionId, {
        recursive: true
      });
    }
  }

  private startContainerWatch(): void {
    this.watchAbortController = new AbortController();
    this.runWatchWithRetry();
  }

  private runWatchWithRetry(): void {
    if (!this.running) return;

    this.runContainerWatchLoop()
      .then(() => {
        // Stream ended cleanly (e.g. server closed it). Reconnect unless stopped.
        this.consecutiveWatchFailures = 0;
        this.scheduleWatchReconnect();
      })
      .catch((error) => {
        if (!this.running) return;
        this.consecutiveWatchFailures++;
        this.logger.error(
          'Container watch loop failed',
          error instanceof Error ? error : new Error(String(error))
        );
        this.scheduleWatchReconnect();
      });
  }

  private scheduleWatchReconnect(): void {
    if (!this.running) return;

    const backoffMs =
      this.consecutiveWatchFailures > 0
        ? Math.min(
            this.pollIntervalMs * 2 ** this.consecutiveWatchFailures,
            MAX_BACKOFF_MS
          )
        : this.pollIntervalMs;

    this.logger.debug('Reconnecting container watch', {
      backoffMs,
      failures: this.consecutiveWatchFailures
    });

    this.watchReconnectTimer = setTimeout(() => {
      this.watchReconnectTimer = null;
      if (!this.running) return;
      this.watchAbortController = new AbortController();
      this.runWatchWithRetry();
    }, backoffMs);
  }

  private async runContainerWatchLoop(): Promise<void> {
    const stream = await this.client.watch.watch({
      path: this.mountPath,
      recursive: true,
      sessionId: this.sessionId
    });

    for await (const event of parseSSEStream<FileWatchSSEEvent>(
      stream,
      this.watchAbortController?.signal
    )) {
      if (!this.running) break;

      // Successful event received — reset failure counter
      this.consecutiveWatchFailures = 0;

      if (event.type !== 'event') continue;
      if (event.isDirectory) continue;

      const containerPath = event.path;
      if (ATOMIC_WRITE_TEMP_PATH.test(containerPath)) continue;

      // Skip echo from our own R2 -> Container writes
      if (this.echoSuppressSet.has(containerPath)) continue;

      const r2Key = this.containerPathToR2Key(containerPath);
      if (!r2Key) continue;

      try {
        switch (event.eventType) {
          case 'create':
          case 'modify':
          case 'move_to': {
            this.scheduleUpload(containerPath, r2Key, event.eventType);
            break;
          }

          case 'delete':
          case 'move_from': {
            this.cancelScheduledUpload(containerPath);
            await this.enqueueTransfer(async () => {
              await this.bucket.delete(r2Key);
              this.snapshot.delete(r2Key);
            });
            this.logger.debug('Container -> R2: deleted object', {
              path: containerPath,
              key: r2Key
            });
            break;
          }
        }
      } catch (error) {
        this.logger.error(
          `Container -> R2 sync failed for ${containerPath}`,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  }

  /**
   * Queue an upload for a changed container file, replacing any upload already
   * queued for the same path. Only the last event of a write burst survives,
   * so each settled file is uploaded once.
   */
  private scheduleUpload(
    containerPath: string,
    r2Key: string,
    action: FileWatchEventType
  ): void {
    this.cancelScheduledUpload(containerPath);

    const timer = setTimeout(() => {
      this.uploadTimers.delete(containerPath);
      this.enqueueTransfer(async () => {
        if (this.running) await this.uploadFileToR2(containerPath, r2Key);
      })
        .then(() => {
          this.logger.debug('Container -> R2: synced file', {
            path: containerPath,
            key: r2Key,
            action
          });
        })
        .catch((error) => {
          this.logger.error(
            `Container -> R2 sync failed for ${containerPath}`,
            error instanceof Error ? error : new Error(String(error))
          );
        });
    }, UPLOAD_DEBOUNCE_MS);

    this.uploadTimers.set(containerPath, timer);
  }

  private cancelScheduledUpload(containerPath: string): void {
    const timer = this.uploadTimers.get(containerPath);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.uploadTimers.delete(containerPath);
    }
  }

  /** Upload a container file and refresh the poll snapshot. */
  private async uploadFileToR2(
    containerPath: string,
    r2Key: string
  ): Promise<void> {
    const chunks =
      this.client.getTransportMode() === 'rpc'
        ? readByteStream(
            (
              await this.client.files.readFile(containerPath, this.sessionId, {
                encoding: 'none'
              })
            ).content
          )
        : streamFile(
            await this.client.files.readFileStream(
              containerPath,
              this.sessionId
            )
          );
    const encoder = new TextEncoder();
    const pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let upload: R2MultipartUpload | null = null;
    const uploadedParts: R2UploadedPart[] = [];

    // Take exactly `size` bytes off the front of the pending chunks, keeping
    // the remainder of a partially consumed chunk queued. R2 rejects a
    // multipart upload whose parts are not all the same size except the last.
    const takePart = (size: number): Uint8Array => {
      const part = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const chunk = pending[0];
        const remaining = size - offset;
        if (chunk.byteLength <= remaining) {
          part.set(chunk, offset);
          offset += chunk.byteLength;
          pending.shift();
        } else {
          part.set(chunk.subarray(0, remaining), offset);
          pending[0] = chunk.subarray(remaining);
          offset = size;
        }
      }
      pendingBytes -= size;
      return part;
    };

    try {
      for await (const chunk of chunks) {
        const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
        if (bytes.byteLength === 0) continue;

        pending.push(bytes);
        pendingBytes += bytes.byteLength;

        while (pendingBytes >= this.uploadPartBytes) {
          upload ??= await this.bucket.createMultipartUpload(r2Key);
          uploadedParts.push(
            await upload.uploadPart(
              uploadedParts.length + 1,
              takePart(this.uploadPartBytes)
            )
          );
        }
      }

      if (upload) {
        if (pendingBytes > 0) {
          uploadedParts.push(
            await upload.uploadPart(
              uploadedParts.length + 1,
              takePart(pendingBytes)
            )
          );
        }
        await upload.complete(uploadedParts);
      } else {
        await this.bucket.put(r2Key, takePart(pendingBytes));
      }
    } catch (error) {
      if (upload) {
        // Leaving the upload open would keep its parts billable in R2.
        await upload.abort().catch(() => {});
      }
      throw error;
    }

    await this.refreshSnapshot(r2Key);
  }

  private async refreshSnapshot(r2Key: string): Promise<void> {
    const head = await this.bucket.head(r2Key);
    if (head) this.snapshot.set(r2Key, { etag: head.etag, size: head.size });
  }

  private enqueueTransfer(operation: () => Promise<void>): Promise<void> {
    const task = this.transferQueue.then(operation);
    this.transferQueue = task.catch(() => {});
    return task;
  }

  private async withEchoSuppression<T>(
    containerPath: string,
    operation: () => Promise<T>
  ): Promise<T> {
    this.echoSuppressSet.add(containerPath);
    try {
      return await operation();
    } finally {
      setTimeout(() => {
        this.echoSuppressSet.delete(containerPath);
      }, this.echoSuppressTtlMs);
    }
  }

  private r2KeyToContainerPath(key: string): string {
    let relativePath = key;
    if (this.prefix) {
      relativePath = key.startsWith(this.prefix)
        ? key.slice(this.prefix.length)
        : key;
    }
    return path.join(this.mountPath, relativePath);
  }

  private containerPathToR2Key(containerPath: string): string | null {
    const resolved = path.resolve(containerPath);
    const mount = path.resolve(this.mountPath);

    if (resolved !== mount && !resolved.startsWith(`${mount}/`)) return null;

    const relativePath = path.relative(mount, resolved);
    if (!relativePath || relativePath.startsWith('..')) return null;

    return this.prefix ? path.join(this.prefix, relativePath) : relativePath;
  }
}

async function* readByteStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
