import { describe, expect, it, vi } from 'vitest';
import { handleSessions } from '../../../src/bridge/handlers/sessions';

describe('handleSessions', () => {
  describe('create session', () => {
    it('should create session and return sessionId', async () => {
      const mockSandbox = {
        createSession: vi.fn().mockResolvedValue({
          id: 'session-abc123'
        })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/sessions',
        {
          method: 'POST',
          body: JSON.stringify({})
        }
      );

      const response = await handleSessions(request, mockSandbox as any, []);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.sessionId).toBe('session-abc123');
      expect(mockSandbox.createSession).toHaveBeenCalledWith(undefined);
    });

    it('should pass options to createSession', async () => {
      const mockSandbox = {
        createSession: vi.fn().mockResolvedValue({
          id: 'session-def456'
        })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/sessions',
        {
          method: 'POST',
          body: JSON.stringify({
            options: {
              cwd: '/workspace',
              env: { NODE_ENV: 'production' }
            }
          })
        }
      );

      const response = await handleSessions(request, mockSandbox as any, []);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.sessionId).toBe('session-def456');
      expect(mockSandbox.createSession).toHaveBeenCalledWith({
        cwd: '/workspace',
        env: { NODE_ENV: 'production' }
      });
    });
  });

  describe('delete session', () => {
    it('should delete session by ID', async () => {
      const mockSandbox = {
        deleteSession: vi.fn().mockResolvedValue({ success: true })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/sessions/session-abc123',
        {
          method: 'DELETE'
        }
      );

      const response = await handleSessions(request, mockSandbox as any, [
        'session-abc123'
      ]);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockSandbox.deleteSession).toHaveBeenCalledWith('session-abc123');
    });
  });

  describe('unknown endpoint', () => {
    it('should return 404 for unknown methods', async () => {
      const mockSandbox = {};

      const request = new Request(
        'https://example.com/api/sandbox/test/sessions'
      );

      const response = await handleSessions(request, mockSandbox as any, []);

      expect(response.status).toBe(404);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe('NOT_FOUND');
    });
  });
});
