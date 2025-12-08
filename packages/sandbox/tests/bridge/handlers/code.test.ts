import { describe, expect, it, vi } from 'vitest';
import { handleCode } from '../../../src/bridge/handlers/code';

describe('handleCode', () => {
  describe('run', () => {
    it('should run code and return result', async () => {
      const mockSandbox = {
        runCode: vi.fn().mockResolvedValue({
          success: true,
          output: 'Hello, World!',
          exitCode: 0
        })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/code/run',
        {
          method: 'POST',
          body: JSON.stringify({ code: 'print("Hello, World!")' })
        }
      );

      const response = await handleCode(request, mockSandbox as any, ['run']);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.output).toBe('Hello, World!');
      expect(mockSandbox.runCode).toHaveBeenCalledWith(
        'print("Hello, World!")',
        undefined
      );
    });

    it('should pass options to runCode', async () => {
      const mockSandbox = {
        runCode: vi.fn().mockResolvedValue({
          success: true,
          output: '42',
          exitCode: 0
        })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/code/run',
        {
          method: 'POST',
          body: JSON.stringify({
            code: 'x = 42; print(x)',
            options: { language: 'python', timeout: 5000 }
          })
        }
      );

      await handleCode(request, mockSandbox as any, ['run']);

      expect(mockSandbox.runCode).toHaveBeenCalledWith('x = 42; print(x)', {
        language: 'python',
        timeout: 5000
      });
    });

    it('should return 400 for missing code', async () => {
      const mockSandbox = {};

      const request = new Request(
        'https://example.com/api/sandbox/test/code/run',
        {
          method: 'POST',
          body: JSON.stringify({})
        }
      );

      const response = await handleCode(request, mockSandbox as any, ['run']);

      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe('INVALID_REQUEST');
    });

    it('should return 405 for non-POST requests', async () => {
      const mockSandbox = {};

      const request = new Request(
        'https://example.com/api/sandbox/test/code/run'
      );

      const response = await handleCode(request, mockSandbox as any, ['run']);

      expect(response.status).toBe(405);
    });
  });

  describe('run/stream', () => {
    it('should return streaming response', async () => {
      const mockStream = new ReadableStream();
      const mockSandbox = {
        runCodeStream: vi.fn().mockResolvedValue(mockStream)
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/code/run/stream',
        {
          method: 'POST',
          body: JSON.stringify({ code: 'print("streaming")' })
        }
      );

      const response = await handleCode(request, mockSandbox as any, [
        'run',
        'stream'
      ]);

      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(mockSandbox.runCodeStream).toHaveBeenCalledWith(
        'print("streaming")',
        undefined
      );
    });
  });

  describe('contexts', () => {
    it('should create context', async () => {
      const mockSandbox = {
        createCodeContext: vi.fn().mockResolvedValue({
          contextId: 'ctx-123'
        })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/code/contexts',
        {
          method: 'POST',
          body: JSON.stringify({})
        }
      );

      const response = await handleCode(request, mockSandbox as any, [
        'contexts'
      ]);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.contextId).toBe('ctx-123');
    });

    it('should list contexts', async () => {
      const mockSandbox = {
        listCodeContexts: vi
          .fn()
          .mockResolvedValue([{ contextId: 'ctx-1' }, { contextId: 'ctx-2' }])
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/code/contexts'
      );

      const response = await handleCode(request, mockSandbox as any, [
        'contexts'
      ]);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.contexts).toHaveLength(2);
    });

    it('should delete context', async () => {
      const mockSandbox = {
        deleteCodeContext: vi.fn().mockResolvedValue(undefined)
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/code/contexts/ctx-123',
        {
          method: 'DELETE'
        }
      );

      const response = await handleCode(request, mockSandbox as any, [
        'contexts',
        'ctx-123'
      ]);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockSandbox.deleteCodeContext).toHaveBeenCalledWith('ctx-123');
    });
  });
});
