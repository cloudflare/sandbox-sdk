// Vitest globals are available due to globals: true in config

import type { 
  GetProcessLogsResponse,
  GetProcessResponse,
  HttpClientOptions, 
  KillAllProcessesResponse,
  KillProcessResponse,
  ListProcessesResponse, 
  ProcessInfo,
  StartProcessResponse 
} from '../../clients';
import { ProcessClient } from '../../clients/process-client';

describe('ProcessClient', () => {
  let client: ProcessClient;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  const mockProcess: ProcessInfo = {
    id: 'proc-123',
    command: 'npm start',
    status: 'running',
    pid: 12345,
    startTime: '2023-01-01T00:00:00Z',
  };

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    
    client = new ProcessClient({
      baseUrl: 'http://test.com',
      port: 3000,
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const defaultClient = new ProcessClient();
      expect(defaultClient.getSessionId()).toBeNull();
    });

    it('should initialize with custom options', () => {
      const customClient = new ProcessClient({
        baseUrl: 'http://custom.com',
        port: 8080,
      });
      
      expect(customClient.getSessionId()).toBeNull();
    });
  });

  describe('startProcess', () => {
    const mockResponse: StartProcessResponse = {
      success: true,
      process: mockProcess,
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should start process successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.startProcess('npm start');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/process/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: 'npm start',
          processId: undefined,
        }),
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should start process with custom process ID', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.startProcess('npm start', { processId: 'custom-id' });

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/process/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: 'npm start',
          processId: 'custom-id',
        }),
      });
    });

    it('should start process with session ID', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.startProcess('npm start', { sessionId: 'session-123' });

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/process/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: 'npm start',
          processId: undefined,
          sessionId: 'session-123',
        }),
      });
    });

    it('should handle start process errors', async () => {
      const errorResponse = {
        error: 'Command not found',
        code: 'COMMAND_NOT_FOUND',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.startProcess('invalid-command')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });
  });

  describe('listProcesses', () => {
    const mockResponse: ListProcessesResponse = {
      success: true,
      processes: [mockProcess, { ...mockProcess, id: 'proc-456', command: 'npm test' }],
      count: 2,
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should list processes successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.listProcesses();

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/process/list', {
        method: 'GET',
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should handle list processes errors', async () => {
      const errorResponse = {
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 500 })
      );

      await expect(client.listProcesses()).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });
  });

  describe('getProcess', () => {
    const mockResponse: GetProcessResponse = {
      success: true,
      process: mockProcess,
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should get process successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.getProcess('proc-123');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/process/proc-123', {
        method: 'GET',
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should handle get process errors', async () => {
      const errorResponse = {
        error: 'Process not found',
        code: 'PROCESS_NOT_FOUND',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.getProcess('nonexistent')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });
  });

  describe('killProcess', () => {
    const mockResponse: KillProcessResponse = {
      success: true,
      message: 'Process killed successfully',
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should kill process successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.killProcess('proc-123');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/process/proc-123', {
        method: 'DELETE',
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should handle kill process errors', async () => {
      const errorResponse = {
        error: 'Process not found',
        code: 'PROCESS_NOT_FOUND',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.killProcess('nonexistent')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });
  });

  describe('killAllProcesses', () => {
    const mockResponse: KillAllProcessesResponse = {
      success: true,
      killedCount: 3,
      message: 'All processes killed successfully',
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should kill all processes successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.killAllProcesses();

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/process/kill-all', {
        method: 'DELETE',
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should handle kill all processes errors', async () => {
      const errorResponse = {
        error: 'Failed to kill processes',
        code: 'KILL_FAILED',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 500 })
      );

      await expect(client.killAllProcesses()).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });
  });

  describe('getProcessLogs', () => {
    const mockResponse: GetProcessLogsResponse = {
      success: true,
      processId: 'proc-123',
      stdout: 'Application started\nServer listening on port 3000\n',
      stderr: 'Warning: deprecated function used\n',
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should get process logs successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.getProcessLogs('proc-123');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/process/proc-123/logs', {
        method: 'GET',
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should handle get process logs errors', async () => {
      const errorResponse = {
        error: 'Process not found',
        code: 'PROCESS_NOT_FOUND',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.getProcessLogs('nonexistent')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });
  });

  describe('streamProcessLogs', () => {
    it('should stream process logs successfully', async () => {
      const mockStream = new ReadableStream();
      const mockResponse = new Response(mockStream, { status: 200 });
      fetchMock.mockResolvedValue(mockResponse);

      const result = await client.streamProcessLogs('proc-123');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/process/proc-123/stream', {
        method: 'GET',
      });

      expect(result).toBe(mockStream);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should handle stream process logs errors', async () => {
      const errorResponse = {
        error: 'Process not found',
        code: 'PROCESS_NOT_FOUND',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.streamProcessLogs('nonexistent')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });

    it('should handle response with no body', async () => {
      const mockResponse = new Response(null, { status: 200 });
      fetchMock.mockResolvedValue(mockResponse);

      await expect(client.streamProcessLogs('proc-123')).rejects.toThrow(
        'No response body for streaming'
      );
    });
  });
});