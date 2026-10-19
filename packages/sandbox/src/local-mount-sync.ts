import path from 'node:path/posix';
import type { FileWatchSSEEvent, Logger } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import type { SandboxClient } from './clients';
import type { ContainerControlClient } from './container-control';
import { openFileStream } from './file-stream';
import { parseSSEStream } from './sse-parser';
import { validatePrefix } from './storage-mount';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_ECHO_SUPPRESS_TTL_MS = 2000;
const MAX_BACKOFF_MS = 30_000;
const SYNC_CONCURRENCY = 5;

// A base64 writeFile travels in one control frame, which the container caps
// at 16 MiB. Larger objects stream into the container on the rpc transport,
// the only transport with a streaming write.
const STREAM_TO_CONTAINER_THRESHOLD_BYTES = 4 * 1024 * 1024;

// Writing a file into the mount emits a burst of modify events. Upload once
// the burst settles instead of shipping each partial state.
export const UPLOAD_DEBOUNCE_MS = 1500;

/** Watch rejections that a retry with the same request cannot fix. */
const PERMANENT_WATCH_ERRORS: ReadonlySet<unknown> = new Set([
  ErrorCode.PERMISSION_DENIED,
  ErrorCode.VALIDATION_FAILED
]);

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

  private snapshot: Map<string, R2ObjectSnapshot> = new Map();
  private echoSuppressTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();
  private uploadTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // Container -> R2 operations run one at a time, in event order, so a late
  // upload cannot land after a delete or a newer upload of the same file.
  private containerToR2Queue: Promise<void> = Promise.resolve();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private watchReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchAbortController: AbortController | null = null;
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

    // Pending uploads are dropped: without the watch stream nothing tells us
    // whether those files finished being written.
    for (const timer of this.uploadTimers.values()) {
      clearTimeout(timer);
    }
    this.uploadTimers.clear();

    for (const timer of this.echoSuppressTimers.values()) {
      clearTimeout(timer);
    }
    this.echoSuppressTimers.clear();

    this.snapshot.clear();

    this.logger.info('Local mount sync stopped', {
      mountPath: this.mountPath
    });
  }

  private async fullSyncR2ToContainer(): Promise<void> {
    const objects = await this.listAllR2Objects();
    const newSnapshot = new Map<string, R2ObjectSnapshot>();

    // No echo suppression needed: this runs before startContainerWatch() in start().
    // Process in batches to limit concurrent HTTP requests
    for (let i = 0; i < objects.length; i += SYNC_CONCURRENCY) {
      const batch = objects.slice(i, i + SYNC_CONCURRENCY);
      await Promise.all(
        batch.map(async (obj) => {
          const containerPath = this.r2KeyToContainerPath(obj.key);
          newSnapshot.set(obj.key, { etag: obj.etag, size: obj.size });
          await this.ensureParentDir(containerPath);
          await this.transferR2ObjectToContainer(obj.key, containerPath);
        })
      );
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
        await this.pollR2ForChanges();
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

    // Collect changed objects first, then transfer in batches
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

    for (let i = 0; i < changed.length; i += SYNC_CONCURRENCY) {
      const batch = changed.slice(i, i + SYNC_CONCURRENCY);
      await Promise.all(
        batch.map(async ({ key, action }) => {
          try {
            const containerPath = this.r2KeyToContainerPath(key);
            await this.ensureParentDir(containerPath);
            this.suppressEcho(containerPath);
            await this.transferR2ObjectToContainer(key, containerPath);
            // Restart the window so the watch events from a long streamed
            // write are suppressed too.
            this.suppressEcho(containerPath);
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
        })
      );
    }

    for (const [key] of this.snapshot) {
      if (!newSnapshot.has(key)) {
        const containerPath = this.r2KeyToContainerPath(key);
        this.suppressEcho(containerPath);

        try {
          await this.client.files.deleteFile(containerPath, this.sessionId);
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

  private async transferR2ObjectToContainer(
    key: string,
    containerPath: string
  ): Promise<void> {
    const obj = await this.bucket.get(key);
    if (!obj) return;

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
        const err = error instanceof Error ? error : new Error(String(error));
        if (PERMANENT_WATCH_ERRORS.has(Reflect.get(err, 'code'))) {
          this.logger.error(
            'Container rejected the mount watch; changes made in the container will not sync to R2. Update the container image to match the SDK version.',
            err,
            { mountPath: this.mountPath }
          );
          return;
        }
        this.consecutiveWatchFailures++;
        this.logger.error('Container watch loop failed', err);
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

      // Skip echo from our own R2 -> Container writes
      if (this.echoSuppressTimers.has(containerPath)) continue;

      const r2Key = this.containerPathToR2Key(containerPath);
      if (!r2Key) continue;

      switch (event.eventType) {
        case 'create':
        case 'modify':
        case 'move_to':
          this.scheduleUpload(containerPath, r2Key);
          break;

        case 'delete':
        case 'move_from':
          // A queued upload would resurrect the object after the delete.
          this.cancelScheduledUpload(containerPath);
          this.enqueueContainerToR2(containerPath, async () => {
            await this.bucket.delete(r2Key);
            this.snapshot.delete(r2Key);
            this.logger.debug('Container -> R2: deleted object', {
              path: containerPath,
              key: r2Key
            });
          });
          break;
      }
    }
  }

  /**
   * Upload a changed file once its burst of watch events settles. Each new
   * event for the path restarts the wait.
   */
  private scheduleUpload(containerPath: string, r2Key: string): void {
    this.cancelScheduledUpload(containerPath);
    const timer = setTimeout(() => {
      this.uploadTimers.delete(containerPath);
      this.enqueueContainerToR2(containerPath, async () => {
        await this.uploadFileToR2(containerPath, r2Key);
        this.logger.debug('Container -> R2: synced file', {
          path: containerPath,
          key: r2Key
        });
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

  private enqueueContainerToR2(
    containerPath: string,
    operation: () => Promise<void>
  ): void {
    this.containerToR2Queue = this.containerToR2Queue.then(async () => {
      if (!this.running) return;
      try {
        await operation();
      } catch (error) {
        this.logger.error(
          `Container -> R2 sync failed for ${containerPath}`,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });
  }

  /**
   * Stream a container file into R2, then update the local snapshot so the
   * next poll cycle doesn't echo the write back.
   */
  private async uploadFileToR2(
    containerPath: string,
    r2Key: string
  ): Promise<void> {
    // Force base64 chunks: the container classifies text by file extension,
    // and a text stream would not preserve invalid UTF-8 bytes.
    const stream = await this.client.files.readFileStream(
      containerPath,
      this.sessionId,
      { encoding: 'base64' }
    );
    const { metadata, chunks } = await openFileStream(stream);

    // Older containers ignore the encoding option and send text files as
    // strings. Re-encoding is exact for valid UTF-8; anything else changes
    // the length, so the FixedLengthStream fails the upload rather than
    // storing altered bytes.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await chunks.next();
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(
            typeof next.value === 'string'
              ? encoder.encode(next.value)
              : next.value
          );
        }
      },
      async cancel() {
        await chunks.return(metadata);
      }
    });

    // R2 needs a known length to accept a stream.
    const sized = new FixedLengthStream(metadata.size);
    body.pipeTo(sized.writable).catch(() => {});
    await this.bucket.put(r2Key, sized.readable);

    const head = await this.bucket.head(r2Key);
    if (head) {
      this.snapshot.set(r2Key, { etag: head.etag, size: head.size });
    }
  }

  private suppressEcho(containerPath: string): void {
    clearTimeout(this.echoSuppressTimers.get(containerPath));
    this.echoSuppressTimers.set(
      containerPath,
      setTimeout(() => {
        this.echoSuppressTimers.delete(containerPath);
      }, this.echoSuppressTtlMs)
    );
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

    if (!resolved.startsWith(mount)) return null;

    const relativePath = path.relative(mount, resolved);
    if (!relativePath || relativePath.startsWith('..')) return null;

    return this.prefix ? path.join(this.prefix, relativePath) : relativePath;
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
