import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProcessCleanupResult,
  ProcessInfoResult,
  ProcessKillResult,
  ProcessListResult,
  ProcessLogsResult,
  ProcessStartResult
} from '../src/clients';
import { ProcessClient } from '../src/clients/process-client';
import {
  CommandNotFoundError,
  ProcessError,
  ProcessNotFoundError,
  SandboxError
} from '../src/errors';

describe('ProcessClient', () => {
  let client: ProcessClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    client = new ProcessClient({
      baseUrl: 'http://test.com',
      port: 3000
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('process lifecycle management', () => {
    it('should start background processes successfully', async () => {
      const mockResponse: ProcessStartResult = {
        success: true,
        processId: 'proc-web-server',
        command: 'npm run dev',
        pid: 12345,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.startProcess('npm run dev', 'session-123');

      expect(result.success).toBe(true);
      expect(result.command).toBe('npm run dev');
      expect(result.processId).toBe('running');
      expect(result.pid).toBe(12345);
      expect(result.processId).toBe('proc-web-server');
    });

    it('should start processes with custom process IDs', async () => {
      const mockResponse: ProcessStartResult = {
        success: true,
        processId: 'my-api-server',
        command: 'python app.py',
        pid: 54321,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.startProcess('python app.py', 'session-456', {
        processId: 'my-api-server'
      });

      expect(result.success).toBe(true);
      expect(result.processId).toBe('my-api-server');
      expect(result.command).toBe('python app.py');
      expect(result.processId).toBe('running');
    });

    it('should handle long-running process startup', async () => {
      const mockResponse: ProcessStartResult = {
        success: true,
        processId: 'proc-database',
        command: 'docker run postgres',
        pid: 99999,
        timestamp: '2023-01-01T00:00:05Z'
      };

      mockFetch.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve(
                  new Response(JSON.stringify(mockResponse), { status: 200 })
                ),
              100
            )
          )
      );

      const result = await client.startProcess(
        'docker run postgres',
        'session-789'
      );

      expect(result.success).toBe(true);
      expect(result.processId).toBe('running');
      expect(result.command).toBe('docker run postgres');
    });

    it('should handle command not found errors', async () => {
      const errorResponse = {
        error: 'Command not found: invalidcmd',
        code: 'COMMAND_NOT_FOUND'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(
        client.startProcess('invalidcmd', 'session-err')
      ).rejects.toThrow(CommandNotFoundError);
    });

    it('should handle process startup failures', async () => {
      const errorResponse = {
        error: 'Process failed to start: permission denied',
        code: 'PROCESS_ERROR'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 500 })
      );

      await expect(
        client.startProcess('sudo privileged-command', 'session-err')
      ).rejects.toThrow(ProcessError);
    });
  });

  describe('process monitoring and inspection', () => {
    it('should list running processes', async () => {
      const mockResponse: ProcessListResult = {
        success: true,
        processes: [
          {
            id: 'proc-web',
            command: 'npm run dev',
            status: 'running',
            pid: 12345,
            startTime: '2023-01-01T00:00:00Z'
          },
          {
            id: 'proc-api',
            command: 'python api.py',
            status: 'running',
            pid: 12346,
            startTime: '2023-01-01T00:00:30Z'
          },
          {
            id: 'proc-worker',
            command: 'node worker.js',
            status: 'completed',
            pid: 12347,
            exitCode: 0,
            startTime: '2023-01-01T00:01:00Z',
            endTime: '2023-01-01T00:05:00Z'
          }
        ],
        timestamp: '2023-01-01T00:05:30Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.listProcesses();

      expect(result.success).toBe(true);
      expect(result.processes).toHaveLength(3);

      const runningProcesses = result.processes.filter(
        (p) => p.status === 'running'
      );
      expect(runningProcesses).toHaveLength(2);
      expect(runningProcesses[0].pid).toBeDefined();
      expect(runningProcesses[1].pid).toBeDefined();

      const completedProcess = result.processes.find(
        (p) => p.status === 'completed'
      );
      expect(completedProcess?.exitCode).toBe(0);
      expect(completedProcess?.endTime).toBeDefined();
    });

    it('should get specific process details', async () => {
      const mockResponse: ProcessInfoResult = {
        success: true,
        process: {
          id: 'proc-analytics',
          command: 'python analytics.py --batch-size=1000',
          status: 'running',
          pid: 98765,
          startTime: '2023-01-01T00:00:00Z'
        },
        timestamp: '2023-01-01T00:10:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.getProcess('proc-analytics');

      expect(result.success).toBe(true);
      expect(result.process.id).toBe('proc-analytics');
      expect(result.process.command).toContain('--batch-size=1000');
      expect(result.process.status).toBe('running');
      expect(result.process.pid).toBe(98765);
    });

    it('should handle process not found error', async () => {
      const errorResponse = {
        error: 'Process not found: nonexistent-proc',
        code: 'PROCESS_NOT_FOUND'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.getProcess('nonexistent-proc')).rejects.toThrow(
        ProcessNotFoundError
      );
    });

    it('should handle empty process list', async () => {
      const mockResponse: ProcessListResult = {
        success: true,
        processes: [],
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.listProcesses();

      expect(result.success).toBe(true);
      expect(result.processes).toHaveLength(0);
    });
  });

  describe('process termination', () => {
    it('should kill individual processes', async () => {
      const mockResponse: ProcessKillResult = {
        success: true,
        processId: 'test-process',
        timestamp: '2023-01-01T00:10:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.killProcess('proc-web');

      expect(result.success).toBe(true);
    });

    it('should handle kill non-existent process', async () => {
      const errorResponse = {
        error: 'Process not found: already-dead-proc',
        code: 'PROCESS_NOT_FOUND'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.killProcess('already-dead-proc')).rejects.toThrow(
        ProcessNotFoundError
      );
    });

    it('should kill all processes at once', async () => {
      const mockResponse: ProcessCleanupResult = {
        success: true,
        cleanedCount: 0,
        timestamp: '2023-01-01T00:15:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.killAllProcesses();

      expect(result.success).toBe(true);
    });

    it('should handle kill all when no processes running', async () => {
      const mockResponse: ProcessCleanupResult = {
        success: true,
        cleanedCount: 0,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.killAllProcesses();

      expect(result.success).toBe(true);
    });

    it('should handle kill failures', async () => {
      const errorResponse = {
        error: 'Failed to kill process: process is protected',
        code: 'PROCESS_ERROR'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 500 })
      );

      await expect(client.killProcess('protected-proc')).rejects.toThrow(
        ProcessError
      );
    });
  });

  describe('process log management', () => {
    it('should retrieve process logs', async () => {
      const mockResponse: ProcessLogsResult = {
        success: true,
        processId: 'proc-server',
        stdout: `Server starting...
✓ Database connected
✓ Routes loaded
✓ Server listening on port 3000
[INFO] Request: GET /api/health
[INFO] Response: 200 OK`,
        stderr: `[WARN] Deprecated function used in auth.js:45
[WARN] High memory usage: 85%`,
        timestamp: '2023-01-01T00:10:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.getProcessLogs('proc-server');

      expect(result.success).toBe(true);
      expect(result.processId).toBe('proc-server');
      expect(result.stdout).toContain('Server listening on port 3000');
      expect(result.stdout).toContain('Request: GET /api/health');
      expect(result.stderr).toContain('Deprecated function used');
      expect(result.stderr).toContain('High memory usage');
    });

    it('should handle logs for non-existent process', async () => {
      const errorResponse = {
        error: 'Process not found: missing-proc',
        code: 'PROCESS_NOT_FOUND'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.getProcessLogs('missing-proc')).rejects.toThrow(
        ProcessNotFoundError
      );
    });

    it('should retrieve logs for processes with large output', async () => {
      const largeStdout = 'Log entry with details\n'.repeat(10000);
      const largeStderr = 'Error trace line\n'.repeat(1000);

      const mockResponse: ProcessLogsResult = {
        success: true,
        processId: 'proc-batch',
        stdout: largeStdout,
        stderr: largeStderr,
        timestamp: '2023-01-01T00:30:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.getProcessLogs('proc-batch');

      expect(result.success).toBe(true);
      expect(result.stdout.length).toBeGreaterThan(200000);
      expect(result.stderr.length).toBeGreaterThan(15000);
      expect(result.stdout.split('\n')).toHaveLength(10001);
      expect(result.stderr.split('\n')).toHaveLength(1001);
    });

    it('should handle empty process logs', async () => {
      const mockResponse: ProcessLogsResult = {
        success: true,
        processId: 'proc-silent',
        stdout: '',
        stderr: '',
        timestamp: '2023-01-01T00:05:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.getProcessLogs('proc-silent');

      expect(result.success).toBe(true);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(result.processId).toBe('proc-silent');
    });
  });

  describe('log streaming', () => {
    it('should stream process logs in real-time', async () => {
      const logData = `data: {"type":"stdout","data":"Server starting...\\n","timestamp":"2023-01-01T00:00:01Z"}

data: {"type":"stdout","data":"Database connected\\n","timestamp":"2023-01-01T00:00:02Z"}

data: {"type":"stderr","data":"Warning: deprecated API\\n","timestamp":"2023-01-01T00:00:03Z"}

data: {"type":"stdout","data":"Server ready on port 3000\\n","timestamp":"2023-01-01T00:00:04Z"}

`;

      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(logData));
          controller.close();
        }
      });

      mockFetch.mockResolvedValue(
        new Response(mockStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      );

      const stream = await client.streamProcessLogs('proc-realtime');

      expect(stream).toBeInstanceOf(ReadableStream);

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let content = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          content += decoder.decode(value);
        }
      } finally {
        reader.releaseLock();
      }

      expect(content).toContain('Server starting');
      expect(content).toContain('Database connected');
      expect(content).toContain('Warning: deprecated API');
      expect(content).toContain('Server ready on port 3000');
    });

    it('should handle streaming for non-existent process', async () => {
      const errorResponse = {
        error: 'Process not found: stream-missing',
        code: 'PROCESS_NOT_FOUND'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.streamProcessLogs('stream-missing')).rejects.toThrow(
        ProcessNotFoundError
      );
    });

    it('should handle streaming setup failures', async () => {
      const errorResponse = {
        error: 'Failed to setup log stream: process not outputting logs',
        code: 'PROCESS_ERROR'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 500 })
      );

      await expect(client.streamProcessLogs('proc-no-logs')).rejects.toThrow(
        ProcessError
      );
    });

    it('should handle missing stream body', async () => {
      mockFetch.mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      );

      await expect(
        client.streamProcessLogs('proc-empty-stream')
      ).rejects.toThrow('No response body for streaming');
    });
  });

  describe('session integration', () => {
    it('should include session in process operations', async () => {
      const mockResponse: ProcessStartResult = {
        success: true,
        processId: 'proc-session-test',
        command: 'echo session-test',
        pid: 11111,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.startProcess(
        'echo session-test',
        'session-test'
      );

      expect(result.success).toBe(true);

      const [url, options] = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(options.body);
      expect(requestBody.sessionId).toBe('session-test');
      expect(requestBody.command).toBe('echo session-test');
    });
  });

  describe('concurrent process operations', () => {
    it('should handle multiple simultaneous process operations', async () => {
      mockFetch.mockImplementation((url: string, options: RequestInit) => {
        if (url.includes('/start')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                success: true,
                process: {
                  id: `proc-${Date.now()}`,
                  command: JSON.parse(options.body as string).command,
                  status: 'running',
                  pid: Math.floor(Math.random() * 90000) + 10000,
                  startTime: new Date().toISOString()
                },
                timestamp: new Date().toISOString()
              })
            )
          );
        } else if (url.includes('/list')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                success: true,
                processes: [],
                timestamp: new Date().toISOString()
              })
            )
          );
        } else if (url.includes('/logs')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                success: true,
                processId: url.split('/')[4],
                stdout: 'log output',
                stderr: '',
                timestamp: new Date().toISOString()
              })
            )
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      const operations = await Promise.all([
        client.startProcess('npm run dev', 'session-concurrent'),
        client.startProcess('python api.py', 'session-concurrent'),
        client.listProcesses(),
        client.getProcessLogs('existing-proc'),
        client.startProcess('node worker.js', 'session-concurrent')
      ]);

      expect(operations).toHaveLength(5);
      operations.forEach((result) => {
        expect(result.success).toBe(true);
      });

      expect(mockFetch).toHaveBeenCalledTimes(5);
    });
  });

  describe('error handling', () => {
    it('should handle network failures gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network connection failed'));

      await expect(client.listProcesses()).rejects.toThrow(
        'Network connection failed'
      );
    });

    it('should handle malformed server responses', async () => {
      mockFetch.mockResolvedValue(
        new Response('invalid json {', { status: 200 })
      );

      await expect(
        client.startProcess('test-command', 'session-err')
      ).rejects.toThrow(SandboxError);
    });
  });

  describe('constructor options', () => {
    it('should initialize with minimal options', () => {
      const minimalClient = new ProcessClient();
      expect(minimalClient).toBeDefined();
    });

    it('should initialize with full options', () => {
      const fullOptionsClient = new ProcessClient({
        baseUrl: 'http://custom.com',
        port: 8080
      });
      expect(fullOptionsClient).toBeDefined();
    });
  });
});
