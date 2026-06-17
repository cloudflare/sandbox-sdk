import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { ExecEvent, Logger } from '@repo/shared';
import { DISABLE_SESSION_TOKEN } from '@repo/shared/internal';
import type {
  ProcessRecord,
  ServiceResult
} from '@sandbox-container/core/types';
import type { ExecutionService } from '@sandbox-container/services/execution-service';
import {
  type ProcessFilters,
  ProcessService,
  type ProcessStore
} from '@sandbox-container/services/process-service.js';
import type { RawExecResult } from '@sandbox-container/session-types';
import { mocked } from '../test-utils';

// Mock the dependencies with proper typing
const mockProcessStore = {
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  cleanup: vi.fn()
} as unknown as ProcessStore;

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

const mockExecutionService = {
  execute: vi.fn(),
  executeStream: vi.fn(),
  withExecution: vi.fn(),
  kill: vi.fn()
} as unknown as ExecutionService;

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
      mockExecutionService
    );
  });

  describe('executeCommand', () => {
    it('should execute command and return success', async () => {
      // Mock SessionManager to return successful execution
      mocked(mockExecutionService.execute).mockResolvedValue({
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
      expect(mockExecutionService.execute).toHaveBeenCalledWith(
        'echo "hello world"',
        {
          sessionId: undefined,
          cwd: '/tmp',
          timeoutMs: undefined,
          env: undefined,
          origin: undefined
        }
      );
    });

    it('should handle command with non-zero exit code', async () => {
      mocked(mockExecutionService.execute).mockResolvedValue({
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
      mocked(mockExecutionService.execute).mockResolvedValue({
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
      let createdCommandAtCreate: ProcessRecord['command'] | undefined;
      let createdStatusAtCreate: ProcessRecord['status'] | undefined;
      let createdCommandHandleAtCreate:
        | ProcessRecord['commandHandle']
        | undefined;

      mocked(mockProcessStore.create).mockImplementationOnce(
        async (process) => {
          createdCommandAtCreate = process.command;
          createdStatusAtCreate = process.status;
          createdCommandHandleAtCreate = process.commandHandle;
        }
      );

      mocked(mockExecutionService.executeStream).mockImplementation(
        async (_command, options) =>
          ({
            success: true,
            data: {
              continueStreaming: new Promise(() => {}),
              commandHandle: {
                sessionId: 'session-123',
                commandId: options.commandId
              }
            }
          }) as ServiceResult<{
            continueStreaming: Promise<void>;
            commandHandle: { sessionId: string; commandId: string };
          }>
      );

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
      expect(mockExecutionService.executeStream).toHaveBeenCalledWith(
        'sleep 10',
        expect.objectContaining({
          sessionId: 'session-123',
          cwd: '/tmp',
          commandId: expect.any(String),
          onEvent: expect.any(Function)
        })
      );

      expect(createdCommandAtCreate).toBe('sleep 10');
      expect(createdStatusAtCreate).toBe('running');
      expect(createdCommandHandleAtCreate).toEqual({
        sessionId: 'session-123',
        commandId: result.success ? result.data.id : expect.any(String)
      });

      expect(mockProcessStore.update).toHaveBeenCalledWith(
        result.success ? result.data.id : expect.any(String),
        expect.objectContaining({
          commandHandle: {
            sessionId: 'session-123',
            commandId: result.success ? result.data.id : expect.any(String)
          }
        })
      );
    });

    it('uses stateless command handles for missing-session processes', async () => {
      let createdCommandHandleAtCreate:
        | ProcessRecord['commandHandle']
        | undefined;

      mocked(mockProcessStore.create).mockImplementationOnce(
        async (process) => {
          createdCommandHandleAtCreate = process.commandHandle;
        }
      );

      mocked(mockExecutionService.executeStream).mockImplementation(
        async (_command, options) =>
          ({
            success: true,
            data: {
              continueStreaming: new Promise(() => {}),
              commandHandle: {
                sessionId: DISABLE_SESSION_TOKEN,
                commandId: options.commandId,
                pid: 4321
              }
            }
          }) as ServiceResult<{
            continueStreaming: Promise<void>;
            commandHandle: {
              sessionId: string;
              commandId: string;
              pid?: number;
            };
          }>
      );

      const result = await processService.startProcess('sleep 10');

      expect(result.success).toBe(true);
      expect(createdCommandHandleAtCreate).toEqual({
        sessionId: DISABLE_SESSION_TOKEN,
        commandId: result.success ? result.data.id : expect.any(String)
      });
      expect(mockExecutionService.executeStream).toHaveBeenCalledWith(
        'sleep 10',
        expect.objectContaining({
          sessionId: undefined
        })
      );
    });

    it('should preserve the sessionless command handle for background processes', async () => {
      let createdCommandHandleAtCreate:
        | ProcessRecord['commandHandle']
        | undefined;

      mocked(mockProcessStore.create).mockImplementationOnce(
        async (process) => {
          createdCommandHandleAtCreate = process.commandHandle;
        }
      );

      mocked(mockExecutionService.executeStream).mockImplementation(
        async (_command, options) =>
          ({
            success: true,
            data: {
              continueStreaming: new Promise(() => {}),
              commandHandle: {
                sessionId: DISABLE_SESSION_TOKEN,
                commandId: options.commandId,
                pid: 4321
              }
            }
          }) as ServiceResult<{
            continueStreaming: Promise<void>;
            commandHandle: {
              sessionId: string;
              commandId: string;
              pid?: number;
            };
          }>
      );

      const result = await processService.startProcess('sleep 10', {
        sessionId: DISABLE_SESSION_TOKEN
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.commandHandle).toEqual({
          sessionId: DISABLE_SESSION_TOKEN,
          commandId: result.data.id,
          pid: 4321
        });
      }

      expect(createdCommandHandleAtCreate).toEqual({
        sessionId: DISABLE_SESSION_TOKEN,
        commandId: result.success ? result.data.id : expect.any(String)
      });

      expect(mockProcessStore.update).toHaveBeenCalledWith(
        result.success ? result.data.id : expect.any(String),
        expect.objectContaining({
          commandHandle: {
            sessionId: DISABLE_SESSION_TOKEN,
            commandId: result.success ? result.data.id : expect.any(String),
            pid: 4321
          }
        })
      );
    });

    it('should reflect a later non-zero complete event on the returned process record', async () => {
      let onEvent: ((event: ExecEvent) => Promise<void>) | undefined;

      mocked(mockExecutionService.executeStream).mockImplementation(
        async (_command, options) => {
          onEvent = options.onEvent;

          return {
            success: true,
            data: {
              continueStreaming: new Promise(() => {}),
              commandHandle: {
                sessionId: DISABLE_SESSION_TOKEN,
                commandId: options.commandId,
                pid: 4321
              }
            }
          } as ServiceResult<{
            continueStreaming: Promise<void>;
            commandHandle: {
              sessionId: string;
              commandId: string;
              pid?: number;
            };
          }>;
        }
      );

      const result = await processService.startProcess('(exit 7)', {});

      expect(result.success).toBe(true);
      expect(onEvent).toBeDefined();

      if (result.success && onEvent) {
        await onEvent({
          type: 'complete',
          exitCode: 7,
          timestamp: new Date().toISOString()
        });

        expect(result.data.exitCode).toBe(7);
        expect(result.data.status).toBe('failed');
      }
    });

    it('should reject empty command', async () => {
      const result = await processService.startProcess('', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_COMMAND');
        expect(result.error.message).toContain('empty command');
      }

      // Verify SessionManager was not called
      expect(mockExecutionService.executeStream).not.toHaveBeenCalled();
    });

    it('should handle stream execution errors', async () => {
      mocked(mockExecutionService.executeStream).mockImplementation(() => {
        throw new Error('Failed to execute stream');
      });

      const result = await processService.startProcess('echo test', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('STREAM_START_ERROR');
        expect(result.error.message).toContain(
          'Failed to start streaming command'
        );
      }

      expect(mockProcessStore.update).toHaveBeenCalledWith(
        expect.stringMatching(/^proc_\d+_[a-z0-9]+$/),
        expect.objectContaining({
          status: 'error',
          endTime: expect.any(Date),
          stderr: 'Failed to execute stream'
        })
      );
    });

    it('should mark returned stream startup failures as terminal error', async () => {
      mocked(mockExecutionService.executeStream).mockResolvedValue({
        success: false,
        error: {
          message: 'Failed before stream was ready',
          code: 'STREAM_START_ERROR'
        }
      } as ServiceResult<{
        continueStreaming: Promise<void>;
        commandHandle: { sessionId: string; commandId: string };
      }>);

      const result = await processService.startProcess('echo test', {});

      expect(result.success).toBe(false);
      expect(mockProcessStore.update).toHaveBeenCalledWith(
        expect.stringMatching(/^proc_\d+_[a-z0-9]+$/),
        expect.objectContaining({
          status: 'error',
          endTime: expect.any(Date),
          stderr: 'Failed before stream was ready'
        })
      );
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
      mocked(mockExecutionService.kill).mockResolvedValue({
        success: true
      } as ServiceResult<void>);

      const result = await processService.killProcess('proc-123');

      expect(result.success).toBe(true);

      expect(mockExecutionService.kill).toHaveBeenCalledWith(
        mockProcess.commandHandle
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

      expect(mockExecutionService.kill).not.toHaveBeenCalled();
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
      mocked(mockExecutionService.kill).mockResolvedValue({
        success: true
      } as ServiceResult<void>);

      const result = await processService.killAllProcesses();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(2); // Killed 2 processes
      }

      expect(mockExecutionService.kill).toHaveBeenCalledTimes(2);
    });
  });
});
