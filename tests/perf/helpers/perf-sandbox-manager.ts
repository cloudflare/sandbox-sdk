/**
 * Manages sandbox instances for performance testing
 * Unlike E2E tests, perf tests create many sandboxes to measure creation overhead
 */

import { randomUUID } from 'node:crypto';
import {
  createPythonImageHeaders,
  createTestHeaders
} from '../../e2e/helpers/test-fixtures';

export interface PerfSandboxConfig {
  workerUrl: string;
  sandboxType?: 'default' | 'python' | 'opencode' | 'standalone';
}

export interface SandboxInstance {
  id: string;
  headers: Record<string, string>;
  createdAt: number;
}

export interface CommandResult {
  success: boolean;
  duration: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FileResult {
  success: boolean;
  duration: number;
  content?: string;
  error?: string;
}

export interface BucketMountResult {
  success: boolean;
  duration: number;
  error?: string;
}

export interface BucketObjectResult {
  success: boolean;
  duration: number;
  content?: string;
  size?: number;
  error?: string;
}

export interface BackupResult {
  success: boolean;
  duration: number;
  id?: string;
  error?: string;
}

export interface RestoreResult {
  success: boolean;
  duration: number;
  error?: string;
}

export class PerfSandboxManager {
  private workerUrl: string;
  private sandboxType: string;
  private sandboxes: Map<string, SandboxInstance> = new Map();

  constructor(config: PerfSandboxConfig) {
    this.workerUrl = config.workerUrl;
    this.sandboxType = config.sandboxType || 'default';
  }

  /**
   * Create a new sandbox and optionally initialize it
   */
  async createSandbox(options?: {
    initialize?: boolean;
  }): Promise<SandboxInstance> {
    const id = `perf-${randomUUID()}`;
    let headers: Record<string, string>;

    if (this.sandboxType === 'python') {
      headers = createPythonImageHeaders(id);
    } else {
      headers = createTestHeaders(id);
      if (this.sandboxType !== 'default') {
        headers['X-Sandbox-Type'] = this.sandboxType;
      }
    }

    const sandbox: SandboxInstance = {
      id,
      headers,
      createdAt: Date.now()
    };

    if (options?.initialize) {
      // Execute a command to force container creation (cold start)
      await this.executeCommand(sandbox, 'echo "initialized"');
    }

    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  /**
   * Execute a command in a sandbox
   */
  async executeCommand(
    sandbox: SandboxInstance,
    command: string,
    options?: { timeout?: number; cwd?: string }
  ): Promise<CommandResult> {
    const start = performance.now();

    try {
      const response = await fetch(`${this.workerUrl}/api/execute`, {
        method: 'POST',
        headers: sandbox.headers,
        body: JSON.stringify({
          command,
          timeout: options?.timeout,
          cwd: options?.cwd
        })
      });

      const duration = performance.now() - start;

      if (!response.ok) {
        return {
          success: false,
          duration,
          exitCode: -1,
          stdout: '',
          stderr: `HTTP ${response.status}`
        };
      }

      const result = (await response.json()) as {
        success: boolean;
        exitCode: number;
        stdout: string;
        stderr: string;
        duration: number;
      };

      return {
        success: result.success,
        duration, // Use our measured duration, not the server's
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr
      };
    } catch (error) {
      return {
        success: false,
        duration: performance.now() - start,
        exitCode: -1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Write content to a file in a sandbox
   */
  async writeFile(
    sandbox: SandboxInstance,
    path: string,
    content: string
  ): Promise<FileResult> {
    const start = performance.now();
    try {
      const response = await fetch(`${this.workerUrl}/api/file/write`, {
        method: 'POST',
        headers: sandbox.headers,
        body: JSON.stringify({ path, content })
      });
      const duration = performance.now() - start;
      if (!response.ok) {
        return { success: false, duration, error: `HTTP ${response.status}` };
      }
      return { success: true, duration };
    } catch (error) {
      return {
        success: false,
        duration: performance.now() - start,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Read content from a file in a sandbox
   */
  async readFile(sandbox: SandboxInstance, path: string): Promise<FileResult> {
    const start = performance.now();
    try {
      const response = await fetch(`${this.workerUrl}/api/file/read`, {
        method: 'POST',
        headers: sandbox.headers,
        body: JSON.stringify({ path })
      });
      const duration = performance.now() - start;
      if (!response.ok) {
        return { success: false, duration, error: `HTTP ${response.status}` };
      }
      const result = (await response.json()) as { content?: string };
      return { success: true, duration, content: result.content };
    } catch (error) {
      return {
        success: false,
        duration: performance.now() - start,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Cleanup a specific sandbox
   */
  async destroySandbox(sandbox: SandboxInstance): Promise<void> {
    try {
      await fetch(`${this.workerUrl}/cleanup`, {
        method: 'POST',
        headers: sandbox.headers
      });
    } catch (error) {
      // Log cleanup failures - could indicate system degradation during perf tests
      console.debug(
        `[PerfCleanup] Failed to cleanup sandbox ${sandbox.id}:`,
        error
      );
    }
    this.sandboxes.delete(sandbox.id);
  }

  /**
   * Cleanup all sandboxes created by this manager
   */
  async destroyAll(): Promise<void> {
    const cleanups = Array.from(this.sandboxes.values()).map((s) =>
      this.destroySandbox(s)
    );
    await Promise.allSettled(cleanups);
    this.sandboxes.clear();
  }

  /**
   * Get count of active sandboxes
   */
  getActiveCount(): number {
    return this.sandboxes.size;
  }

  /**
   * Get all active sandboxes
   */
  getActiveSandboxes(): SandboxInstance[] {
    return Array.from(this.sandboxes.values());
  }

  /**
   * Get worker URL
   */
  getWorkerUrl(): string {
    return this.workerUrl;
  }

  /**
   * Mount an R2 bucket in a sandbox
   */
  async mountBucket(
    sandbox: SandboxInstance,
    bucket: string,
    mountPath: string,
    options?: { endpoint?: string }
  ): Promise<BucketMountResult> {
    const start = performance.now();
    try {
      const response = await fetch(`${this.workerUrl}/api/bucket/mount`, {
        method: 'POST',
        headers: sandbox.headers,
        body: JSON.stringify({ bucket, mountPath, options })
      });
      const duration = performance.now() - start;
      if (!response.ok) {
        const text = await response.text();
        return {
          success: false,
          duration,
          error: `HTTP ${response.status}: ${text}`
        };
      }
      return { success: true, duration };
    } catch (error) {
      return {
        success: false,
        duration: performance.now() - start,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Unmount a bucket from a sandbox
   */
  async unmountBucket(
    sandbox: SandboxInstance,
    mountPath: string
  ): Promise<BucketMountResult> {
    const start = performance.now();
    try {
      const response = await fetch(`${this.workerUrl}/api/bucket/unmount`, {
        method: 'POST',
        headers: sandbox.headers,
        body: JSON.stringify({ mountPath })
      });
      const duration = performance.now() - start;
      if (!response.ok) {
        return { success: false, duration, error: `HTTP ${response.status}` };
      }
      return { success: true, duration };
    } catch (error) {
      return {
        success: false,
        duration: performance.now() - start,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Put an object into R2 via the test worker binding
   */
  async putBucketObject(
    sandbox: SandboxInstance,
    key: string,
    content: string
  ): Promise<BucketObjectResult> {
    const start = performance.now();
    try {
      const response = await fetch(`${this.workerUrl}/api/bucket/put`, {
        method: 'POST',
        headers: sandbox.headers,
        body: JSON.stringify({ key, content, contentType: 'text/plain' })
      });
      const duration = performance.now() - start;
      if (!response.ok) {
        return { success: false, duration, error: `HTTP ${response.status}` };
      }
      return { success: true, duration };
    } catch (error) {
      return {
        success: false,
        duration: performance.now() - start,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Get an object from R2 via the test worker binding
   */
  async getBucketObject(
    sandbox: SandboxInstance,
    key: string
  ): Promise<BucketObjectResult> {
    const start = performance.now();
    try {
      const response = await fetch(
        `${this.workerUrl}/api/bucket/get?key=${encodeURIComponent(key)}`,
        { method: 'GET', headers: sandbox.headers }
      );
      const duration = performance.now() - start;
      if (!response.ok) {
        return { success: false, duration, error: `HTTP ${response.status}` };
      }
      const result = (await response.json()) as {
        content?: string;
        size?: number;
      };
      return {
        success: true,
        duration,
        content: result.content,
        size: result.size
      };
    } catch (error) {
      return {
        success: false,
        duration: performance.now() - start,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Delete an object from R2 via the test worker binding
   */
  async deleteBucketObject(
    sandbox: SandboxInstance,
    key: string
  ): Promise<void> {
    try {
      await fetch(`${this.workerUrl}/api/bucket/delete`, {
        method: 'POST',
        headers: sandbox.headers,
        body: JSON.stringify({ key })
      });
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * Create a backup of a directory
   */
  async createBackup(
    sandbox: SandboxInstance,
    dir: string,
    options?: { name?: string; ttl?: number }
  ): Promise<BackupResult> {
    const start = performance.now();
    try {
      const response = await fetch(`${this.workerUrl}/api/backup/create`, {
        method: 'POST',
        headers: sandbox.headers,
        body: JSON.stringify({ dir, ...options })
      });
      const duration = performance.now() - start;
      if (!response.ok) {
        const text = await response.text();
        return {
          success: false,
          duration,
          error: `HTTP ${response.status}: ${text}`
        };
      }
      const result = (await response.json()) as { id: string };
      return { success: true, duration, id: result.id };
    } catch (error) {
      return {
        success: false,
        duration: performance.now() - start,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Restore a backup to a directory
   */
  async restoreBackup(
    sandbox: SandboxInstance,
    id: string,
    dir: string
  ): Promise<RestoreResult> {
    const start = performance.now();
    try {
      const response = await fetch(`${this.workerUrl}/api/backup/restore`, {
        method: 'POST',
        headers: sandbox.headers,
        body: JSON.stringify({ id, dir })
      });
      const duration = performance.now() - start;
      if (!response.ok) {
        const text = await response.text();
        return {
          success: false,
          duration,
          error: `HTTP ${response.status}: ${text}`
        };
      }
      return { success: true, duration };
    } catch (error) {
      return {
        success: false,
        duration: performance.now() - start,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
