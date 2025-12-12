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
}
