import { beforeEach, describe, expect, it, vi } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Logger } from '@repo/shared';
import type { ProcessRecord } from '@sandbox-container/core/types';
import { ProcessStore } from '@sandbox-container/services/process-store.js';

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

const createMockProcess = (
  overrides: Partial<ProcessRecord> = {}
): ProcessRecord => ({
  id: 'proc-123',
  pid: 12345,
  command: 'test command',
  status: 'running',
  startTime: new Date('2024-01-01T00:00:00Z'),
  stdout: '',
  stderr: '',
  outputListeners: new Set(),
  statusListeners: new Set(),
  commandHandle: {
    sessionId: 'default',
    commandId: 'proc-123'
  },
  ...overrides
});

describe('ProcessStore', () => {
  let processStore: ProcessStore;
  let testProcessDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    testProcessDir = `/tmp/sandbox-internal/processes-test-${randomUUID()}`;

    // Clean up test directory
    try {
      await rm(testProcessDir, { recursive: true, force: true });
    } catch {
      // Ignore errors if directory doesn't exist
    }

    processStore = new ProcessStore(mockLogger);
    // Isolate test writes from other suites that use the default process directory.
    (processStore as unknown as { processDir: string }).processDir =
      testProcessDir;
  });

  describe('initialization', () => {
    it('should initialize when first operation is called', async () => {
      const process = createMockProcess();
      await processStore.create(process);

      // Verify process is stored
      const result = await processStore.get(process.id);
      expect(result).not.toBeNull();
    });
  });

  describe('create', () => {
    it('should store process in memory', async () => {
      const process = createMockProcess({ id: 'proc-1', command: 'ls' });
      await processStore.create(process);

      const result = await processStore.get('proc-1');
      expect(result).toEqual(process);
    });
  });

  describe('get', () => {
    it('should retrieve process from memory', async () => {
      const process = createMockProcess({ id: 'proc-1' });
      await processStore.create(process);

      const result = await processStore.get('proc-1');
      expect(result).toEqual(process);
    });

    it('should retrieve completed process from disk', async () => {
      const process = createMockProcess({
        id: 'proc-1',
        status: 'running'
      });
      await processStore.create(process);

      // Update to terminal state (should move to disk)
      await processStore.update('proc-1', {
        status: 'completed',
        exitCode: 0,
        endTime: new Date('2024-01-01T00:01:00Z')
      });

      // Should retrieve from disk
      const result = await processStore.get('proc-1');
      expect(result).not.toBeNull();
      expect(result?.status).toBe('completed');
      expect(result?.exitCode).toBe(0);
    });

    it('should return null for non-existent process', async () => {
      const result = await processStore.get('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('should update process in memory', async () => {
      const process = createMockProcess({ id: 'proc-1', stdout: '' });
      await processStore.create(process);

      await processStore.update('proc-1', { stdout: 'output' });

      const result = await processStore.get('proc-1');
      expect(result?.stdout).toBe('output');
    });

    it('should move completed process from memory to disk', async () => {
      const process = createMockProcess({
        id: 'proc-1',
        status: 'running'
      });
      await processStore.create(process);

      await processStore.update('proc-1', {
        status: 'completed',
        exitCode: 0,
        endTime: new Date('2024-01-01T00:01:00Z')
      });

      // Process should be on disk, not in memory
      const result = await processStore.get('proc-1');
      expect(result).not.toBeNull();
      expect(result?.status).toBe('completed');
    });

    it('should delete from memory even if disk write fails', async () => {
      const process = createMockProcess({
        id: 'proc-1',
        status: 'running'
      });
      await processStore.create(process);

      // Remove write permissions on directory to cause write failure
      const { chmod } = await import('node:fs/promises');
      await chmod(testProcessDir, 0o444); // Read-only

      try {
        await processStore.update('proc-1', {
          status: 'completed',
          exitCode: 0
        });

        // Logger should have recorded the error
        expect(mockLogger.error).toHaveBeenCalledWith(
          'Failed to persist completed process, will be lost on restart',
          expect.any(Error),
          { processId: 'proc-1' }
        );

        // Process should be removed from memory despite write failure
        const result = await processStore.get('proc-1');
        expect(result).toBeNull();
      } finally {
        // Restore write permissions
        await chmod(testProcessDir, 0o755);
      }
    });

    it('should handle all terminal states', async () => {
      const terminalStates: Array<'completed' | 'failed' | 'killed' | 'error'> =
        ['completed', 'failed', 'killed', 'error'];

      for (const status of terminalStates) {
        const id = `proc-${status}`;
        const process = createMockProcess({ id, status: 'running' });
        await processStore.create(process);

        await processStore.update(id, { status, endTime: new Date() });

        // Should be retrievable from disk
        const result = await processStore.get(id);
        expect(result).not.toBeNull();
        expect(result?.status).toBe(status);
      }
    });

    it('should throw error when updating non-existent process', async () => {
      await expect(
        processStore.update('nonexistent', { stdout: 'output' })
      ).rejects.toThrow('Process nonexistent not found');
    });
  });

  describe('delete', () => {
    it('should delete process from memory', async () => {
      const process = createMockProcess({ id: 'proc-1' });
      await processStore.create(process);

      await processStore.delete('proc-1');

      const result = await processStore.get('proc-1');
      expect(result).toBeNull();
    });

    it('should delete process file from disk', async () => {
      const process = createMockProcess({ id: 'proc-1', status: 'running' });
      await processStore.create(process);

      // Move to disk
      await processStore.update('proc-1', {
        status: 'completed',
        endTime: new Date()
      });

      // Delete
      await processStore.delete('proc-1');

      const result = await processStore.get('proc-1');
      expect(result).toBeNull();
    });
  });

  describe('list', () => {
    it('should return active processes from memory', async () => {
      const process1 = createMockProcess({ id: 'proc-1', status: 'running' });
      const process2 = createMockProcess({ id: 'proc-2', status: 'running' });

      await processStore.create(process1);
      await processStore.create(process2);

      const result = await processStore.list();
      expect(result).toHaveLength(2);
      expect(result.map((p) => p.id)).toContain('proc-1');
      expect(result.map((p) => p.id)).toContain('proc-2');
    });

    it('should include completed processes from disk', async () => {
      const process1 = createMockProcess({ id: 'proc-1', status: 'running' });
      const process2 = createMockProcess({ id: 'proc-2', status: 'running' });

      await processStore.create(process1);
      await processStore.create(process2);

      // Complete process1 (moves to disk)
      await processStore.update('proc-1', {
        status: 'completed',
        endTime: new Date()
      });

      // Verify file exists on disk
      const filePath = `${testProcessDir}/proc-1.json`;
      const file = Bun.file(filePath);
      expect(await file.exists()).toBe(true);

      const result = await processStore.list();
      expect(result).toHaveLength(2);
      expect(result.map((p) => p.id)).toContain('proc-1');
      expect(result.map((p) => p.id)).toContain('proc-2');
    });

    it('should filter by status', async () => {
      const process1 = createMockProcess({ id: 'proc-1', status: 'running' });
      const process2 = createMockProcess({ id: 'proc-2', status: 'running' });

      await processStore.create(process1);
      await processStore.create(process2);

      // Complete process1
      await processStore.update('proc-1', {
        status: 'completed',
        endTime: new Date()
      });

      // Filter by running
      const runningProcesses = await processStore.list({ status: 'running' });
      expect(runningProcesses).toHaveLength(1);
      expect(runningProcesses[0].id).toBe('proc-2');

      // Filter by completed
      const completedProcesses = await processStore.list({
        status: 'completed'
      });
      expect(completedProcesses).toHaveLength(1);
      expect(completedProcesses[0].id).toBe('proc-1');
    });

    it('should handle disk scan errors gracefully', async () => {
      const process = createMockProcess({ id: 'proc-1', status: 'running' });
      await processStore.create(process);

      // Create completed process on disk
      const process2 = createMockProcess({ id: 'proc-2', status: 'running' });
      await processStore.create(process2);
      await processStore.update('proc-2', {
        status: 'completed',
        endTime: new Date()
      });

      // Mock Bun.Glob to throw error
      const originalGlob = Bun.Glob;
      Bun.Glob = vi.fn().mockImplementation(() => {
        throw new Error('Scan failed');
      }) as unknown as typeof Bun.Glob;

      try {
        // Should still return in-memory processes
        const result = await processStore.list();
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('proc-1');

        // Should log error
        expect(mockLogger.error).toHaveBeenCalledWith(
          'Failed to scan completed processes from disk',
          expect.any(Error)
        );
      } finally {
        Bun.Glob = originalGlob;
      }
    });

    it('should return empty array when no processes exist', async () => {
      const result = await processStore.list();
      expect(result).toEqual([]);
    });
  });

  describe('disk persistence', () => {
    it('should serialize process without non-serializable fields', async () => {
      const process = createMockProcess({
        id: 'proc-1',
        status: 'running',
        stdout: 'output',
        stderr: 'error'
      });
      await processStore.create(process);

      // Add listeners (non-serializable)
      process.outputListeners.add(() => {});
      process.statusListeners.add(() => {});

      // Move to disk
      await processStore.update('proc-1', {
        status: 'completed',
        endTime: new Date('2024-01-01T00:01:00Z')
      });

      // Read from disk and verify structure
      const retrieved = await processStore.get('proc-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe('proc-1');
      expect(retrieved?.stdout).toBe('output');
      expect(retrieved?.stderr).toBe('error');
      // Listeners should be reconstructed as empty Sets
      expect(retrieved?.outputListeners).toEqual(new Set());
      expect(retrieved?.statusListeners).toEqual(new Set());
    });

    it('should preserve dates when reading from disk', async () => {
      const startTime = new Date('2024-01-01T00:00:00Z');
      const endTime = new Date('2024-01-01T00:01:00Z');

      const process = createMockProcess({
        id: 'proc-1',
        status: 'running',
        startTime
      });
      await processStore.create(process);

      await processStore.update('proc-1', {
        status: 'completed',
        endTime
      });

      const retrieved = await processStore.get('proc-1');
      expect(retrieved?.startTime).toEqual(startTime);
      expect(retrieved?.endTime).toEqual(endTime);
    });
  });
});
