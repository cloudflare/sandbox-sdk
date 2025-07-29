/**
 * Process Service Tests
 * 
 * Tests the ProcessService class from the refactored container architecture.
 * This demonstrates how to test individual services with proper mocking.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessService } from '@container/services/process-service';
import type { ProcessStore } from '@container/core/types';
import type { Logger } from '@container/core/logger';

// Mock the dependencies
const mockProcessStore: ProcessStore = {
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
};

const mockLogger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

describe('ProcessService', () => {
  let processService: ProcessService;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    
    // Set up smart Bun.spawn mock that handles different scenarios
    global.Bun = {
      spawn: vi.fn().mockImplementation((args: string[]) => {
        const command = args.join(' ');
        
        // Simulate command failure for nonexistent commands
        if (command.includes('nonexistent-command')) {
          return {
            exited: Promise.resolve(),
            exitCode: 127, // Command not found
            stdout: new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(''));
                controller.close();
              }
            }),
            stderr: new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('command not found: nonexistent-command'));
                controller.close();
              }
            }),
            pid: 12345,
            kill: vi.fn()
          };
        }
        
        // Different behavior for background vs immediate commands
        const isBackgroundCommand = command.includes('sleep') || command.includes('server');
        
        return {
          exited: isBackgroundCommand ? new Promise(() => {}) : Promise.resolve(), // Background processes don't exit immediately
          exitCode: 0,
          stdout: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('test output'));
              controller.close();
            }
          }),
          stderr: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(''));
              controller.close();
            }
          }),
          pid: 12345,
          kill: vi.fn()
        };
      })
    } as any;
    
    // Import the ProcessService (dynamic import to avoid module loading issues)
    const { ProcessService: ProcessServiceClass } = await import('@container/services/process-service');
    processService = new ProcessServiceClass(mockProcessStore, mockLogger);
  });

  describe('executeCommand', () => {
    it('should return ServiceResult with success true for valid command', async () => {
      const result = await processService.executeCommand('echo "hello"', {
        cwd: '/tmp',
        env: {}
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      if (result.success) {
        expect(result.data.exitCode).toBe(0);
        expect(result.data.stdout).toContain('test output');
        expect(result.data.stderr).toBe('');
      }
    });

    it('should return ServiceResult with success false for invalid command', async () => {
      const result = await processService.executeCommand('nonexistent-command', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
        expect(result.error.code).toBe('COMMAND_EXEC_ERROR');
        expect(result.error.message).toContain('Failed to execute command');
      }
    });

    it('should log command execution', async () => {
      await processService.executeCommand('echo "test"', {});

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Executing command',
        { command: 'echo "test"', options: {} }
      );
    });
  });

  describe('startProcess', () => {
    it('should create background process and store it', async () => {
      const result = await processService.startProcess('sleep 10', {
        background: true,
        cwd: '/tmp'
      });

      // Debug: log the actual result
      console.log('startProcess result:', result);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBeDefined();
        expect(result.data.status).toBe('running');
        expect(result.data.command).toBe('sleep 10');
      }

      // Verify process was stored
      expect(mockProcessStore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'sleep 10',
          status: 'running'
        })
      );
    });

    it('should return error for invalid process command', async () => {
      const result = await processService.startProcess('', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_COMMAND');
        expect(result.error.message).toContain('Invalid command: empty command provided');
      }
    });
  });

  describe('getProcess', () => {
    it('should return process from store', async () => {
      const mockProcess = {
        id: 'proc-123',
        command: 'sleep 5',
        status: 'running' as const,
        startTime: new Date(),
        pid: 12345
      };

      (mockProcessStore.get as any).mockResolvedValue(mockProcess);

      const result = await processService.getProcess('proc-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(mockProcess);
      }
      expect(mockProcessStore.get).toHaveBeenCalledWith('proc-123');
    });

    it('should return error when process not found', async () => {
      (mockProcessStore.get as any).mockResolvedValue(null);

      const result = await processService.getProcess('nonexistent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PROCESS_NOT_FOUND');
        expect(result.error.message).toContain('Process nonexistent not found');
      }
    });
  });

  describe('killProcess', () => {
    it('should terminate process and update store', async () => {
      const mockProcess = {
        id: 'proc-123',
        pid: 12345,
        subprocess: {
          kill: vi.fn().mockReturnValue(true)
        }
      };

      (mockProcessStore.get as any).mockResolvedValue(mockProcess);

      const result = await processService.killProcess('proc-123');

      expect(result.success).toBe(true);
      expect(mockProcess.subprocess.kill).toHaveBeenCalledWith();
      expect(mockProcessStore.update).toHaveBeenCalledWith('proc-123', {
        status: 'killed',
        endTime: expect.any(Date)
      });
    });
  });
});

/**
 * This test file demonstrates several key patterns for the new testing architecture:
 * 
 * 1. **ServiceResult Testing**: All service methods return ServiceResult<T>, making
 *    it easy to test both success and error cases uniformly.
 * 
 * 2. **Dependency Injection Mocking**: Services accept dependencies via constructor,
 *    making it trivial to inject mocks for stores and loggers.
 * 
 * 3. **No HTTP Layer Complexity**: We test the service logic directly without
 *    needing to set up HTTP servers or make network requests.
 * 
 * 4. **Bun-Native API Testing**: The actual implementation uses Bun.spawn() and
 *    native APIs, but our tests can validate the interface without mocking
 *    every native call.
 * 
 * 5. **Type Safety**: Full TypeScript support with proper typing throughout.
 */