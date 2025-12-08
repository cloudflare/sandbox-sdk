import { describe, expect, it, vi } from 'vitest';
import { handleExec } from '../../../src/bridge/handlers/exec';

describe('handleExec', () => {
  it('should execute command and return result', async () => {
    const mockSandbox = {
      exec: vi.fn().mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: 'hello\n',
        stderr: '',
        command: 'echo hello',
        duration: 50
      })
    };

    const request = new Request('https://example.com/api/sandbox/test/exec', {
      method: 'POST',
      body: JSON.stringify({ command: 'echo hello' })
    });

    const response = await handleExec(request, mockSandbox as any);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.stdout).toBe('hello\n');
    expect(mockSandbox.exec).toHaveBeenCalledWith('echo hello', undefined);
  });

  it('should pass options to exec', async () => {
    const mockSandbox = {
      exec: vi.fn().mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
        command: 'ls',
        duration: 10
      })
    };

    const request = new Request('https://example.com/api/sandbox/test/exec', {
      method: 'POST',
      body: JSON.stringify({
        command: 'ls',
        options: { timeout: 5000, cwd: '/workspace' }
      })
    });

    await handleExec(request, mockSandbox as any);

    expect(mockSandbox.exec).toHaveBeenCalledWith('ls', {
      timeout: 5000,
      cwd: '/workspace'
    });
  });

  it('should use session if provided', async () => {
    const mockSession = {
      exec: vi.fn().mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
        command: 'pwd',
        duration: 5
      })
    };

    const mockSandbox = {
      getSession: vi.fn().mockResolvedValue(mockSession)
    };

    const request = new Request('https://example.com/api/sandbox/test/exec', {
      method: 'POST',
      body: JSON.stringify({
        command: 'pwd',
        sessionId: 'user-123'
      })
    });

    await handleExec(request, mockSandbox as any);

    expect(mockSandbox.getSession).toHaveBeenCalledWith('user-123');
    expect(mockSession.exec).toHaveBeenCalledWith('pwd', undefined);
  });

  it('should return 400 for missing command', async () => {
    const mockSandbox = {};

    const request = new Request('https://example.com/api/sandbox/test/exec', {
      method: 'POST',
      body: JSON.stringify({})
    });

    const response = await handleExec(request, mockSandbox as any);

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('INVALID_REQUEST');
  });
});
