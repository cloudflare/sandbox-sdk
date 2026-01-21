import type {
  PtyCreateResult,
  PtyGetResult,
  PtyListResult
} from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyClient } from '../src/clients/pty-client';
import { WebSocketTransport } from '../src/clients/transport/ws-transport';

// Mock WebSocketTransport
vi.mock('../src/clients/transport/ws-transport', () => {
  return {
    WebSocketTransport: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      getMode: vi.fn().mockReturnValue('websocket'),
      fetch: vi.fn(),
      fetchStream: vi.fn(),
      sendMessage: vi.fn(),
      onStreamEvent: vi.fn().mockReturnValue(() => {})
    }))
  };
});

describe('PtyClient', () => {
  let client: PtyClient;
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockWebSocketTransport: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    isConnected: ReturnType<typeof vi.fn>;
    getMode: ReturnType<typeof vi.fn>;
    fetch: ReturnType<typeof vi.fn>;
    fetchStream: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    onStreamEvent: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    // Get reference to the mocked WebSocket transport
    mockWebSocketTransport = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      getMode: vi.fn().mockReturnValue('websocket'),
      fetch: vi.fn(),
      fetchStream: vi.fn(),
      sendMessage: vi.fn(),
      onStreamEvent: vi.fn().mockReturnValue(() => {})
    };

    (
      WebSocketTransport as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(() => mockWebSocketTransport);

    client = new PtyClient({
      baseUrl: 'http://test.com',
      port: 3000
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('create', () => {
    it('should create a PTY with default options', async () => {
      const mockResponse: PtyCreateResult = {
        success: true,
        pty: {
          id: 'pty_123',
          cols: 80,
          rows: 24,
          command: ['bash'],
          cwd: '/home/user',
          createdAt: '2023-01-01T00:00:00Z',
          state: 'running'
        },
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const pty = await client.create();

      expect(pty.id).toBe('pty_123');
      // Verify WebSocket was connected
      expect(mockWebSocketTransport.connect).toHaveBeenCalled();
      // Verify HTTP POST was made to create the PTY
      expect(mockFetch).toHaveBeenCalledWith(
        'http://test.com/api/pty',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        })
      );
    });

    it('should create a PTY with custom options', async () => {
      const mockResponse: PtyCreateResult = {
        success: true,
        pty: {
          id: 'pty_456',
          cols: 120,
          rows: 40,
          command: ['zsh'],
          cwd: '/workspace',
          createdAt: '2023-01-01T00:00:00Z',
          state: 'running'
        },
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const pty = await client.create({
        cols: 120,
        rows: 40,
        command: ['zsh'],
        cwd: '/workspace'
      });

      expect(pty.id).toBe('pty_456');
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.cols).toBe(120);
      expect(callBody.rows).toBe(40);
      expect(callBody.command).toEqual(['zsh']);
      expect(callBody.cwd).toBe('/workspace');
    });

    it('should handle creation errors', async () => {
      const errorResponse = {
        code: 'PTY_CREATE_ERROR',
        message: 'Failed to create PTY',
        context: {},
        httpStatus: 500,
        timestamp: new Date().toISOString()
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 500 })
      );

      await expect(client.create()).rejects.toThrow();
    });
  });

  describe('getById', () => {
    it('should get PTY by ID', async () => {
      const mockResponse: PtyGetResult = {
        success: true,
        pty: {
          id: 'pty_123',
          cols: 80,
          rows: 24,
          command: ['bash'],
          cwd: '/home/user',
          createdAt: '2023-01-01T00:00:00Z',
          state: 'running'
        },
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const pty = await client.getById('pty_123');

      expect(pty.id).toBe('pty_123');
      // Verify WebSocket was connected
      expect(mockWebSocketTransport.connect).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        'http://test.com/api/pty/pty_123',
        expect.objectContaining({
          method: 'GET'
        })
      );
    });

    it('should handle not found errors', async () => {
      const errorResponse = {
        code: 'PTY_NOT_FOUND',
        message: 'PTY not found',
        context: {},
        httpStatus: 404,
        timestamp: new Date().toISOString()
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.getById('nonexistent')).rejects.toThrow();
    });
  });

  describe('list', () => {
    it('should list all PTYs', async () => {
      const mockResponse: PtyListResult = {
        success: true,
        ptys: [
          {
            id: 'pty_1',
            cols: 80,
            rows: 24,
            command: ['bash'],
            cwd: '/home/user',
            createdAt: '2023-01-01T00:00:00Z',
            state: 'running'
          },
          {
            id: 'pty_2',
            cols: 120,
            rows: 40,
            command: ['zsh'],
            cwd: '/workspace',
            createdAt: '2023-01-01T00:00:01Z',
            state: 'exited',
            exitCode: 0
          }
        ],
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const ptys = await client.list();

      expect(ptys).toHaveLength(2);
      expect(ptys[0].id).toBe('pty_1');
      expect(ptys[1].id).toBe('pty_2');
      expect(ptys[1].exitCode).toBe(0);
    });

    it('should handle empty list', async () => {
      const mockResponse: PtyListResult = {
        success: true,
        ptys: [],
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const ptys = await client.list();

      expect(ptys).toHaveLength(0);
    });
  });

  describe('Pty handle operations', () => {
    const mockCreateResponse: PtyCreateResult = {
      success: true,
      pty: {
        id: 'pty_test',
        cols: 80,
        rows: 24,
        command: ['bash'],
        cwd: '/home/user',
        createdAt: '2023-01-01T00:00:00Z',
        state: 'running'
      },
      timestamp: '2023-01-01T00:00:00Z'
    };

    beforeEach(() => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockCreateResponse), { status: 200 })
      );
    });

    describe('write', () => {
      it('should send input via WebSocket sendMessage', async () => {
        const pty = await client.create();

        await pty.write('ls -la\n');

        expect(mockWebSocketTransport.sendMessage).toHaveBeenCalledWith({
          type: 'pty_input',
          ptyId: 'pty_test',
          data: 'ls -la\n'
        });
      });

      it('should throw when PTY is closed', async () => {
        const pty = await client.create();
        pty.close();

        await expect(pty.write('test')).rejects.toThrow('PTY is closed');
      });
    });

    describe('resize', () => {
      it('should resize PTY via WebSocket sendMessage', async () => {
        const pty = await client.create();

        await pty.resize(100, 30);

        expect(mockWebSocketTransport.sendMessage).toHaveBeenCalledWith({
          type: 'pty_resize',
          ptyId: 'pty_test',
          cols: 100,
          rows: 30
        });
      });

      it('should throw when PTY is closed', async () => {
        const pty = await client.create();
        pty.close();

        await expect(pty.resize(100, 30)).rejects.toThrow('PTY is closed');
      });
    });

    describe('kill', () => {
      it('should kill PTY with default signal', async () => {
        const pty = await client.create();

        // Mock transport.fetch to return success
        mockWebSocketTransport.fetch.mockResolvedValue(
          new Response('{}', { status: 200 })
        );

        await pty.kill();

        expect(mockWebSocketTransport.fetch).toHaveBeenCalledWith(
          '/api/pty/pty_test',
          expect.objectContaining({
            method: 'DELETE'
          })
        );
      });

      it('should kill PTY with custom signal', async () => {
        const pty = await client.create();

        // Mock transport.fetch to return success
        mockWebSocketTransport.fetch.mockResolvedValue(
          new Response('{}', { status: 200 })
        );

        await pty.kill('SIGKILL');

        expect(mockWebSocketTransport.fetch).toHaveBeenCalledWith(
          '/api/pty/pty_test',
          expect.objectContaining({
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ signal: 'SIGKILL' })
          })
        );
      });

      it('should throw error on HTTP failure', async () => {
        const pty = await client.create();

        // Mock transport.fetch to return error
        mockWebSocketTransport.fetch.mockResolvedValue(
          new Response('PTY not found', {
            status: 404,
            statusText: 'Not Found'
          })
        );

        await expect(pty.kill()).rejects.toThrow(
          'PTY kill failed: HTTP 404: PTY not found'
        );
      });
    });

    describe('onData', () => {
      it('should register data listener via onStreamEvent', async () => {
        const pty = await client.create();
        const callback = vi.fn();

        pty.onData(callback);

        expect(mockWebSocketTransport.onStreamEvent).toHaveBeenCalledWith(
          'pty_test',
          'pty_data',
          callback
        );
      });

      it('should return unsubscribe function', async () => {
        const pty = await client.create();
        const callback = vi.fn();
        const mockUnsub = vi.fn();
        mockWebSocketTransport.onStreamEvent.mockReturnValue(mockUnsub);

        const unsub = pty.onData(callback);
        unsub();

        expect(mockUnsub).toHaveBeenCalled();
      });
    });

    describe('onExit', () => {
      it('should register exit listener via onStreamEvent', async () => {
        const pty = await client.create();
        const callback = vi.fn();

        pty.onExit(callback);

        // onStreamEvent is called once in constructor for exited promise,
        // and once here for the explicit listener
        expect(mockWebSocketTransport.onStreamEvent).toHaveBeenCalledWith(
          'pty_test',
          'pty_exit',
          expect.any(Function)
        );
      });
    });

    describe('close', () => {
      it('should prevent write operations after close', async () => {
        const pty = await client.create();

        pty.close();

        await expect(pty.write('test')).rejects.toThrow('PTY is closed');
      });

      it('should prevent resize operations after close', async () => {
        const pty = await client.create();

        pty.close();

        await expect(pty.resize(100, 30)).rejects.toThrow('PTY is closed');
      });

      it('should warn when registering listeners after close', async () => {
        const pty = await client.create();

        pty.close();

        // These should return no-op functions without throwing
        const unsub1 = pty.onData(() => {});
        const unsub2 = pty.onExit(() => {});

        expect(typeof unsub1).toBe('function');
        expect(typeof unsub2).toBe('function');
      });
    });
  });

  describe('constructor options', () => {
    it('should initialize with minimal options', () => {
      const minimalClient = new PtyClient();
      expect(minimalClient).toBeDefined();
    });

    it('should initialize with full options', () => {
      const fullOptionsClient = new PtyClient({
        baseUrl: 'http://custom.com',
        port: 8080
      });
      expect(fullOptionsClient).toBeDefined();
    });
  });

  describe('disconnectPtyTransport', () => {
    it('should disconnect the WebSocket transport', async () => {
      // Create a PTY to initialize the transport
      const mockResponse: PtyCreateResult = {
        success: true,
        pty: {
          id: 'pty_123',
          cols: 80,
          rows: 24,
          command: ['bash'],
          cwd: '/home/user',
          createdAt: '2023-01-01T00:00:00Z',
          state: 'running'
        },
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.create();

      // Disconnect
      client.disconnectPtyTransport();

      expect(mockWebSocketTransport.disconnect).toHaveBeenCalled();
    });
  });

  describe('keepalive', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should start keepalive when first PTY is created', async () => {
      const mockResponse: PtyCreateResult = {
        success: true,
        pty: {
          id: 'pty_123',
          cols: 80,
          rows: 24,
          command: ['bash'],
          cwd: '/home/user',
          createdAt: '2023-01-01T00:00:00Z',
          state: 'running'
        },
        timestamp: '2023-01-01T00:00:00Z'
      };

      // First fetch is for creating PTY, subsequent ones are keepalive pings
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.create();

      // Keepalive sends an immediate ping
      expect(mockFetch).toHaveBeenCalledWith(
        'http://test.com/api/ping',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should send keepalive pings at regular intervals', async () => {
      const mockResponse: PtyCreateResult = {
        success: true,
        pty: {
          id: 'pty_123',
          cols: 80,
          rows: 24,
          command: ['bash'],
          cwd: '/home/user',
          createdAt: '2023-01-01T00:00:00Z',
          state: 'running'
        },
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.create();

      // Clear mock to only count keepalive pings
      const pingCalls = mockFetch.mock.calls.filter(
        (call) => call[0] === 'http://test.com/api/ping'
      );
      expect(pingCalls.length).toBe(1); // Initial immediate ping

      // Advance time by 5 minutes (keepalive interval)
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      const afterIntervalPingCalls = mockFetch.mock.calls.filter(
        (call) => call[0] === 'http://test.com/api/ping'
      );
      expect(afterIntervalPingCalls.length).toBe(2); // Initial + 1 interval
    });

    it('should stop keepalive when last PTY is closed', async () => {
      const mockResponse: PtyCreateResult = {
        success: true,
        pty: {
          id: 'pty_123',
          cols: 80,
          rows: 24,
          command: ['bash'],
          cwd: '/home/user',
          createdAt: '2023-01-01T00:00:00Z',
          state: 'running'
        },
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const pty = await client.create();

      // Close the PTY
      pty.close();

      // Clear mock calls
      mockFetch.mockClear();

      // Advance time by 5 minutes
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      // No keepalive pings should be sent after PTY is closed
      const pingCalls = mockFetch.mock.calls.filter(
        (call) => call[0] === 'http://test.com/api/ping'
      );
      expect(pingCalls.length).toBe(0);
    });

    it('should keep keepalive running with multiple PTYs', async () => {
      const mockResponse1: PtyCreateResult = {
        success: true,
        pty: {
          id: 'pty_1',
          cols: 80,
          rows: 24,
          command: ['bash'],
          cwd: '/home/user',
          createdAt: '2023-01-01T00:00:00Z',
          state: 'running'
        },
        timestamp: '2023-01-01T00:00:00Z'
      };

      const mockResponse2: PtyCreateResult = {
        success: true,
        pty: {
          id: 'pty_2',
          cols: 80,
          rows: 24,
          command: ['bash'],
          cwd: '/home/user',
          createdAt: '2023-01-01T00:00:01Z',
          state: 'running'
        },
        timestamp: '2023-01-01T00:00:01Z'
      };

      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify(mockResponse1), { status: 200 })
        )
        .mockResolvedValue(
          new Response(JSON.stringify(mockResponse2), { status: 200 })
        );

      const pty1 = await client.create();
      const pty2 = await client.create();

      // Close first PTY
      pty1.close();

      // Clear mock calls
      mockFetch.mockClear();

      // Advance time by 5 minutes
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      // Keepalive should still be running (pty2 is active)
      const pingCalls = mockFetch.mock.calls.filter(
        (call) => call[0] === 'http://test.com/api/ping'
      );
      expect(pingCalls.length).toBe(1);

      // Close second PTY
      pty2.close();

      // Clear mock calls
      mockFetch.mockClear();

      // Advance time by another 5 minutes
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      // No more keepalive pings
      const finalPingCalls = mockFetch.mock.calls.filter(
        (call) => call[0] === 'http://test.com/api/ping'
      );
      expect(finalPingCalls.length).toBe(0);
    });

    it('should stop keepalive when disconnectPtyTransport is called', async () => {
      const mockResponse: PtyCreateResult = {
        success: true,
        pty: {
          id: 'pty_123',
          cols: 80,
          rows: 24,
          command: ['bash'],
          cwd: '/home/user',
          createdAt: '2023-01-01T00:00:00Z',
          state: 'running'
        },
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.create();

      // Disconnect transport (simulating sandbox destroy)
      client.disconnectPtyTransport();

      // Clear mock calls
      mockFetch.mockClear();

      // Advance time by 5 minutes
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      // No keepalive pings should be sent
      const pingCalls = mockFetch.mock.calls.filter(
        (call) => call[0] === 'http://test.com/api/ping'
      );
      expect(pingCalls.length).toBe(0);
    });

    it('should handle keepalive ping failures gracefully', async () => {
      const mockResponse: PtyCreateResult = {
        success: true,
        pty: {
          id: 'pty_123',
          cols: 80,
          rows: 24,
          command: ['bash'],
          cwd: '/home/user',
          createdAt: '2023-01-01T00:00:00Z',
          state: 'running'
        },
        timestamp: '2023-01-01T00:00:00Z'
      };

      // First call succeeds (PTY create), then ping fails
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify(mockResponse), { status: 200 })
        )
        .mockRejectedValue(new Error('Network error'));

      // Should not throw
      const pty = await client.create();

      // The PTY handle should still be usable
      expect(pty.id).toBe('pty_123');
    });
  });
});
