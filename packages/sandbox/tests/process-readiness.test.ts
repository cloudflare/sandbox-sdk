/**
 * Unit tests for process readiness feature
 *
 * Tests the waitForLog() and waitForPort() functionality
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

  describe('waitForLog() method', () => {
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
        const result = await proc.waitForLog('Server listening on port 3000');

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
        const result = await proc.waitForLog('Server ready on port 3000');

        expect(result.line).toBe('Server ready on port 3000');
      });

      it('should find pattern that spans multiple SSE chunks', async () => {
        vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          pid: 12345,
          command: 'npm start',
          timestamp: new Date().toISOString()
        } as any);

        // Mock empty historical logs
        vi.spyOn(sandbox.client.processes, 'getProcessLogs').mockResolvedValue({
          success: true,
          processId: 'proc-server',
          stdout: '',
          stderr: '',
          timestamp: new Date().toISOString()
        } as any);

        // Simulate pattern split across multiple SSE chunks:
        // "Server listen" in chunk 1, "ing on port 3000" in chunk 2
        const sseChunk1 = `data: {"type":"stdout","data":"Server listen","timestamp":"${new Date().toISOString()}"}\n\n`;
        const sseChunk2 = `data: {"type":"stdout","data":"ing on port 3000\\n","timestamp":"${new Date().toISOString()}"}\n\n`;

        const mockStream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseChunk1));
            controller.enqueue(new TextEncoder().encode(sseChunk2));
            controller.close();
          }
        });

        vi.spyOn(
          sandbox.client.processes,
          'streamProcessLogs'
        ).mockResolvedValue(mockStream);

        const proc = await sandbox.startProcess('npm start');
        const result = await proc.waitForLog('Server listening on port 3000');

        // Should find the pattern even though it was split across chunks
        expect(result.line).toBe('Server listening on port 3000');
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
        const result = await proc.waitForLog(/port (\d+)/);

        expect(result.match).toBeDefined();
        expect(result.match![0]).toBe('port 8080');
        expect(result.match![1]).toBe('8080');
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

        await expect(proc.waitForLog('never-appears', 100)).rejects.toThrow(
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
          await proc.waitForLog('never-found', 100);
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

        await expect(proc.waitForLog('Server ready')).rejects.toThrow(
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
          await proc.waitForLog('Server ready');
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

  describe('waitForPort() method', () => {
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
        command: "bash -c 'echo > /dev/tcp/localhost/3000' 2>/dev/null",
        timestamp: new Date().toISOString()
      } as any);

      const proc = await sandbox.startProcess('npm start');
      await proc.waitForPort(3000);

      expect(sandbox.client.commands.execute).toHaveBeenCalledWith(
        "bash -c 'echo > /dev/tcp/localhost/3000' 2>/dev/null",
        expect.any(String),
        expect.objectContaining({ timeoutMs: 1000 })
      );
    });

    it('should throw ProcessExitedBeforeReadyError when process exits before port is ready', async () => {
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
        await proc.waitForPort(3000);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ProcessExitedBeforeReadyError);
        const exitError = error as ProcessExitedBeforeReadyError;
        expect(exitError.condition).toBe('port 3000');
      }
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
        await proc.waitForLog('Server ready', 50);
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
        await proc.waitForLog(/port \d+/, 50);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ProcessReadyTimeoutError);
        const readyError = error as ProcessReadyTimeoutError;
        expect(readyError.condition).toBe('/port \\d+/');
      }
    });
  });
});
