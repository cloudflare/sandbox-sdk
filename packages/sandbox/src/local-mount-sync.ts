import type { FileWatchSSEEvent, Logger } from '@repo/shared';
import type { SandboxClient } from './clients';
import { parseSSEStream } from './sse-parser';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const ECHO_SUPPRESS_TTL_MS = 200;

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
}

/**
 * Manages bidirectional sync between an R2 binding and a container directory.
 *
 * R2→Container: polls bucket.list() to detect changes, then transfers diffs.
 * Container→R2: uses inotifywait via the watch API to detect file changes.
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

  private snapshot: Map<string, R2ObjectSnapshot> = new Map();
  private echoSuppressSet: Set<string> = new Set();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private watchAbortController: AbortController | null = null;
  private running = false;

  constructor(options: LocalMountSyncOptions) {
    this.bucket = options.bucket;
    this.mountPath = options.mountPath;
    this.prefix = options.prefix;
    this.readOnly = options.readOnly;
    this.client = options.client;
    this.sessionId = options.sessionId;
    this.logger = options.logger.child({ operation: 'local-mount-sync' });
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * Start bidirectional sync. Performs initial full sync, then starts
   * the R2 poll loop and (if not readOnly) the container watch loop.
   */
  async start(): Promise<void> {
    this.running = true;

    // Create mount directory
    await this.client.files.mkdir(this.mountPath, this.sessionId, {
      recursive: true
    });

    // Initial full sync from R2 → Container
    await this.fullSyncR2ToContainer();

    // Start periodic R2 poll
    this.schedulePoll();

    // Start container → R2 watch (unless read-only)
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

  // --------------------------------------------------------------------------
  // R2 → Container (poll-based)
  // --------------------------------------------------------------------------

  private async fullSyncR2ToContainer(): Promise<void> {
    const objects = await this.listAllR2Objects();
    const newSnapshot = new Map<string, R2ObjectSnapshot>();

    for (const obj of objects) {
      const containerPath = this.r2KeyToContainerPath(obj.key);
      newSnapshot.set(obj.key, { etag: obj.etag, size: obj.size });

      // Ensure parent directories exist
      const parentDir = containerPath.substring(
        0,
        containerPath.lastIndexOf('/')
      );
      if (parentDir && parentDir !== this.mountPath) {
        await this.client.files.mkdir(parentDir, this.sessionId, {
          recursive: true
        });
      }

      // Transfer file content
      await this.transferR2ObjectToContainer(obj.key, containerPath);
    }

    this.snapshot = newSnapshot;
    this.logger.debug('Initial R2→Container sync complete', {
      objectCount: objects.length
    });
  }

  private schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollR2ForChanges();
      } catch (error) {
        this.logger.error(
          'R2 poll cycle failed',
          error instanceof Error ? error : new Error(String(error))
        );
      }
      this.schedulePoll();
    }, this.pollIntervalMs);
  }

  private async pollR2ForChanges(): Promise<void> {
    const objects = await this.listAllR2Objects();
    const newSnapshot = new Map<string, R2ObjectSnapshot>();

    // Detect new or modified objects
    for (const obj of objects) {
      newSnapshot.set(obj.key, { etag: obj.etag, size: obj.size });

      const existing = this.snapshot.get(obj.key);
      if (!existing || existing.etag !== obj.etag) {
        const containerPath = this.r2KeyToContainerPath(obj.key);

        // Ensure parent directories exist
        const parentDir = containerPath.substring(
          0,
          containerPath.lastIndexOf('/')
        );
        if (parentDir && parentDir !== this.mountPath) {
          await this.client.files.mkdir(parentDir, this.sessionId, {
            recursive: true
          });
        }

        this.suppressEcho(containerPath);
        await this.transferR2ObjectToContainer(obj.key, containerPath);

        this.logger.debug('R2→Container: synced object', {
          key: obj.key,
          action: existing ? 'modified' : 'created'
        });
      }
    }

    // Detect deleted objects
    for (const [key] of this.snapshot) {
      if (!newSnapshot.has(key)) {
        const containerPath = this.r2KeyToContainerPath(key);
        this.suppressEcho(containerPath);

        try {
          await this.client.files.deleteFile(containerPath, this.sessionId);
          this.logger.debug('R2→Container: deleted file', { key });
        } catch {
          // File may already be gone
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

    // Read as base64 to handle binary files correctly
    const arrayBuffer = await obj.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const base64 = btoa(String.fromCharCode(...bytes));

    await this.client.files.writeFile(containerPath, base64, this.sessionId, {
      encoding: 'base64'
    });
  }

  // --------------------------------------------------------------------------
  // Container → R2 (watch-based)
  // --------------------------------------------------------------------------

  private startContainerWatch(): void {
    this.watchAbortController = new AbortController();

    // Fire and forget — runs in background
    this.runContainerWatchLoop().catch((error) => {
      if (this.running) {
        this.logger.error(
          'Container watch loop failed',
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });
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

      if (event.type !== 'event') continue;
      if (event.isDirectory) continue;

      const containerPath = event.path;

      // Skip echo from our own R2→Container writes
      if (this.echoSuppressSet.has(containerPath)) continue;

      const r2Key = this.containerPathToR2Key(containerPath);
      if (!r2Key) continue;

      try {
        switch (event.eventType) {
          case 'create':
          case 'modify': {
            const result = await this.client.files.readFile(
              containerPath,
              this.sessionId,
              { encoding: 'base64' }
            );
            const bytes = Uint8Array.from(atob(result.content), (c) =>
              c.charCodeAt(0)
            );
            await this.bucket.put(r2Key, bytes);

            // Update snapshot so the next poll cycle doesn't echo this back
            const head = await this.bucket.head(r2Key);
            if (head) {
              this.snapshot.set(r2Key, { etag: head.etag, size: head.size });
            }

            this.logger.debug('Container→R2: synced file', {
              path: containerPath,
              key: r2Key,
              action: event.eventType
            });
            break;
          }

          case 'delete': {
            await this.bucket.delete(r2Key);
            this.snapshot.delete(r2Key);

            this.logger.debug('Container→R2: deleted object', {
              path: containerPath,
              key: r2Key
            });
            break;
          }

          case 'move_from': {
            // Treat as delete (move_to will handle the create side)
            await this.bucket.delete(r2Key);
            this.snapshot.delete(r2Key);
            break;
          }

          case 'move_to': {
            // Treat as create
            const moveResult = await this.client.files.readFile(
              containerPath,
              this.sessionId,
              { encoding: 'base64' }
            );
            const moveBytes = Uint8Array.from(atob(moveResult.content), (c) =>
              c.charCodeAt(0)
            );
            await this.bucket.put(r2Key, moveBytes);

            const moveHead = await this.bucket.head(r2Key);
            if (moveHead) {
              this.snapshot.set(r2Key, {
                etag: moveHead.etag,
                size: moveHead.size
              });
            }
            break;
          }
        }
      } catch (error) {
        this.logger.error(
          `Container→R2 sync failed for ${containerPath}`,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  }

  // --------------------------------------------------------------------------
  // Echo suppression
  // --------------------------------------------------------------------------

  private suppressEcho(containerPath: string): void {
    this.echoSuppressSet.add(containerPath);
    setTimeout(() => {
      this.echoSuppressSet.delete(containerPath);
    }, ECHO_SUPPRESS_TTL_MS);
  }

  // --------------------------------------------------------------------------
  // Path mapping
  // --------------------------------------------------------------------------

  private r2KeyToContainerPath(key: string): string {
    let relativePath = key;
    if (this.prefix) {
      relativePath = key.startsWith(this.prefix)
        ? key.slice(this.prefix.length)
        : key;
    }
    // Strip leading slash from relative path
    if (relativePath.startsWith('/')) {
      relativePath = relativePath.slice(1);
    }
    return `${this.mountPath}/${relativePath}`;
  }

  private containerPathToR2Key(containerPath: string): string | null {
    if (!containerPath.startsWith(this.mountPath)) return null;

    let relativePath = containerPath.slice(this.mountPath.length);
    // Strip leading slash
    if (relativePath.startsWith('/')) {
      relativePath = relativePath.slice(1);
    }
    if (!relativePath) return null;

    return this.prefix ? `${this.prefix}${relativePath}` : relativePath;
  }
}
