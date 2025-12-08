import { describe, expect, it, vi } from 'vitest';
import { handleFiles } from '../../../src/bridge/handlers/files';

describe('handleFiles', () => {
  describe('write', () => {
    it('should write file and return result', async () => {
      const mockSandbox = {
        writeFile: vi
          .fn()
          .mockResolvedValue({ success: true, path: '/test.txt' })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/files/write',
        {
          method: 'POST',
          body: JSON.stringify({ path: '/test.txt', content: 'hello' })
        }
      );

      const response = await handleFiles(request, mockSandbox as any, [
        'write'
      ]);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockSandbox.writeFile).toHaveBeenCalledWith(
        '/test.txt',
        'hello',
        undefined
      );
    });
  });

  describe('read', () => {
    it('should read file and return content', async () => {
      const mockSandbox = {
        readFile: vi
          .fn()
          .mockResolvedValue({ content: 'file content', path: '/test.txt' })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/files/read?path=/test.txt'
      );

      const response = await handleFiles(request, mockSandbox as any, ['read']);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.content).toBe('file content');
    });
  });

  describe('mkdir', () => {
    it('should create directory', async () => {
      const mockSandbox = {
        mkdir: vi.fn().mockResolvedValue({ success: true, path: '/newdir' })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/files/mkdir',
        {
          method: 'POST',
          body: JSON.stringify({
            path: '/newdir',
            options: { recursive: true }
          })
        }
      );

      const response = await handleFiles(request, mockSandbox as any, [
        'mkdir'
      ]);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockSandbox.mkdir).toHaveBeenCalledWith('/newdir', {
        recursive: true
      });
    });
  });

  describe('delete', () => {
    it('should delete file', async () => {
      const mockSandbox = {
        deleteFile: vi.fn().mockResolvedValue({ success: true })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/files/delete',
        {
          method: 'POST',
          body: JSON.stringify({ path: '/test.txt' })
        }
      );

      const response = await handleFiles(request, mockSandbox as any, [
        'delete'
      ]);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  describe('list', () => {
    it('should list files in directory', async () => {
      const mockSandbox = {
        listFiles: vi.fn().mockResolvedValue({ files: ['a.txt', 'b.txt'] })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/files/list?path=/dir'
      );

      const response = await handleFiles(request, mockSandbox as any, ['list']);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.files).toEqual(['a.txt', 'b.txt']);
    });
  });

  describe('exists', () => {
    it('should check if file exists', async () => {
      const mockSandbox = {
        exists: vi.fn().mockResolvedValue({ exists: true })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/files/exists?path=/test.txt'
      );

      const response = await handleFiles(request, mockSandbox as any, [
        'exists'
      ]);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.exists).toBe(true);
    });
  });
});
