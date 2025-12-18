import type {
  PtyCreateResult,
  PtyGetResult,
  PtyKillResult,
  PtyListResult
} from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyClient } from '../src/clients/pty-client';
import { SandboxError } from '../src/errors';

describe('PtyClient', () => {
  let client: PtyClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

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

      await expect(client.create()).rejects.toThrow(SandboxError);
    });
  });

  describe('attach', () => {
    it('should attach PTY to existing session', async () => {
      const mockResponse: PtyCreateResult = {
        success: true,
        pty: {
          id: 'pty_789',
          sessionId: 'session_abc',
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

      const pty = await client.attach('session_abc');

      expect(pty.id).toBe('pty_789');
      expect(pty.sessionId).toBe('session_abc');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://test.com/api/pty/attach/session_abc',
        expect.objectContaining({
          method: 'POST'
        })
      );
    });

    it('should attach PTY with custom dimensions', async () => {
      const mockResponse: PtyCreateResult = {
        success: true,
        pty: {
          id: 'pty_999',
          sessionId: 'session_xyz',
          cols: 100,
          rows: 30,
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

      const pty = await client.attach('session_xyz', { cols: 100, rows: 30 });

      expect(pty.id).toBe('pty_999');
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.cols).toBe(100);
      expect(callBody.rows).toBe(30);
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
    beforeEach(() => {
      // Setup default create response
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

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockCreateResponse), { status: 200 })
      );
    });

    describe('write', () => {
      it('should send input via HTTP POST', async () => {
        const pty = await client.create();

        // Reset mock after create
        mockFetch.mockClear();
        mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

        pty.write('ls -la\n');

        // Wait for the async operation
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mockFetch).toHaveBeenCalledWith(
          'http://test.com/api/pty/pty_test/input',
          expect.objectContaining({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: 'ls -la\n' })
          })
        );
      });
    });

    describe('resize', () => {
      it('should resize PTY via HTTP POST', async () => {
        const pty = await client.create();

        // Reset mock after create
        mockFetch.mockClear();
        mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

        pty.resize(100, 30);

        // Wait for the async operation
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mockFetch).toHaveBeenCalledWith(
          'http://test.com/api/pty/pty_test/resize',
          expect.objectContaining({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cols: 100, rows: 30 })
          })
        );
      });
    });

    describe('kill', () => {
      it('should kill PTY with default signal', async () => {
        const pty = await client.create();

        // Reset mock after create
        mockFetch.mockClear();
        const mockKillResponse: PtyKillResult = {
          success: true,
          ptyId: 'pty_test',
          timestamp: '2023-01-01T00:00:00Z'
        };
        mockFetch.mockResolvedValue(
          new Response(JSON.stringify(mockKillResponse), { status: 200 })
        );

        await pty.kill();

        expect(mockFetch).toHaveBeenCalledWith(
          'http://test.com/api/pty/pty_test',
          expect.objectContaining({
            method: 'DELETE'
          })
        );
      });

      it('should kill PTY with custom signal', async () => {
        const pty = await client.create();

        // Reset mock after create
        mockFetch.mockClear();
        const mockKillResponse: PtyKillResult = {
          success: true,
          ptyId: 'pty_test',
          timestamp: '2023-01-01T00:00:00Z'
        };
        mockFetch.mockResolvedValue(
          new Response(JSON.stringify(mockKillResponse), { status: 200 })
        );

        await pty.kill('SIGKILL');

        expect(mockFetch).toHaveBeenCalledWith(
          'http://test.com/api/pty/pty_test',
          expect.objectContaining({
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ signal: 'SIGKILL' })
          })
        );
      });
    });

    describe('close', () => {
      it('should prevent operations after close', async () => {
        const pty = await client.create();

        // Reset mock after create
        mockFetch.mockClear();

        pty.close();

        // These should not trigger any fetch calls
        pty.write('test');
        pty.resize(100, 30);

        // Wait to ensure no async operations
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(mockFetch).not.toHaveBeenCalled();
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
});
