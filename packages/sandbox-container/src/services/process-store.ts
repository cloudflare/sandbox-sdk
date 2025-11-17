import { mkdir, unlink } from 'node:fs/promises';
import type { Logger } from '@repo/shared';
import type { ProcessFilters, ProcessRecord } from './process-service';

/**
 * File-based process store that persists completed processes to disk.
 * Active processes are kept in memory for fast access.
 * When a process reaches a terminal state, it is written to disk and removed from memory.
 */
export class ProcessStore {
  private processes = new Map<string, ProcessRecord>();
  private processDir = '/tmp/sandbox-internal/processes';
  private initialized = false;

  constructor(private logger: Logger) {}

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await mkdir(this.processDir, { recursive: true });
      this.initialized = true;
    } catch (error) {
      // Directory might already exist, that's fine
      this.initialized = true;
    }
  }

  async create(process: ProcessRecord): Promise<void> {
    await this.ensureInitialized();
    this.processes.set(process.id, process);
  }

  async get(id: string): Promise<ProcessRecord | null> {
    await this.ensureInitialized();

    // Check in-memory first for active processes
    const inMemory = this.processes.get(id);
    if (inMemory) {
      return inMemory;
    }

    // Fall back to file system for completed processes
    return await this.readProcessFile(id);
  }

  async update(id: string, data: Partial<ProcessRecord>): Promise<void> {
    await this.ensureInitialized();

    const existing = this.processes.get(id);
    if (!existing) {
      // Process might be in file already
      const fileProcess = await this.readProcessFile(id);
      if (!fileProcess) {
        throw new Error(`Process ${id} not found`);
      }
      const updated = { ...fileProcess, ...data };
      await this.writeProcessFile(id, updated);
      return;
    }

    const updated = { ...existing, ...data };
    this.processes.set(id, updated);

    // Persist terminal states to disk and free memory
    const isTerminal = ['completed', 'failed', 'killed', 'error'].includes(
      updated.status
    );
    if (isTerminal) {
      try {
        await this.writeProcessFile(id, updated);
      } catch (error) {
        // Write failed, still delete to prevent memory leak
        // Explicit tradeoff: container stability > process history
        this.logger.error(
          'Failed to persist completed process, will be lost on restart',
          error instanceof Error ? error : new Error(String(error)),
          { processId: id }
        );
      }
      // Always delete from memory to prevent leak, even if write failed
      this.processes.delete(id);
    }
  }

  async delete(id: string): Promise<void> {
    await this.ensureInitialized();
    this.processes.delete(id);
    await this.deleteProcessFile(id);
  }

  async list(filters?: ProcessFilters): Promise<ProcessRecord[]> {
    await this.ensureInitialized();

    // Start with active processes in memory
    let processes = Array.from(this.processes.values());

    // Include completed processes from disk
    try {
      const files = await Array.fromAsync(
        new Bun.Glob('*.json').scan({ cwd: this.processDir })
      );

      for (const file of files) {
        const processId = file.replace('.json', '');
        const process = await this.readProcessFile(processId);
        if (process) {
          processes.push(process);
        }
      }
    } catch (error) {
      // If scanning fails (e.g., directory doesn't exist), just return in-memory processes
      this.logger.error(
        'Failed to scan completed processes from disk',
        error instanceof Error ? error : new Error(String(error))
      );
    }

    if (filters?.status) {
      processes = processes.filter((p) => p.status === filters.status);
    }

    return processes;
  }

  // File I/O helper methods

  private getProcessFilePath(id: string): string {
    return `${this.processDir}/${id}.json`;
  }

  private async writeProcessFile(
    id: string,
    process: ProcessRecord
  ): Promise<void> {
    // Serialize process record, excluding non-serializable fields
    const serializable = {
      id: process.id,
      pid: process.pid,
      command: process.command,
      status: process.status,
      startTime: process.startTime,
      endTime: process.endTime,
      exitCode: process.exitCode,
      stdout: process.stdout,
      stderr: process.stderr,
      commandHandle: process.commandHandle
      // Exclude: outputListeners, statusListeners (Set objects, not serializable)
    };

    const filePath = this.getProcessFilePath(id);
    await Bun.write(filePath, JSON.stringify(serializable, null, 2));
  }

  private async readProcessFile(id: string): Promise<ProcessRecord | null> {
    try {
      const filePath = this.getProcessFilePath(id);
      const file = Bun.file(filePath);

      if (!(await file.exists())) {
        return null;
      }

      const text = await file.text();
      const data = JSON.parse(text);

      // Reconstruct ProcessRecord with empty listener Sets
      const process: ProcessRecord = {
        ...data,
        startTime: new Date(data.startTime),
        endTime: data.endTime ? new Date(data.endTime) : undefined,
        outputListeners: new Set(),
        statusListeners: new Set()
      };

      return process;
    } catch (error) {
      return null;
    }
  }

  private async deleteProcessFile(id: string): Promise<void> {
    try {
      const filePath = this.getProcessFilePath(id);
      const file = Bun.file(filePath);

      if (await file.exists()) {
        await unlink(filePath);
      }
    } catch (error) {
      // Best effort - don't throw if cleanup fails
    }
  }
}
