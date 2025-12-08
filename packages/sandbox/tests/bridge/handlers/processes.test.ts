import { describe, expect, it, vi } from 'vitest';
import { handleProcesses } from '../../../src/bridge/handlers/processes';

describe('handleProcesses', () => {
  describe('start', () => {
    it('should start process and return result', async () => {
      const mockSandbox = {
        startProcess: vi.fn().mockResolvedValue({
          processId: 'proc-123',
          status: 'running'
        })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/processes/start',
        {
          method: 'POST',
          body: JSON.stringify({ command: 'node server.js' })
        }
      );

      const response = await handleProcesses(request, mockSandbox as any, [
        'start'
      ]);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.processId).toBe('proc-123');
      expect(mockSandbox.startProcess).toHaveBeenCalledWith(
        'node server.js',
        undefined
      );
    });

    it('should return 400 for missing command', async () => {
      const mockSandbox = {};

      const request = new Request(
        'https://example.com/api/sandbox/test/processes/start',
        {
          method: 'POST',
          body: JSON.stringify({})
        }
      );

      const response = await handleProcesses(request, mockSandbox as any, [
        'start'
      ]);

      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe('INVALID_REQUEST');
    });
  });

  describe('kill', () => {
    it('should kill process by ID', async () => {
      const mockSandbox = {
        killProcess: vi.fn().mockResolvedValue({ success: true })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/processes/proc-123',
        {
          method: 'DELETE'
        }
      );

      const response = await handleProcesses(request, mockSandbox as any, [
        'proc-123'
      ]);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockSandbox.killProcess).toHaveBeenCalledWith(
        'proc-123',
        undefined
      );
    });
  });

  describe('list', () => {
    it('should list running processes', async () => {
      const mockSandbox = {
        listProcesses: vi
          .fn()
          .mockResolvedValue([{ processId: 'proc-1' }, { processId: 'proc-2' }])
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/processes'
      );

      const response = await handleProcesses(request, mockSandbox as any, []);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.processes).toHaveLength(2);
    });
  });

  describe('get process', () => {
    it('should get process info by ID', async () => {
      const mockSandbox = {
        getProcess: vi.fn().mockResolvedValue({
          processId: 'proc-123',
          status: 'running'
        })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/processes/proc-123'
      );

      const response = await handleProcesses(request, mockSandbox as any, [
        'proc-123'
      ]);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.status).toBe('running');
    });

    it('should return 404 for nonexistent process', async () => {
      const mockSandbox = {
        getProcess: vi.fn().mockResolvedValue(null)
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/processes/nonexistent'
      );

      const response = await handleProcesses(request, mockSandbox as any, [
        'nonexistent'
      ]);

      expect(response.status).toBe(404);
    });
  });

  describe('logs', () => {
    it('should get process logs', async () => {
      const mockSandbox = {
        getProcessLogs: vi.fn().mockResolvedValue({
          stdout: 'output',
          stderr: ''
        })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/processes/proc-123/logs'
      );

      const response = await handleProcesses(request, mockSandbox as any, [
        'proc-123',
        'logs'
      ]);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.stdout).toBe('output');
    });
  });
});
