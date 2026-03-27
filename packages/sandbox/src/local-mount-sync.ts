import path from 'node:path/posix';
import type { FileWatchSSEEvent, Logger } from '@repo/shared';
import type { SandboxClient } from './clients';
import { parseSSEStream } from './sse-parser';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_ECHO_SUPPRESS_TTL_MS = 2000;
const MAX_BACKOFF_MS = 30_000;
const SYNC_CONCURRENCY = 5;

interface R2ObjectSnapshot {
  etag: string;
  size: number;
}

interface LocalMountSyncOptions {
  bucket: R2Bucket;
  mountPath: string;
  prefix: string | undefined;
  readOnly: boolean;
  client: SandboxClient;
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
  private readonly client: SandboxClient;
  private readonly sessionId: string;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;

  private readonly echoSuppressTtlMs: number;

  private snapshot: Map<string, R2ObjectSnapshot> = new Map();
  private echoSuppressSet: Set<string> = new Set();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private watchReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchAbortController: AbortController | null = null;
  private running = false;
  private consecutivePollFailures = 0;
  private consecutiveWatchFailures = 0;

  constructor(options: LocalMountSyncOptions) {
    this.bucket = options.bucket;
    this.mountPath = options.mountPath;
    this.prefix = options.prefix;
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

    this.snapshot.clear();
    this.echoSuppressSet.clear();

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

      // Skip echo from our own R2 -> Container writes
      if (this.echoSuppressSet.has(containerPath)) continue;

      const r2Key = this.containerPathToR2Key(containerPath);
      if (!r2Key) continue;

      try {
        switch (event.eventType) {
          case 'create':
          case 'modify':
          case 'move_to': {
            await this.uploadFileToR2(containerPath, r2Key);
            this.logger.debug('Container -> R2: synced file', {
              path: containerPath,
              key: r2Key,
              action: event.eventType
            });
            break;
          }

          case 'delete':
          case 'move_from': {
            await this.bucket.delete(r2Key);
            this.snapshot.delete(r2Key);
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
   * Read a container file and upload it to R2, then update the local
   * snapshot so the next poll cycle doesn't echo the write back.
   */
  private async uploadFileToR2(
    containerPath: string,
    r2Key: string
  ): Promise<void> {
    const result = await this.client.files.readFile(
      containerPath,
      this.sessionId,
      { encoding: 'base64' }
    );
    const bytes = base64ToUint8Array(result.content);
    await this.bucket.put(r2Key, bytes);

    const head = await this.bucket.head(r2Key);
    if (head) {
      this.snapshot.set(r2Key, { etag: head.etag, size: head.size });
    }
  }

  private suppressEcho(containerPath: string): void {
    this.echoSuppressSet.add(containerPath);
    setTimeout(() => {
      this.echoSuppressSet.delete(containerPath);
    }, this.echoSuppressTtlMs);
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

function base64ToUint8Array(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}
