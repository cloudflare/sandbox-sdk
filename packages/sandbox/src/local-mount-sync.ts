import path from 'node:path/posix';
import type { FileWatchSSEEvent, Logger } from '@repo/shared';
import type { ContainerControlClient } from './container-control';
import { openRemoteSubscription } from './processes/remote-subscription';
import { parseSSEStream } from './sse-parser';
import { validatePrefix } from './storage-mount';
import type {
  MountRuntimeCall,
  MountRuntimeHold
} from './storage-mount/runtime-call';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_ECHO_SUPPRESS_TTL_MS = 2000;
const MAX_BACKOFF_MS = 30_000;
const SYNC_CONCURRENCY = 5;

// A base64 writeFile travels in one control frame, which the container caps
// at 16 MiB. Larger objects stream into the container instead.
const STREAM_TO_CONTAINER_THRESHOLD_BYTES = 4 * 1024 * 1024;

// Writing a file into the mount emits a burst of modify events. Upload once
// the burst settles instead of shipping each partial state.
export const UPLOAD_DEBOUNCE_MS = 1500;

interface R2ObjectSnapshot {
  etag: string;
  size: number;
}

interface LocalMountSyncOptions {
  bucket: R2Bucket;
  mountPath: string;
  prefix: string | undefined;
  readOnly: boolean;
  runRuntimeCall: MountRuntimeCall;
  runtimeHold?: MountRuntimeHold;
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
  private readonly runRuntimeCall: MountRuntimeCall;
  private readonly runtimeHold: MountRuntimeHold;
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
  private generation = 0;
  private activePollCycle: Promise<void> | null = null;
  private activeWatchLoop: Promise<void> | null = null;
  private consecutivePollFailures = 0;
  private consecutiveWatchFailures = 0;
  private runtimeHoldReleased = false;

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
    this.runRuntimeCall = options.runRuntimeCall;
    this.runtimeHold = options.runtimeHold ?? { release: () => {} };
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
    this.generation += 1;
    const generation = this.generation;

    await this.runRuntimeCallIfCurrent(
      generation,
      'mount.local.mkdir',
      (control) =>
        control.files.mkdir(this.mountPath, {
          recursive: true
        })
    );

    if (!this.isCurrentGeneration(generation)) return;
    await this.fullSyncR2ToContainer(generation);
    if (!this.isCurrentGeneration(generation)) return;
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
    this.interrupt();

    const pollCycle = this.activePollCycle;
    const watchLoop = this.activeWatchLoop;
    await Promise.allSettled([
      ...[pollCycle, watchLoop].filter(isPromise),
      this.containerToR2Queue
    ]);

    for (const timer of this.echoSuppressTimers.values()) {
      clearTimeout(timer);
    }
    this.echoSuppressTimers.clear();

    this.snapshot.clear();

    this.logger.info('Local mount sync stopped', {
      mountPath: this.mountPath
    });
  }

  interrupt(): void {
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

    if (!this.runtimeHoldReleased) {
      this.runtimeHoldReleased = true;
      this.runtimeHold.release();
    }
  }

  private async fullSyncR2ToContainer(generation: number): Promise<void> {
    const objects = await this.listAllR2Objects();
    if (!this.isCurrentGeneration(generation)) return;
    const newSnapshot = new Map<string, R2ObjectSnapshot>();

    // No echo suppression needed: this runs before startContainerWatch() in start().
    // Process in batches to limit concurrent HTTP requests
    for (let i = 0; i < objects.length; i += SYNC_CONCURRENCY) {
      if (!this.isCurrentGeneration(generation)) return;
      const batch = objects.slice(i, i + SYNC_CONCURRENCY);
      await Promise.all(
        batch.map(async (obj) => {
          if (!this.isCurrentGeneration(generation)) return;
          const containerPath = this.r2KeyToContainerPath(obj.key);
          newSnapshot.set(obj.key, { etag: obj.etag, size: obj.size });
          await this.ensureParentDir(containerPath, generation);
          await this.transferR2ObjectToContainer(
            obj.key,
            containerPath,
            generation
          );
        })
      );
    }

    if (!this.isCurrentGeneration(generation)) return;
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

    const generation = this.generation;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (!this.isCurrentGeneration(generation)) return;
      const cycle = this.pollR2ForChanges(generation)
        .then(() => {
          if (this.isCurrentGeneration(generation)) {
            this.consecutivePollFailures = 0;
          }
        })
        .catch((error) => {
          if (!this.isCurrentGeneration(generation)) return;
          this.consecutivePollFailures++;
          this.logger.error(
            'R2 poll cycle failed',
            error instanceof Error ? error : new Error(String(error))
          );
        })
        .finally(() => {
          if (this.activePollCycle === cycle) {
            this.activePollCycle = null;
          }
          if (this.isCurrentGeneration(generation)) {
            this.schedulePoll();
          }
        });
      this.activePollCycle = cycle;
    }, backoffMs);
  }

  private async pollR2ForChanges(generation: number): Promise<void> {
    const objects = await this.listAllR2Objects();
    if (!this.isCurrentGeneration(generation)) return;
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
            if (!this.isCurrentGeneration(generation)) return;
            const containerPath = this.r2KeyToContainerPath(key);
            await this.ensureParentDir(containerPath, generation);
            if (!this.isCurrentGeneration(generation)) return;
            this.suppressEcho(containerPath);
            await this.transferR2ObjectToContainer(
              key,
              containerPath,
              generation
            );
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
          if (!this.isCurrentGeneration(generation)) return;
          await this.runRuntimeCallIfCurrent(
            generation,
            'mount.local.deleteFile',
            (control) => control.files.deleteFile(containerPath)
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

    if (!this.isCurrentGeneration(generation)) return;
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
    containerPath: string,
    generation?: number
  ): Promise<void> {
    const obj = await this.bucket.get(key);
    if (!obj) return;

    if (obj.size > STREAM_TO_CONTAINER_THRESHOLD_BYTES) {
      try {
        await this.runRuntimeCallIfCurrent(
          generation,
          'mount.local.writeFileStream',
          (control) => control.files.writeFileStream(containerPath, obj.body)
        );
      } catch (error) {
        // A call that fails before reading the body leaves the R2 read open.
        await obj.body.cancel().catch(() => {});
        throw error;
      }
      return;
    }

    const arrayBuffer = await obj.arrayBuffer();
    const base64 = uint8ArrayToBase64(new Uint8Array(arrayBuffer));

    await this.runRuntimeCallIfCurrent(
      generation,
      'mount.local.writeFile',
      (control) =>
        control.files.writeFile(containerPath, base64, {
          encoding: 'base64'
        })
    );
  }

  private async ensureParentDir(
    containerPath: string,
    generation?: number
  ): Promise<void> {
    const parentDir = containerPath.substring(
      0,
      containerPath.lastIndexOf('/')
    );
    if (parentDir && parentDir !== this.mountPath) {
      await this.runRuntimeCallIfCurrent(
        generation,
        'mount.local.mkdir',
        (control) =>
          control.files.mkdir(parentDir, {
            recursive: true
          })
      );
    }
  }

  private startContainerWatch(): void {
    this.watchAbortController = new AbortController();
    this.runWatchWithRetry();
  }

  private runWatchWithRetry(): void {
    if (!this.running) return;

    const generation = this.generation;
    const loop = this.runContainerWatchLoop(generation)
      .then(() => {
        if (!this.isCurrentGeneration(generation)) return;
        // Stream ended cleanly (e.g. server closed it). Reconnect unless stopped.
        this.consecutiveWatchFailures = 0;
        this.scheduleWatchReconnect();
      })
      .catch((error) => {
        if (!this.isCurrentGeneration(generation)) return;
        this.consecutiveWatchFailures++;
        this.logger.error(
          'Container watch loop failed',
          error instanceof Error ? error : new Error(String(error))
        );
        this.scheduleWatchReconnect();
      })
      .finally(() => {
        if (this.activeWatchLoop === loop) {
          this.activeWatchLoop = null;
        }
      });
    this.activeWatchLoop = loop;
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

  private async runContainerWatchLoop(generation: number): Promise<void> {
    await this.runRuntimeCallIfCurrent(
      generation,
      'mount.local.watch',
      async (control) => {
        const stream = await openRemoteSubscription(
          control.watch.watch({
            path: this.mountPath,
            recursive: true
          }),
          {
            signal: this.watchAbortController?.signal,
            operation: 'open local mount filesystem watch',
            protocol: 'stream'
          }
        );

        for await (const event of parseSSEStream<FileWatchSSEEvent>(
          stream,
          this.watchAbortController?.signal
        )) {
          if (!this.isCurrentGeneration(generation)) break;

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
              this.scheduleUpload(containerPath, r2Key, generation);
              break;

            case 'delete':
            case 'move_from':
              // A queued upload would resurrect the object after the delete.
              this.cancelScheduledUpload(containerPath);
              this.enqueueContainerToR2(containerPath, generation, async () => {
                await this.bucket.delete(r2Key);
                if (!this.isCurrentGeneration(generation)) return;
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
    );
  }

  /**
   * Upload a changed file once its burst of watch events settles. Each new
   * event for the path restarts the wait.
   */
  private scheduleUpload(
    containerPath: string,
    r2Key: string,
    generation: number
  ): void {
    this.cancelScheduledUpload(containerPath);
    const timer = setTimeout(() => {
      this.uploadTimers.delete(containerPath);
      this.enqueueContainerToR2(containerPath, generation, async () => {
        await this.uploadFileToR2(containerPath, r2Key, generation);
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
    generation: number,
    operation: () => Promise<void>
  ): void {
    this.containerToR2Queue = this.containerToR2Queue.then(async () => {
      if (!this.isCurrentGeneration(generation)) return;
      try {
        await operation();
      } catch (error) {
        if (!this.isCurrentGeneration(generation)) return;
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
    r2Key: string,
    generation?: number
  ): Promise<void> {
    await this.runRuntimeCallIfCurrent(
      generation,
      'mount.local.readFile',
      async (control) => {
        const file = await control.files.readFile(containerPath, {
          encoding: 'none'
        });
        if (!this.isCurrentOrUnscoped(generation)) {
          await file.content.cancel();
          return;
        }

        // R2 needs a known length to accept a stream.
        const sized = new FixedLengthStream(file.size);
        const pipeAbort = new AbortController();
        file.content
          .pipeTo(sized.writable, { signal: pipeAbort.signal })
          .catch(() => {});
        try {
          await this.bucket.put(r2Key, sized.readable);
        } catch (error) {
          // put() can reject without reading its body; stop reading the file.
          pipeAbort.abort(error);
          throw error;
        }
      }
    );
    if (!this.isCurrentOrUnscoped(generation)) return;

    const head = await this.bucket.head(r2Key);
    if (head) {
      this.snapshot.set(r2Key, { etag: head.etag, size: head.size });
    }
  }

  private async runRuntimeCallIfCurrent<T>(
    generation: number | undefined,
    operation: string,
    call: (control: ContainerControlClient) => Promise<T>
  ): Promise<T> {
    if (generation !== undefined && !this.isCurrentGeneration(generation)) {
      throw new Error('local mount sync stopped');
    }
    return await this.runRuntimeCall(operation, async (control) => {
      if (generation !== undefined && !this.isCurrentGeneration(generation)) {
        throw new Error('local mount sync stopped');
      }
      return await call(control);
    });
  }

  private isCurrentOrUnscoped(generation: number | undefined): boolean {
    return generation === undefined || this.isCurrentGeneration(generation);
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.running && this.generation === generation;
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

function isPromise<T>(value: Promise<T> | null): value is Promise<T> {
  return value !== null;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
