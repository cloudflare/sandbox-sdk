/**
 * Unit tests for process readiness feature
 *
 * Tests the waitFor(), serve(), and startProcess({ ready }) functionality
 */

import type { DurableObjectState } from '@cloudflare/workers-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProcessExitedBeforeReadyError,
  ProcessReadyTimeoutError
} from '../src/errors';
import { Sandbox } from '../src/sandbox';

// Mock dependencies
vi.mock('./interpreter', () => ({
  CodeInterpreter: vi.fn().mockImplementation(() => ({}))
}));

vi.mock('@cloudflare/containers', () => {
  const MockContainer = class Container {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    async fetch(): Promise<Response> {
      return new Response('Mock Container fetch');
    }
    async containerFetch(): Promise<Response> {
      return new Response('Mock Container HTTP fetch');
    }
    async getState() {
      return { status: 'healthy' };
    }
  };

  return {
    Container: MockContainer,
    getContainer: vi.fn(),
    switchPort: vi.fn()
  };
});

describe('Process Readiness Feature', () => {
  let sandbox: Sandbox;
  let mockCtx: Partial<DurableObjectState<{}>>;
  let mockEnv: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockCtx = {
      storage: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue(new Map())
      } as any,
      blockConcurrencyWhile: vi
        .fn()
        .mockImplementation(
          <T>(callback: () => Promise<T>): Promise<T> => callback()
        ),
      waitUntil: vi.fn(),
      id: {
        toString: () => 'test-sandbox-id',
        equals: vi.fn(),
        name: 'test-sandbox'
      } as any
    };

    mockEnv = {};

    sandbox = new Sandbox(mockCtx as DurableObjectState<{}>, mockEnv);

    await vi.waitFor(() => {
      expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
    });

    // Mock session creation
    vi.spyOn(sandbox.client.utils, 'createSession').mockResolvedValue({
      success: true,
      id: 'sandbox-default',
      message: 'Created'
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('waitFor() method', () => {
    describe('string pattern matching', () => {
      it('should resolve when string pattern found in existing logs', async () => {
        vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          pid: 12345,
          command: 'npm start',
          timestamp: new Date().toISOString()
        } as any);

        vi.spyOn(sandbox.client.processes, 'getProcess').mockResolvedValue({
          success: true,
          process: {
            id: 'proc-server',
            pid: 12345,
            command: 'npm start',
            status: 'running',
            startTime: new Date().toISOString()
          },
          timestamp: new Date().toISOString()
        } as any);

        vi.spyOn(sandbox.client.processes, 'getProcessLogs').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          stdout:
            'Compiling...\nServer listening on port 3000\nReady to accept connections',
          stderr: '',
          timestamp: new Date().toISOString()
        } as any);

        const proc = await sandbox.startProcess('npm start');
        const result = await proc.waitFor('Server listening on port 3000');

        expect(result.line).toContain('Server listening on port 3000');
      });

      it('should find pattern via streaming when not in historical logs', async () => {
        vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          pid: 12345,
          command: 'npm start',
          timestamp: new Date().toISOString()
        } as any);

        vi.spyOn(sandbox.client.processes, 'getProcess').mockResolvedValue({
          success: true,
          process: {
            id: 'proc-server',
            pid: 12345,
            command: 'npm start',
            status: 'running',
            startTime: new Date().toISOString()
          },
          timestamp: new Date().toISOString()
        } as any);

        // First call returns logs without the pattern
        vi.spyOn(sandbox.client.processes, 'getProcessLogs').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          stdout: 'Starting server...',
          stderr: '',
          timestamp: new Date().toISOString()
        } as any);

        // Mock streaming to emit the pattern
        const sseData = `data: {"type":"stdout","data":"Server ready on port 3000\\n","timestamp":"${new Date().toISOString()}"}

`;
        const mockStream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseData));
            controller.close();
          }
        });

        vi.spyOn(
          sandbox.client.processes,
          'streamProcessLogs'
        ).mockResolvedValue(mockStream);

        const proc = await sandbox.startProcess('npm start');
        const result = await proc.waitFor('Server ready on port 3000');

        expect(result.line).toBe('Server ready on port 3000');
      });
    });

    describe('regex pattern matching', () => {
      it('should resolve with match details when regex matches', async () => {
        vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          pid: 12345,
          command: 'npm start',
          timestamp: new Date().toISOString()
        } as any);

        vi.spyOn(sandbox.client.processes, 'getProcess').mockResolvedValue({
          success: true,
          process: {
            id: 'proc-server',
            pid: 12345,
            command: 'npm start',
            status: 'running',
            startTime: new Date().toISOString()
          },
          timestamp: new Date().toISOString()
        } as any);

        vi.spyOn(sandbox.client.processes, 'getProcessLogs').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          stdout: 'Server listening on port 8080',
          stderr: '',
          timestamp: new Date().toISOString()
        } as any);

        const proc = await sandbox.startProcess('npm start');
        const result = await proc.waitFor(/port (\d+)/);

        expect(result.match).toBeDefined();
        expect(result.match![0]).toBe('port 8080');
        expect(result.match![1]).toBe('8080');
      });
    });

    describe('port readiness', () => {
      it('should wait for port to become available', async () => {
        vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          pid: 12345,
          command: 'npm start',
          timestamp: new Date().toISOString()
        } as any);

        vi.spyOn(sandbox.client.processes, 'getProcess').mockResolvedValue({
          success: true,
          process: {
            id: 'proc-server',
            pid: 12345,
            command: 'npm start',
            status: 'running',
            startTime: new Date().toISOString()
          },
          timestamp: new Date().toISOString()
        } as any);

        vi.spyOn(sandbox.client.commands, 'execute').mockResolvedValue({
          success: true,
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'nc -z localhost 3000',
          timestamp: new Date().toISOString()
        } as any);

        const proc = await sandbox.startProcess('npm start');
        const result = await proc.waitFor(3000);

        expect(result).toEqual({});
        expect(sandbox.client.commands.execute).toHaveBeenCalledWith(
          'nc -z localhost 3000',
          expect.any(String),
          expect.objectContaining({ timeoutMs: 1000 })
        );
      });
    });

    describe('timeout handling', () => {
      it('should throw ProcessReadyTimeoutError when pattern not found', async () => {
        vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          pid: 12345,
          command: 'npm start',
          timestamp: new Date().toISOString()
        } as any);

        vi.spyOn(sandbox.client.processes, 'getProcess').mockResolvedValue({
          success: true,
          process: {
            id: 'proc-server',
            pid: 12345,
            command: 'npm start',
            status: 'running',
            startTime: new Date().toISOString()
          },
          timestamp: new Date().toISOString()
        } as any);

        vi.spyOn(sandbox.client.processes, 'getProcessLogs').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          stdout: 'Starting...',
          stderr: 'Warning: something',
          timestamp: new Date().toISOString()
        } as any);

        // Create an empty stream that closes immediately
        const mockStream = new ReadableStream({
          start(controller) {
            controller.close();
          }
        });

        vi.spyOn(
          sandbox.client.processes,
          'streamProcessLogs'
        ).mockResolvedValue(mockStream);

        const proc = await sandbox.startProcess('npm start');

        await expect(proc.waitFor('never-appears', 100)).rejects.toThrow(
          ProcessReadyTimeoutError
        );
      });

      it('should include captured logs in timeout error', async () => {
        vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          pid: 12345,
          command: 'npm start',
          timestamp: new Date().toISOString()
        } as any);

        vi.spyOn(sandbox.client.processes, 'getProcess').mockResolvedValue({
          success: true,
          process: {
            id: 'proc-server',
            pid: 12345,
            command: 'npm start',
            status: 'running',
            startTime: new Date().toISOString()
          },
          timestamp: new Date().toISOString()
        } as any);

        vi.spyOn(sandbox.client.processes, 'getProcessLogs').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          stdout: 'Output line 1\nOutput line 2',
          stderr: 'Error occurred',
          timestamp: new Date().toISOString()
        } as any);

        const mockStream = new ReadableStream({
          start(controller) {
            controller.close();
          }
        });

        vi.spyOn(
          sandbox.client.processes,
          'streamProcessLogs'
        ).mockResolvedValue(mockStream);

        const proc = await sandbox.startProcess('npm start');

        try {
          await proc.waitFor('never-found', 100);
          expect.fail('Should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(ProcessReadyTimeoutError);
          const readyError = error as ProcessReadyTimeoutError;
          expect(readyError.stdout).toContain('Output line 1');
          expect(readyError.stderr).toContain('Error occurred');
          expect(readyError.processId).toBe('proc-server');
          expect(readyError.command).toBe('npm start');
        }
      });
    });

    describe('process exit handling', () => {
      it('should throw ProcessExitedBeforeReadyError when process exits', async () => {
        vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          pid: 12345,
          command: 'npm start',
          timestamp: new Date().toISOString()
        } as any);

        vi.spyOn(sandbox.client.processes, 'getProcessLogs').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          stdout: 'Starting...',
          stderr: 'Error: port in use',
          timestamp: new Date().toISOString()
        } as any);

        // Mock stream to emit an exit event
        const sseData = `data: {"type":"stdout","data":"Starting...\\n","timestamp":"${new Date().toISOString()}"}

data: {"type":"exit","exitCode":1,"timestamp":"${new Date().toISOString()}"}

`;
        const mockStream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseData));
            controller.close();
          }
        });

        vi.spyOn(
          sandbox.client.processes,
          'streamProcessLogs'
        ).mockResolvedValue(mockStream);

        const proc = await sandbox.startProcess('npm start');

        await expect(proc.waitFor('Server ready')).rejects.toThrow(
          ProcessExitedBeforeReadyError
        );
      });

      it('should include exit code and logs in exit error', async () => {
        vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          pid: 12345,
          command: 'npm start',
          timestamp: new Date().toISOString()
        } as any);

        vi.spyOn(sandbox.client.processes, 'getProcessLogs').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          stdout: '',
          stderr: 'command not found: npm',
          timestamp: new Date().toISOString()
        } as any);

        // Mock stream to emit exit event with specific exit code
        const sseData = `data: {"type":"stderr","data":"command not found: npm\\n","timestamp":"${new Date().toISOString()}"}

data: {"type":"exit","exitCode":127,"timestamp":"${new Date().toISOString()}"}

`;
        const mockStream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseData));
            controller.close();
          }
        });

        vi.spyOn(
          sandbox.client.processes,
          'streamProcessLogs'
        ).mockResolvedValue(mockStream);

        const proc = await sandbox.startProcess('npm start');

        try {
          await proc.waitFor('Server ready');
          expect.fail('Should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(ProcessExitedBeforeReadyError);
          const exitError = error as ProcessExitedBeforeReadyError;
          expect(exitError.exitCode).toBe(127);
          expect(exitError.stderr).toContain('command not found');
          expect(exitError.processId).toBe('proc-server');
        }
      });
    });
  });

  describe('startProcess() with ready option', () => {
    it('should wait for ready pattern before returning', async () => {
      vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
        success: true,
        processId: 'proc-server',
        pid: 12345,
        command: 'npm start',
        timestamp: new Date().toISOString()
      } as any);

      vi.spyOn(sandbox.client.processes, 'getProcess').mockResolvedValue({
        success: true,
        process: {
          id: 'proc-server',
          pid: 12345,
          command: 'npm start',
          status: 'running',
          startTime: new Date().toISOString()
        },
        timestamp: new Date().toISOString()
      } as any);

      vi.spyOn(sandbox.client.processes, 'getProcessLogs').mockResolvedValue({
        success: true,
        processId: 'proc-server',
        stdout: 'Server ready',
        stderr: '',
        timestamp: new Date().toISOString()
      } as any);

      const proc = await sandbox.startProcess('npm start', {
        ready: 'Server ready'
      });

      expect(proc.id).toBe('proc-server');
      expect(sandbox.client.processes.getProcessLogs).toHaveBeenCalled();
    });

    it('should respect readyTimeout option', async () => {
      vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
        success: true,
        processId: 'proc-server',
        pid: 12345,
        command: 'npm start',
        timestamp: new Date().toISOString()
      } as any);

      vi.spyOn(sandbox.client.processes, 'getProcess').mockResolvedValue({
        success: true,
        process: {
          id: 'proc-server',
          pid: 12345,
          command: 'npm start',
          status: 'running',
          startTime: new Date().toISOString()
        },
        timestamp: new Date().toISOString()
      } as any);

      vi.spyOn(sandbox.client.processes, 'getProcessLogs').mockResolvedValue({
        success: true,
        processId: 'proc-server',
        stdout: 'Starting...',
        stderr: '',
        timestamp: new Date().toISOString()
      } as any);

      const mockStream = new ReadableStream({
        start(controller) {
          controller.close();
        }
      });

      vi.spyOn(sandbox.client.processes, 'streamProcessLogs').mockResolvedValue(
        mockStream
      );

      await expect(
        sandbox.startProcess('npm start', {
          ready: 'never-appears',
          readyTimeout: 50
        })
      ).rejects.toThrow(ProcessReadyTimeoutError);
    });
  });

  describe('serve() method', () => {
    beforeEach(async () => {
      await sandbox.setSandboxName('test-sandbox');

      vi.spyOn(sandbox.client.ports, 'exposePort').mockResolvedValue({
        success: true,
        port: 8080,
        url: '',
        timestamp: new Date().toISOString()
      } as any);
    });

    it('should start process, wait for port, and expose it', async () => {
      vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
        success: true,
        processId: 'proc-server',
        pid: 12345,
        command: 'npm start',
        timestamp: new Date().toISOString()
      } as any);

      vi.spyOn(sandbox.client.processes, 'getProcess').mockResolvedValue({
        success: true,
        process: {
          id: 'proc-server',
          pid: 12345,
          command: 'npm start',
          status: 'running',
          startTime: new Date().toISOString()
        },
        timestamp: new Date().toISOString()
      } as any);

      // Port check succeeds
      vi.spyOn(sandbox.client.commands, 'execute').mockResolvedValue({
        success: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
        command: 'nc -z localhost 8080',
        timestamp: new Date().toISOString()
      } as any);

      const result = await sandbox.serve('npm start', {
        port: 8080,
        hostname: 'example.com'
      });

      expect(result.process.id).toBe('proc-server');
      expect(result.url).toContain('example.com');
      expect(sandbox.client.processes.startProcess).toHaveBeenCalled();
      expect(sandbox.client.ports.exposePort).toHaveBeenCalled();
    });

    it('should use custom ready pattern when provided', async () => {
      vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
        success: true,
        processId: 'proc-server',
        pid: 12345,
        command: 'npm start',
        timestamp: new Date().toISOString()
      } as any);

      vi.spyOn(sandbox.client.processes, 'getProcess').mockResolvedValue({
        success: true,
        process: {
          id: 'proc-server',
          pid: 12345,
          command: 'npm start',
          status: 'running',
          startTime: new Date().toISOString()
        },
        timestamp: new Date().toISOString()
      } as any);

      // Pattern found in logs immediately
      vi.spyOn(sandbox.client.processes, 'getProcessLogs').mockResolvedValue({
        success: true,
        processId: 'proc-server',
        stdout: 'Custom ready message',
        stderr: '',
        timestamp: new Date().toISOString()
      } as any);

      // Port check also needed since serve() checks both pattern AND port when ready is provided
      vi.spyOn(sandbox.client.commands, 'execute').mockResolvedValue({
        success: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
        command: 'nc -z localhost 8080',
        timestamp: new Date().toISOString()
      } as any);

      const result = await sandbox.serve('npm start', {
        port: 8080,
        hostname: 'example.com',
        ready: 'Custom ready message'
      });

      expect(result.process.id).toBe('proc-server');
      expect(sandbox.client.processes.getProcessLogs).toHaveBeenCalled();
    });

    it('should pass environment variables to process', async () => {
      vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
        success: true,
        processId: 'proc-server',
        pid: 12345,
        command: 'npm start',
        timestamp: new Date().toISOString()
      } as any);

      vi.spyOn(sandbox.client.processes, 'getProcess').mockResolvedValue({
        success: true,
        process: {
          id: 'proc-server',
          pid: 12345,
          command: 'npm start',
          status: 'running',
          startTime: new Date().toISOString()
        },
        timestamp: new Date().toISOString()
      } as any);

      vi.spyOn(sandbox.client.commands, 'execute').mockResolvedValue({
        success: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
        command: 'nc -z localhost 8080',
        timestamp: new Date().toISOString()
      } as any);

      await sandbox.serve('npm start', {
        port: 8080,
        hostname: 'example.com',
        env: { NODE_ENV: 'production' }
      });

      expect(sandbox.client.processes.startProcess).toHaveBeenCalledWith(
        'npm start',
        expect.any(String),
        expect.objectContaining({
          env: { NODE_ENV: 'production' }
        })
      );
    });
  });

  describe('conditionToString helper', () => {
    it('should format string conditions as quoted strings', async () => {
      vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
        success: true,
        processId: 'proc-server',
        pid: 12345,
        command: 'npm start',
        timestamp: new Date().toISOString()
      } as any);

      vi.spyOn(sandbox.client.processes, 'getProcess').mockResolvedValue({
        success: true,
        process: {
          id: 'proc-server',
          pid: 12345,
          command: 'npm start',
          status: 'running',
          startTime: new Date().toISOString()
        },
        timestamp: new Date().toISOString()
      } as any);

      vi.spyOn(sandbox.client.processes, 'getProcessLogs').mockResolvedValue({
        success: true,
        processId: 'proc-server',
        stdout: 'no match here',
        stderr: '',
        timestamp: new Date().toISOString()
      } as any);

      const mockStream = new ReadableStream({
        start(controller) {
          controller.close();
        }
      });

      vi.spyOn(sandbox.client.processes, 'streamProcessLogs').mockResolvedValue(
        mockStream
      );

      const proc = await sandbox.startProcess('npm start');

      try {
        await proc.waitFor('Server ready', 50);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ProcessReadyTimeoutError);
        const readyError = error as ProcessReadyTimeoutError;
        expect(readyError.condition).toBe('"Server ready"');
      }
    });

    it('should format regex conditions with regex syntax', async () => {
      vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
        success: true,
        processId: 'proc-server',
        pid: 12345,
        command: 'npm start',
        timestamp: new Date().toISOString()
      } as any);

      vi.spyOn(sandbox.client.processes, 'getProcess').mockResolvedValue({
        success: true,
        process: {
          id: 'proc-server',
          pid: 12345,
          command: 'npm start',
          status: 'running',
          startTime: new Date().toISOString()
        },
        timestamp: new Date().toISOString()
      } as any);

      vi.spyOn(sandbox.client.processes, 'getProcessLogs').mockResolvedValue({
        success: true,
        processId: 'proc-server',
        stdout: 'no match here',
        stderr: '',
        timestamp: new Date().toISOString()
      } as any);

      const mockStream = new ReadableStream({
        start(controller) {
          controller.close();
        }
      });

      vi.spyOn(sandbox.client.processes, 'streamProcessLogs').mockResolvedValue(
        mockStream
      );

      const proc = await sandbox.startProcess('npm start');

      try {
        await proc.waitFor(/port \d+/, 50);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ProcessReadyTimeoutError);
        const readyError = error as ProcessReadyTimeoutError;
        expect(readyError.condition).toBe('/port \\d+/');
      }
    });

    it('should format port conditions as port numbers', async () => {
      vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
        success: true,
        processId: 'proc-server',
        pid: 12345,
        command: 'npm start',
        timestamp: new Date().toISOString()
      } as any);

      vi.spyOn(sandbox.client.processes, 'getProcess').mockResolvedValue({
        success: true,
        process: {
          id: 'proc-server',
          pid: 12345,
          command: 'npm start',
          status: 'completed',
          exitCode: 1,
          startTime: new Date().toISOString()
        },
        timestamp: new Date().toISOString()
      } as any);

      vi.spyOn(sandbox.client.processes, 'getProcessLogs').mockResolvedValue({
        success: true,
        processId: 'proc-server',
        stdout: '',
        stderr: '',
        timestamp: new Date().toISOString()
      } as any);

      const proc = await sandbox.startProcess('npm start');

      try {
        await proc.waitFor(3000);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ProcessExitedBeforeReadyError);
        const exitError = error as ProcessExitedBeforeReadyError;
        expect(exitError.condition).toBe('port 3000');
      }
    });
  });
});
