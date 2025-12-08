import { describe, expect, it, vi } from 'vitest';
import { handleGit } from '../../../src/bridge/handlers/git';

describe('handleGit', () => {
  describe('checkout', () => {
    it('should checkout repository', async () => {
      const mockSandbox = {
        gitCheckout: vi.fn().mockResolvedValue({
          success: true,
          directory: '/workspace/repo',
          branch: 'main'
        })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/git/checkout',
        {
          method: 'POST',
          body: JSON.stringify({ repoUrl: 'https://github.com/owner/repo.git' })
        }
      );

      const response = await handleGit(request, mockSandbox as any, [
        'checkout'
      ]);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockSandbox.gitCheckout).toHaveBeenCalledWith(
        'https://github.com/owner/repo.git',
        {}
      );
    });

    it('should pass options to gitCheckout', async () => {
      const mockSandbox = {
        gitCheckout: vi.fn().mockResolvedValue({
          success: true,
          directory: '/workspace/custom',
          branch: 'develop'
        })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/git/checkout',
        {
          method: 'POST',
          body: JSON.stringify({
            repoUrl: 'https://github.com/owner/repo.git',
            options: {
              branch: 'develop',
              targetDir: '/workspace/custom'
            }
          })
        }
      );

      const response = await handleGit(request, mockSandbox as any, [
        'checkout'
      ]);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.branch).toBe('develop');
      expect(mockSandbox.gitCheckout).toHaveBeenCalledWith(
        'https://github.com/owner/repo.git',
        { branch: 'develop', targetDir: '/workspace/custom' }
      );
    });

    it('should return 400 for missing repoUrl', async () => {
      const mockSandbox = {};

      const request = new Request(
        'https://example.com/api/sandbox/test/git/checkout',
        {
          method: 'POST',
          body: JSON.stringify({})
        }
      );

      const response = await handleGit(request, mockSandbox as any, [
        'checkout'
      ]);

      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe('INVALID_REQUEST');
    });

    it('should return 405 for non-POST requests', async () => {
      const mockSandbox = {};

      const request = new Request(
        'https://example.com/api/sandbox/test/git/checkout'
      );

      const response = await handleGit(request, mockSandbox as any, [
        'checkout'
      ]);

      expect(response.status).toBe(405);
    });
  });

  describe('unknown action', () => {
    it('should return 404 for unknown actions', async () => {
      const mockSandbox = {};

      const request = new Request(
        'https://example.com/api/sandbox/test/git/unknown',
        {
          method: 'POST'
        }
      );

      const response = await handleGit(request, mockSandbox as any, [
        'unknown'
      ]);

      expect(response.status).toBe(404);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe('NOT_FOUND');
    });
  });
});
