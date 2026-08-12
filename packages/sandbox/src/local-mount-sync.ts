import path from 'node:path/posix';
import type {
  FileWatchEventType,
  FileWatchSSEEvent,
  Logger
} from '@repo/shared';
import type { SandboxClient } from './clients';
import type { ContainerControlClient } from './container-control';
import {
  abortableByteStream,
  areByteStreamsEqual,
  byteChunks,
  streamFile,
  uploadByteStream
} from './file-stream';
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

class TransferInvalidatedError extends Error {}

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
  private echoSuppressTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private watchReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchAbortController: AbortController | null = null;
  private watchTask: Promise<void> | null = null;
  private uploadTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private transferQueue: Promise<void> = Promise.resolve();
  private transferAbortController = new AbortController();
  private running = false;
  private lifecycleEpoch = 0;
  private consecutivePollFailures = 0;
  private consecutiveWatchFailures = 0;

  constructor(options: LocalMountSyncOptions) {
    this.bucket = options.bucket;
    this.mountPath = options.mountPath;
    if (options.prefix !== undefined) {
      validatePrefix(options.prefix);
    }
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

  async start(): Promise<void> {
    const lifecycleEpoch = ++this.lifecycleEpoch;
    this.transferAbortController = new AbortController();
    this.running = true;

    await this.enqueueTransfer(async () => {
      this.assertCurrentEpoch(lifecycleEpoch);
      await this.client.files.mkdir(this.mountPath, this.sessionId, {
        recursive: true
      });
      this.assertCurrentEpoch(lifecycleEpoch);
      await this.fullSyncR2ToContainer(lifecycleEpoch);
    });
    this.assertCurrentEpoch(lifecycleEpoch);
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
    this.running = false;
    this.lifecycleEpoch++;
    this.transferAbortController.abort(new TransferInvalidatedError());

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
    const watchTask = this.watchTask;

    // Uploads still waiting on their debounce are dropped: the watch stream is
    // gone, so nothing tells us whether those files finished being written.
    const droppedUploads = this.uploadTimers.size;
    for (const timer of this.uploadTimers.values()) {
      clearTimeout(timer);
    }
    this.uploadTimers.clear();

    for (const timer of this.echoSuppressTimers.values()) {
      clearTimeout(timer);
    }
    this.echoSuppressTimers.clear();

    await Promise.all([
      this.transferQueue.catch(() => {}),
      watchTask?.catch(() => {})
    ]);
    this.snapshot.clear();
    this.echoSuppressSet.clear();

    this.logger.info('Local mount sync stopped', {
      mountPath: this.mountPath,
      droppedUploads
    });
  }

  private async fullSyncR2ToContainer(lifecycleEpoch: number): Promise<void> {
    const objects = await this.listAllR2Objects(lifecycleEpoch);
    const newSnapshot = new Map<string, R2ObjectSnapshot>();

    for (const obj of objects) {
      this.assertCurrentEpoch(lifecycleEpoch);
      const containerPath = this.r2KeyToContainerPath(obj.key);
      await this.ensureParentDir(containerPath);
      this.assertCurrentEpoch(lifecycleEpoch);
      const transferred = await this.transferR2ObjectToContainer(
        obj.key,
        containerPath,
        lifecycleEpoch
      );
      if (transferred) {
        newSnapshot.set(obj.key, { etag: obj.etag, size: obj.size });
      }
    }

    this.assertCurrentEpoch(lifecycleEpoch);
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
      const lifecycleEpoch = this.lifecycleEpoch;
      try {
        await this.enqueueTransfer(async () => {
          if (this.isCurrentEpoch(lifecycleEpoch)) {
            await this.pollR2ForChanges(lifecycleEpoch);
          }
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

  private async pollR2ForChanges(lifecycleEpoch: number): Promise<void> {
    const objects = await this.listAllR2Objects(lifecycleEpoch);
    const newSnapshot = new Map<string, R2ObjectSnapshot>();

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
        this.assertCurrentEpoch(lifecycleEpoch);
        const containerPath = this.r2KeyToContainerPath(key);
        await this.ensureParentDir(containerPath);
        this.assertCurrentEpoch(lifecycleEpoch);
        const transferred = await this.withEchoSuppression(containerPath, () =>
          this.transferR2ObjectToContainer(key, containerPath, lifecycleEpoch)
        );
        if (!transferred) {
          newSnapshot.delete(key);
          continue;
        }
        this.logger.debug('R2 -> Container: synced object', {
          key,
          action
        });
      } catch (error) {
        if (error instanceof TransferInvalidatedError) throw error;
        const previous = this.snapshot.get(key);
        if (previous) newSnapshot.set(key, previous);
        else newSnapshot.delete(key);
        this.logger.error(
          `R2 -> Container: failed to sync object ${key}`,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }

    for (const [key] of this.snapshot) {
      this.assertCurrentEpoch(lifecycleEpoch);
      if (!newSnapshot.has(key)) {
        const containerPath = this.r2KeyToContainerPath(key);

        try {
          await this.withEchoSuppression(containerPath, async () => {
            await this.client.files.deleteFile(containerPath, this.sessionId);
            this.assertCurrentEpoch(lifecycleEpoch);
          });
          this.logger.debug('R2 -> Container: deleted file', { key });
        } catch (error) {
          if (error instanceof TransferInvalidatedError) throw error;
          const previous = this.snapshot.get(key);
          if (previous) newSnapshot.set(key, previous);
          this.logger.error(
            'R2 -> Container: failed to delete',
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
    }

    this.assertCurrentEpoch(lifecycleEpoch);
    this.snapshot = newSnapshot;
  }

  private async listAllR2Objects(
    lifecycleEpoch: number
  ): Promise<Array<{ key: string; etag: string; size: number }>> {
    const results: Array<{ key: string; etag: string; size: number }> = [];
    let cursor: string | undefined;

    do {
      const listResult = await this.bucket.list({
        ...(this.prefix && { prefix: this.prefix }),
        ...(cursor && { cursor })
      });
      this.assertCurrentEpoch(lifecycleEpoch);

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
    lifecycleEpoch: number
  ): Promise<boolean> {
    this.assertCurrentEpoch(lifecycleEpoch);
    const obj = await this.bucket.get(key);
    this.assertCurrentEpoch(lifecycleEpoch);
    if (!obj) return false;

    if (
      obj.size > STREAM_TO_CONTAINER_THRESHOLD_BYTES &&
      this.client.getTransportMode() === 'rpc'
    ) {
      await this.client.files.writeFileStream(
        containerPath,
        abortableByteStream(obj.body, this.transferAbortController.signal),
        this.sessionId
      );
      this.assertCurrentEpoch(lifecycleEpoch);
      return true;
    }

    const arrayBuffer = await obj.arrayBuffer();
    this.assertCurrentEpoch(lifecycleEpoch);
    const base64 = uint8ArrayToBase64(new Uint8Array(arrayBuffer));

    await this.client.files.writeFile(containerPath, base64, this.sessionId, {
      encoding: 'base64'
    });
    this.assertCurrentEpoch(lifecycleEpoch);
    return true;
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
    const controller = this.watchAbortController;
    const lifecycleEpoch = this.lifecycleEpoch;
    if (!this.running || !controller) return;

    const task = this.runContainerWatchLoop(controller, lifecycleEpoch)
      .then(() => {
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
    this.watchTask = task;
    void task.then(() => {
      if (this.watchTask === task) this.watchTask = null;
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

  private async runContainerWatchLoop(
    controller: AbortController,
    lifecycleEpoch: number
  ): Promise<void> {
    const stream = await this.client.watch.watch({
      path: this.mountPath,
      recursive: true,
      sessionId: this.sessionId
    });
    if (!this.isCurrentEpoch(lifecycleEpoch) || controller.signal.aborted) {
      await stream.cancel().catch(() => {});
      return;
    }

    for await (const event of parseSSEStream<FileWatchSSEEvent>(
      stream,
      controller.signal
    )) {
      if (!this.isCurrentEpoch(lifecycleEpoch)) break;

      this.consecutiveWatchFailures = 0;

      if (event.type !== 'event') continue;
      if (event.isDirectory) continue;

      const containerPath = event.path;
      const atomicWriteTarget = containerPath.replace(
        ATOMIC_WRITE_TEMP_PATH,
        ''
      );
      if (
        atomicWriteTarget !== containerPath &&
        this.echoSuppressSet.has(atomicWriteTarget)
      ) {
        continue;
      }

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
              event.eventType,
              lifecycleEpoch
            );
            break;
          }

          case 'delete':
          case 'move_from': {
            this.cancelScheduledUpload(containerPath);
            await this.enqueueTransfer(async () => {
              if (!this.isCurrentEpoch(lifecycleEpoch)) return;
              const expectedSnapshot = this.snapshot.get(r2Key) ?? null;
              const file = await this.client.files.exists(
                containerPath,
                this.sessionId
              );
              if (file.exists || expectedSnapshot === null) return;
              if (!this.isCurrentEpoch(lifecycleEpoch)) return;
              await this.bucket.delete(r2Key);
              if (this.isCurrentEpoch(lifecycleEpoch)) {
                this.snapshot.delete(r2Key);
              }
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

  // Only the last event of a write burst remains scheduled.
  private scheduleUpload(
    containerPath: string,
    r2Key: string,
    action: FileWatchEventType,
    lifecycleEpoch: number
  ): void {
    this.cancelScheduledUpload(containerPath);

    const timer = setTimeout(() => {
      this.uploadTimers.delete(containerPath);
      this.enqueueTransfer(async () => {
        if (!this.isCurrentEpoch(lifecycleEpoch)) return;
        const expectedSnapshot = this.snapshot.get(r2Key) ?? null;
        if (!(await this.matchesR2Snapshot(r2Key, expectedSnapshot))) return;
        if (
          await this.containerMatchesR2(containerPath, r2Key, lifecycleEpoch)
        ) {
          return;
        }
        if (!(await this.matchesR2Snapshot(r2Key, expectedSnapshot))) return;
        if (!this.isCurrentEpoch(lifecycleEpoch)) return;
        await this.uploadFileToR2(
          containerPath,
          r2Key,
          lifecycleEpoch,
          expectedSnapshot
        );
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

  private async readContainerFileChunks(
    containerPath: string,
    lifecycleEpoch: number
  ): Promise<AsyncIterable<string | Uint8Array>> {
    if (this.client.getTransportMode() === 'rpc') {
      const file = await this.client.files.readFile(
        containerPath,
        this.sessionId,
        { encoding: 'none' }
      );
      if (!this.isCurrentEpoch(lifecycleEpoch)) {
        await file.content.cancel().catch(() => {});
        throw new TransferInvalidatedError();
      }
      return readByteStream(
        abortableByteStream(file.content, this.transferAbortController.signal)
      );
    }
    const stream = await this.client.files.readFileStream(
      containerPath,
      this.sessionId,
      { encoding: 'base64' }
    );
    if (!this.isCurrentEpoch(lifecycleEpoch)) {
      await stream.cancel().catch(() => {});
      throw new TransferInvalidatedError();
    }
    return streamFile(
      abortableByteStream(stream, this.transferAbortController.signal)
    );
  }

  private async containerMatchesR2(
    containerPath: string,
    r2Key: string,
    lifecycleEpoch: number
  ): Promise<boolean> {
    const object = await this.bucket.get(r2Key);
    if (!object) return false;
    const remote = abortableByteStream(
      object.body,
      this.transferAbortController.signal
    );
    try {
      this.assertCurrentEpoch(lifecycleEpoch);
      const local = await this.readContainerFileChunks(
        containerPath,
        lifecycleEpoch
      );
      return await areByteStreamsEqual(
        byteChunks(local),
        readByteStream(remote),
        () => this.isCurrentEpoch(lifecycleEpoch)
      );
    } catch (error) {
      await remote.cancel(error).catch(() => {});
      throw error;
    }
  }

  private async uploadFileToR2(
    containerPath: string,
    r2Key: string,
    lifecycleEpoch: number,
    expectedSnapshot?: R2ObjectSnapshot | null
  ): Promise<void> {
    const assertCurrent = () => this.assertCurrentEpoch(lifecycleEpoch);
    try {
      const chunks = await this.readContainerFileChunks(
        containerPath,
        lifecycleEpoch
      );
      const object = await uploadByteStream({
        bucket: this.bucket,
        key: r2Key,
        chunks,
        partBytes: this.uploadPartBytes,
        expectedETag:
          expectedSnapshot === undefined
            ? undefined
            : (expectedSnapshot?.etag ?? null),
        assertCurrent
      });
      if (object && this.isCurrentEpoch(lifecycleEpoch)) {
        this.snapshot.set(r2Key, { etag: object.etag, size: object.size });
      }
    } catch (error) {
      if (error instanceof TransferInvalidatedError) return;
      throw error;
    }
  }

  private async matchesR2Snapshot(
    r2Key: string,
    expected: R2ObjectSnapshot | null
  ): Promise<boolean> {
    const current = await this.bucket.head(r2Key);
    if (expected === null) return current === null;
    return (
      current !== null &&
      current.etag === expected.etag &&
      current.size === expected.size
    );
  }

  private isCurrentEpoch(lifecycleEpoch: number): boolean {
    return this.running && this.lifecycleEpoch === lifecycleEpoch;
  }

  private assertCurrentEpoch(lifecycleEpoch: number): void {
    if (!this.isCurrentEpoch(lifecycleEpoch)) {
      throw new TransferInvalidatedError();
    }
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
    const previousTimer = this.echoSuppressTimers.get(containerPath);
    if (previousTimer) clearTimeout(previousTimer);
    this.echoSuppressSet.add(containerPath);
    try {
      return await operation();
    } finally {
      if (this.running) {
        const timer = setTimeout(() => {
          if (this.echoSuppressTimers.get(containerPath) !== timer) return;
          this.echoSuppressTimers.delete(containerPath);
          this.echoSuppressSet.delete(containerPath);
        }, this.echoSuppressTtlMs);
        this.echoSuppressTimers.set(containerPath, timer);
      } else {
        this.echoSuppressSet.delete(containerPath);
        this.echoSuppressTimers.delete(containerPath);
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

    const relativePath = path.relative(mount, resolved);
    if (
      !relativePath ||
      relativePath === '..' ||
      relativePath.startsWith('../') ||
      path.isAbsolute(relativePath)
    ) {
      return null;
    }

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
