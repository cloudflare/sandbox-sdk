import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type {
  Logger,
  ProcessRecord,
  ServiceResult
} from '@sandbox-container/core/types.ts';
import {
  type ProcessFilters,
  ProcessService,
  type ProcessStore
} from '@sandbox-container/services/process-service.js';
import type {
  RawExecResult,
  SessionManager
} from '@sandbox-container/services/session-manager';
import { mocked } from '../test-utils';

// Mock the dependencies with proper typing
const mockProcessStore: ProcessStore = {
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  cleanup: vi.fn()
};

const mockLogger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn()
};

// Mock SessionManager with proper typing
const mockSessionManager: Partial<SessionManager> = {
  executeInSession: vi.fn(),
  executeStreamInSession: vi.fn(),
  killCommand: vi.fn(),
  setEnvVars: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn()
};

// Mock factory functions
const createMockProcess = (
  overrides: Partial<ProcessRecord> = {}
): ProcessRecord => ({
  id: 'proc-123',
  command: 'test command',
  status: 'running',
  startTime: new Date(),
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

describe('ProcessService', () => {
  let processService: ProcessService;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    // Create service with mocked SessionManager
    processService = new ProcessService(
      mockProcessStore,
      mockLogger,
      mockSessionManager as SessionManager
    );
  });

  describe('executeCommand', () => {
    it('should execute command and return success', async () => {
      // Mock SessionManager to return successful execution
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: {
          exitCode: 0,
          stdout: 'hello world\n',
          stderr: ''
        }
      } as ServiceResult<RawExecResult>);

      const result = await processService.executeCommand('echo "hello world"', {
        cwd: '/tmp'
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.success).toBe(true);
        expect(result.data.exitCode).toBe(0);
        expect(result.data.stdout).toBe('hello world\n');
        expect(result.data.stderr).toBe('');
      }

      // Verify SessionManager was called correctly
      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'default', // sessionId
        'echo "hello world"',
        '/tmp', // cwd
        undefined, // timeoutMs (not provided in options)
        undefined // env (not provided in options)
      );
    });

    it('should handle command with non-zero exit code', async () => {
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: {
          exitCode: 1,
          stdout: '',
          stderr: 'error message'
        }
      } as ServiceResult<RawExecResult>);

      const result = await processService.executeCommand('false');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.success).toBe(false);
        expect(result.data.exitCode).toBe(1);
      }
    });

    it('should handle SessionManager errors', async () => {
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: false,
        error: {
          message: 'Session execution failed',
          code: 'SESSION_ERROR'
        }
      } as ServiceResult<RawExecResult>);

      const result = await processService.executeCommand('some command');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SESSION_ERROR');
      }
    });
  });

  describe('startProcess', () => {
    it('should start background process successfully', async () => {
      // Mock SessionManager.executeStreamInSession to return ServiceResult with continueStreaming promise
      mocked(mockSessionManager.executeStreamInSession).mockResolvedValue({
        success: true,
        data: {
          continueStreaming: new Promise(() => {}) // Never resolves (background process)
        }
      } as ServiceResult<{ continueStreaming: Promise<void> }>);

      const result = await processService.startProcess('sleep 10', {
        cwd: '/tmp',
        sessionId: 'session-123'
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^proc_\d+_[a-z0-9]+$/);
        expect(result.data.command).toBe('sleep 10');
        expect(result.data.status).toBe('running');
        expect(result.data.commandHandle).toEqual({
          sessionId: 'session-123',
          commandId: result.data.id
        });
      }

      // Verify SessionManager.executeStreamInSession was called
      expect(mockSessionManager.executeStreamInSession).toHaveBeenCalledWith(
        'session-123',
        'sleep 10',
        expect.any(Function), // event handler callback
        expect.objectContaining({ cwd: '/tmp' }),
        expect.any(String) // commandId (generated dynamically)
      );

      // Verify process was stored
      expect(mockProcessStore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'sleep 10',
          status: 'running',
          commandHandle: expect.objectContaining({
            sessionId: 'session-123'
          })
        })
      );
    });

    it('should reject empty command', async () => {
      const result = await processService.startProcess('', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_COMMAND');
        expect(result.error.message).toContain('empty command');
      }

      // Verify SessionManager was not called
      expect(mockSessionManager.executeStreamInSession).not.toHaveBeenCalled();
    });

    it('should handle stream execution errors', async () => {
      // Mock SessionManager to throw error
      mocked(mockSessionManager.executeStreamInSession).mockImplementation(
        () => {
          throw new Error('Failed to execute stream');
        }
      );

      const result = await processService.startProcess('echo test', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('STREAM_START_ERROR');
        expect(result.error.message).toContain(
          'Failed to start streaming command'
        );
      }
    });
  });

  describe('getProcess', () => {
    it('should return process from store', async () => {
      const mockProcess = createMockProcess({ command: 'sleep 5' });

      mocked(mockProcessStore.get).mockResolvedValue(mockProcess);

      const result = await processService.getProcess('proc-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(mockProcess);
      }
      expect(mockProcessStore.get).toHaveBeenCalledWith('proc-123');
    });

    it('should return error when process not found', async () => {
      mocked(mockProcessStore.get).mockResolvedValue(null);

      const result = await processService.getProcess('nonexistent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PROCESS_NOT_FOUND');
        expect(result.error.message).toContain('Process nonexistent not found');
      }
    });
  });

  describe('killProcess', () => {
    it('should kill process and update store', async () => {
      const mockProcess = createMockProcess({
        command: 'sleep 10',
        commandHandle: {
          sessionId: 'default',
          commandId: 'proc-123'
        }
      });

      mocked(mockProcessStore.get).mockResolvedValue(mockProcess);
      mocked(mockSessionManager.killCommand).mockResolvedValue({
        success: true
      } as ServiceResult<void>);

      const result = await processService.killProcess('proc-123');

      expect(result.success).toBe(true);

      // Verify SessionManager.killCommand was called
      expect(mockSessionManager.killCommand).toHaveBeenCalledWith(
        'default',
        'proc-123'
      );

      // Verify store was updated
      expect(mockProcessStore.update).toHaveBeenCalledWith('proc-123', {
        status: 'killed',
        endTime: expect.any(Date)
      });
    });

    it('should return error when process not found', async () => {
      mocked(mockProcessStore.get).mockResolvedValue(null);

      const result = await processService.killProcess('nonexistent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PROCESS_NOT_FOUND');
      }
    });

    it('should succeed when process has no commandHandle', async () => {
      const mockProcess = createMockProcess({
        command: 'echo test',
        commandHandle: undefined
      });

      mocked(mockProcessStore.get).mockResolvedValue(mockProcess);

      const result = await processService.killProcess('proc-123');

      expect(result.success).toBe(true);

      // Should not attempt to kill
      expect(mockSessionManager.killCommand).not.toHaveBeenCalled();
    });
  });

  describe('listProcesses', () => {
    it('should return all processes from store', async () => {
      const mockProcesses = [
        createMockProcess({ id: 'proc-1', command: 'ls', status: 'completed' }),
        createMockProcess({
          id: 'proc-2',
          command: 'sleep 10',
          status: 'running'
        })
      ];

      mocked(mockProcessStore.list).mockResolvedValue(mockProcesses);

      const result = await processService.listProcesses();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(mockProcesses);
      }
    });
  });

  describe('killAllProcesses', () => {
    it('should kill all running processes', async () => {
      const mockProcesses = [
        createMockProcess({
          id: 'proc-1',
          command: 'sleep 10',
          commandHandle: { sessionId: 'default', commandId: 'proc-1' }
        }),
        createMockProcess({
          id: 'proc-2',
          command: 'sleep 20',
          commandHandle: { sessionId: 'default', commandId: 'proc-2' }
        })
      ];

      mocked(mockProcessStore.list).mockResolvedValue(mockProcesses);
      mocked(mockProcessStore.get)
        .mockResolvedValueOnce(mockProcesses[0])
        .mockResolvedValueOnce(mockProcesses[1]);
      mocked(mockSessionManager.killCommand).mockResolvedValue({
        success: true
      } as ServiceResult<void>);

      const result = await processService.killAllProcesses();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(2); // Killed 2 processes
      }

      // Verify killCommand was called for each process
      expect(mockSessionManager.killCommand).toHaveBeenCalledTimes(2);
    });
  });
});
