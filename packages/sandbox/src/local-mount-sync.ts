import path from 'node:path/posix';
import {
  type FileWatchEventType,
  type FileWatchSSEEvent,
  getAtomicWriteTargetPath,
  type Logger
} from '@repo/shared';
import type { ContainerControlClient } from './container-control';
import {
  abortableByteStream,
  readLocalMountBytes,
  uploadLocalMountFile
} from './local-mount-transfer';
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
export const UPLOAD_DEBOUNCE_MS = 1500;
const STREAM_TO_CONTAINER_THRESHOLD_BYTES = 4 * 1024 * 1024;
const DEFAULT_UPLOAD_PART_BYTES = 16 * 1024 * 1024;
const DEFAULT_STOP_TIMEOUT_MS = 5000;

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
  uploadPartBytes?: number;
  stopTimeoutMs?: number;
}

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
  private readonly uploadPartBytes: number;
  private readonly stopTimeoutMs: number;
  private snapshot: Map<string, R2ObjectSnapshot> = new Map();
  private echoSuppressSet: Set<string> = new Set();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private watchReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchAbortController: AbortController | null = null;
  private uploadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pathIntentVersions = new Map<string, number>();
  private nextPathIntentVersion = 0;
  private echoSuppressTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private transferQueue: Promise<void> = Promise.resolve();
  private readonly transferAbortController = new AbortController();
  private running = false;
  private stopping = false;
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
    const normalizedPrefix = options.prefix?.replace(/^\/+|\/+$/g, '');
    this.prefix = normalizedPrefix ? `${normalizedPrefix}/` : undefined;
    this.readOnly = options.readOnly;
    this.runRuntimeCall = options.runRuntimeCall;
    this.runtimeHold = options.runtimeHold ?? { release: () => {} };
    this.logger = options.logger.child({ operation: 'local-mount-sync' });
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.echoSuppressTtlMs =
      options.echoSuppressTtlMs ?? DEFAULT_ECHO_SUPPRESS_TTL_MS;
    this.uploadPartBytes = options.uploadPartBytes ?? DEFAULT_UPLOAD_PART_BYTES;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

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

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearScheduledWork(false);

    const settle = (async () => {
      if (this.uploadTimers.size > 0) {
        await delay(UPLOAD_DEBOUNCE_MS);
      }
      await this.transferQueue;
      await Promise.allSettled(
        [this.activePollCycle, this.activeWatchLoop].filter(isPromise)
      );
    })();
    await waitAtMost(settle, this.stopTimeoutMs);
    this.interrupt();

    this.snapshot.clear();
    this.echoSuppressSet.clear();

    this.logger.info('Local mount sync stopped', {
      mountPath: this.mountPath
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  interrupt(): void {
    this.running = false;
    this.stopping = true;
    this.transferAbortController.abort(new Error('local mount sync stopped'));
    this.clearScheduledWork(true);

    if (!this.runtimeHoldReleased) {
      this.runtimeHoldReleased = true;
      this.runtimeHold.release();
    }
  }

  private clearScheduledWork(dropUploads: boolean): void {
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

    if (dropUploads) {
      for (const timer of this.uploadTimers.values()) clearTimeout(timer);
      this.uploadTimers.clear();
      this.pathIntentVersions.clear();
      for (const timer of this.echoSuppressTimers.values()) clearTimeout(timer);
      this.echoSuppressTimers.clear();
      this.echoSuppressSet.clear();
    }
  }

  private async fullSyncR2ToContainer(generation: number): Promise<void> {
    const objects = await this.listAllR2Objects();
    if (!this.isCurrentGeneration(generation)) return;
    const newSnapshot = new Map<string, R2ObjectSnapshot>();

    // Transfers share one runtime RPC session, so run them serially.
    for (const obj of objects) {
      if (!this.isCurrentGeneration(generation)) return;
      const containerPath = this.r2KeyToContainerPath(obj.key);
      await this.ensureParentDir(containerPath, generation);
      await this.transferR2ObjectToContainer(
        obj.key,
        containerPath,
        generation
      );
      newSnapshot.set(obj.key, { etag: obj.etag, size: obj.size });
    }

    if (!this.isCurrentGeneration(generation)) return;
    this.snapshot = newSnapshot;
    this.logger.debug('Initial R2 -> Container sync complete', {
      objectCount: objects.length
    });
  }

  private schedulePoll(): void {
    if (!this.running || this.stopping) return;

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
      const cycle = this.enqueueTransfer(() =>
        this.pollR2ForChanges(generation)
      )
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
    const newSnapshot = new Map(this.snapshot);
    const listedKeys = new Set(objects.map((object) => object.key));

    const changed: Array<{
      key: string;
      etag: string;
      size: number;
      action: 'created' | 'modified';
    }> = [];
    for (const obj of objects) {
      const existing = this.snapshot.get(obj.key);
      if (!existing || existing.etag !== obj.etag) {
        changed.push({
          key: obj.key,
          etag: obj.etag,
          size: obj.size,
          action: existing ? 'modified' : 'created'
        });
      }
    }

    for (const { key, etag, size, action } of changed) {
      try {
        if (!this.isCurrentGeneration(generation)) return;
        const containerPath = this.r2KeyToContainerPath(key);
        await this.ensureParentDir(containerPath, generation);
        await this.withEchoSuppression(containerPath, () =>
          this.transferR2ObjectToContainer(key, containerPath, generation)
        );
        newSnapshot.set(key, { etag, size });
        this.logger.debug('R2 -> Container: synced object', { key, action });
      } catch (error) {
        this.logger.error(
          `R2 -> Container: failed to sync object ${key}`,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }

    for (const [key] of this.snapshot) {
      if (!listedKeys.has(key)) {
        const containerPath = this.r2KeyToContainerPath(key);

        try {
          if (!this.isCurrentGeneration(generation)) return;
          await this.withEchoSuppression(containerPath, () =>
            this.runRuntimeCallIfCurrent(
              generation,
              'mount.local.deleteFile',
              (control) => control.files.deleteFile(containerPath)
            )
          );
          newSnapshot.delete(key);
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
      const body = abortableByteStream(
        obj.body,
        this.transferAbortController.signal
      );
      try {
        await this.runRuntimeCallIfCurrent(
          generation,
          'mount.local.writeFileStream',
          (control) => control.files.writeFileStream(containerPath, body.stream)
        );
      } catch (error) {
        body.cancel(error);
        throw error;
      }
      return;
    }

    const base64 = uint8ArrayToBase64(
      await readLocalMountBytes(obj.body, this.transferAbortController.signal)
    );
    await this.runRuntimeCallIfCurrent(
      generation,
      'mount.local.writeFile',
      (control) =>
        control.files.writeFile(containerPath, base64, { encoding: 'base64' })
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
    if (!this.running || this.stopping) return;

    const generation = this.generation;
    const loop = this.runContainerWatchLoop(generation)
      .then(() => {
        if (!this.isCurrentGeneration(generation) || this.stopping) return;
        // Stream ended cleanly (e.g. server closed it). Reconnect unless stopped.
        this.consecutiveWatchFailures = 0;
        this.scheduleWatchReconnect();
      })
      .catch((error) => {
        if (!this.isCurrentGeneration(generation) || this.stopping) return;
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
    if (!this.running || this.stopping) return;

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
          if (!this.isCurrentGeneration(generation) || this.stopping) break;

          // Successful event received — reset failure counter
          this.consecutiveWatchFailures = 0;

          if (event.type !== 'event') continue;
          if (event.isDirectory) continue;

          const containerPath = event.path;
          const atomicWriteTarget = getAtomicWriteTargetPath(containerPath);
          if (
            atomicWriteTarget &&
            this.echoSuppressSet.has(atomicWriteTarget)
          ) {
            continue;
          }

          // Skip echo from our own R2 -> Container writes
          if (this.echoSuppressSet.has(containerPath)) continue;

          const r2Key = this.containerPathToR2Key(containerPath);
          if (!r2Key) continue;

          try {
            switch (event.eventType) {
              case 'create':
              case 'modify':
              case 'move_to': {
                this.scheduleUpload(
                  containerPath,
                  r2Key,
                  generation,
                  event.eventType
                );
                break;
              }

              case 'delete':
              case 'move_from': {
                const intentVersion = this.replacePathIntent(containerPath);
                await this.deleteObjectFromR2(
                  containerPath,
                  r2Key,
                  generation,
                  intentVersion
                );
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
    );
  }

  private scheduleUpload(
    containerPath: string,
    r2Key: string,
    generation: number,
    action: FileWatchEventType
  ): void {
    const intentVersion = this.replacePathIntent(containerPath);
    this.scheduleUploadAttempt(
      containerPath,
      r2Key,
      generation,
      action,
      intentVersion
    );
  }

  private scheduleUploadAttempt(
    containerPath: string,
    r2Key: string,
    generation: number,
    action: FileWatchEventType,
    intentVersion: number
  ): void {
    const isCurrent = () =>
      this.isCurrentPathIntent(containerPath, intentVersion, generation);
    this.cancelScheduledUpload(containerPath);
    this.uploadTimers.set(
      containerPath,
      setTimeout(() => {
        this.uploadTimers.delete(containerPath);
        void this.enqueueTransfer(async () => {
          if (!isCurrent()) return;
          await this.uploadFileToR2(containerPath, r2Key, generation);
          if (!isCurrent()) return;
          this.pathIntentVersions.delete(containerPath);
          this.logger.debug('Container -> R2: synced file', {
            path: containerPath,
            key: r2Key,
            action
          });
        }).catch((error) => {
          if (!isCurrent()) return;
          this.logger.error(
            `Container -> R2 sync failed for ${containerPath}`,
            error instanceof Error ? error : new Error(String(error))
          );
          this.scheduleUploadAttempt(
            containerPath,
            r2Key,
            generation,
            action,
            intentVersion
          );
        });
      }, UPLOAD_DEBOUNCE_MS)
    );
  }

  private async deleteObjectFromR2(
    containerPath: string,
    r2Key: string,
    generation: number,
    intentVersion: number
  ): Promise<void> {
    const isCurrent = () =>
      this.isCurrentPathIntent(containerPath, intentVersion, generation);
    try {
      await this.enqueueTransfer(async () => {
        if (!isCurrent()) return;
        await this.bucket.delete(r2Key);
        if (!isCurrent()) return;
        this.snapshot.delete(r2Key);
        this.pathIntentVersions.delete(containerPath);
        this.logger.debug('Container -> R2: deleted object', {
          path: containerPath,
          key: r2Key
        });
      });
    } catch (error) {
      if (!isCurrent()) return;
      this.logger.error(
        `Container -> R2 sync failed for ${containerPath}`,
        error instanceof Error ? error : new Error(String(error))
      );
      this.cancelScheduledUpload(containerPath);
      this.uploadTimers.set(
        containerPath,
        setTimeout(() => {
          this.uploadTimers.delete(containerPath);
          void this.deleteObjectFromR2(
            containerPath,
            r2Key,
            generation,
            intentVersion
          );
        }, UPLOAD_DEBOUNCE_MS)
      );
    }
  }

  private replacePathIntent(containerPath: string): number {
    this.cancelScheduledUpload(containerPath);
    this.nextPathIntentVersion += 1;
    this.pathIntentVersions.set(containerPath, this.nextPathIntentVersion);
    return this.nextPathIntentVersion;
  }

  private isCurrentPathIntent(
    containerPath: string,
    intentVersion: number,
    generation: number
  ): boolean {
    return (
      this.isCurrentGeneration(generation) &&
      this.pathIntentVersions.get(containerPath) === intentVersion
    );
  }

  private cancelScheduledUpload(containerPath: string): void {
    const timer = this.uploadTimers.get(containerPath);
    if (timer) clearTimeout(timer);
    this.uploadTimers.delete(containerPath);
  }

  private async uploadFileToR2(
    containerPath: string,
    r2Key: string,
    generation: number
  ): Promise<void> {
    const file = await this.runRuntimeCallIfCurrent(
      generation,
      'mount.local.readFile',
      (control) => control.files.readFile(containerPath, { encoding: 'none' })
    );
    await uploadLocalMountFile({
      bucket: this.bucket,
      key: r2Key,
      file,
      partBytes: this.uploadPartBytes,
      signal: this.transferAbortController.signal
    });

    if (!this.isCurrentGeneration(generation)) return;
    const head = await this.bucket.head(r2Key);
    if (head) this.snapshot.set(r2Key, { etag: head.etag, size: head.size });
  }

  private enqueueTransfer(operation: () => Promise<void>): Promise<void> {
    const task = this.transferQueue.then(operation);
    this.transferQueue = task.catch(() => {});
    return task;
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

  private isCurrentGeneration(generation: number): boolean {
    return this.running && this.generation === generation;
  }

  private async withEchoSuppression<T>(
    containerPath: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const existingTimer = this.echoSuppressTimers.get(containerPath);
    if (existingTimer) clearTimeout(existingTimer);
    this.echoSuppressTimers.delete(containerPath);
    this.echoSuppressSet.add(containerPath);
    try {
      return await operation();
    } finally {
      if (!this.running) {
        this.echoSuppressSet.delete(containerPath);
      } else {
        const timer = setTimeout(() => {
          if (this.echoSuppressTimers.get(containerPath) !== timer) return;
          this.echoSuppressTimers.delete(containerPath);
          this.echoSuppressSet.delete(containerPath);
        }, this.echoSuppressTtlMs);
        this.echoSuppressTimers.set(containerPath, timer);
      }
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

async function waitAtMost(promise: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isPromise<T>(value: Promise<T> | null): value is Promise<T> {
  return value !== null;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
