import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import type { ServiceResult } from '@sandbox-container/core/types';
import { ExecutionService } from '@sandbox-container/services/execution-service';
import type { SessionManager } from '@sandbox-container/services/session-manager';
import type { RawExecResult } from '@sandbox-container/session';
import { mocked } from '../test-utils';

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

const mockSessionManager = {
  executeInSession: vi.fn(),
  executeStreamInSession: vi.fn(),
  withSession: vi.fn(),
  killCommand: vi.fn()
} as unknown as SessionManager;

describe('ExecutionService', () => {
  let executionService: ExecutionService;

  beforeEach(() => {
    vi.clearAllMocks();
    executionService = new ExecutionService(mockSessionManager, mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes ordinary session execution to SessionManager', async () => {
    mocked(mockSessionManager.executeInSession).mockResolvedValue({
      success: true,
      data: {
        command: 'echo test',
        stdout: 'test\n',
        stderr: '',
        exitCode: 0,
        duration: 1,
        timestamp: new Date().toISOString()
      }
    } as ServiceResult<RawExecResult>);

    const result = await executionService.execute('echo test', {
      sessionId: 'session-123',
      cwd: '/workspace/app',
      timeoutMs: 5000,
      env: { TEST_ENV: '1' },
      origin: 'user'
    });

    expect(result.success).toBe(true);
    expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
      'session-123',
      'echo test',
      {
        cwd: '/workspace/app',
        timeoutMs: 5000,
        env: { TEST_ENV: '1' },
        origin: 'user'
      }
    );
  });

  it('canonicalizes a missing sessionId to default', async () => {
    mocked(mockSessionManager.executeInSession).mockResolvedValue({
      success: true,
      data: {
        command: 'pwd',
        stdout: '/workspace\n',
        stderr: '',
        exitCode: 0,
        duration: 1,
        timestamp: new Date().toISOString()
      }
    } as ServiceResult<RawExecResult>);

    const result = await executionService.execute('pwd');

    expect(result.success).toBe(true);
    expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
      'default',
      'pwd',
      {
        cwd: undefined,
        timeoutMs: undefined,
        env: undefined,
        origin: undefined
      }
    );
  });

  it('runs sessionless execute without calling SessionManager', async () => {
    const result = await executionService.execute(
      'printf "hello"; printf "warn" >&2; exit 7',
      { sessionId: 'none', cwd: process.cwd() }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stdout).toBe('hello');
      expect(result.data.stderr).toBe('warn');
      expect(result.data.exitCode).toBe(7);
    }
    expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
  });

  it('times out sessionless execution and returns the timeout exit code', async () => {
    const result = await executionService.execute('sleep 1', {
      sessionId: 'none',
      cwd: process.cwd(),
      timeoutMs: 50
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.exitCode).toBe(124);
      expect(result.data.stderr).toContain('Command timed out after 50ms');
    }
    expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
  });

  it('streams sessionless output events and completion', async () => {
    const events: Array<{ type: string; data?: string; exitCode?: number }> =
      [];

    const result = await executionService.executeStream(
      'printf "hello"; printf "warn" >&2',
      {
        sessionId: 'none',
        cwd: process.cwd(),
        commandId: 'cmd-1',
        onEvent: async (event) => {
          events.push({
            type: event.type,
            data: 'data' in event ? event.data : undefined,
            exitCode: 'exitCode' in event ? event.exitCode : undefined
          });
        }
      }
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.commandHandle.sessionId).toBe('none');
    expect(result.data.commandHandle.commandId).toBe('cmd-1');
    expect(result.data.commandHandle.pid).toBeDefined();

    await result.data.continueStreaming;

    expect(events[0]?.type).toBe('start');
    expect(
      events.some((event) => event.type === 'stdout' && event.data === 'hello')
    ).toBe(true);
    expect(
      events.some((event) => event.type === 'stderr' && event.data === 'warn')
    ).toBe(true);
    expect(
      events.some((event) => event.type === 'complete' && event.exitCode === 0)
    ).toBe(true);
    expect(mockSessionManager.executeStreamInSession).not.toHaveBeenCalled();
  });

  it('kills a sessionless streaming process by pid', async () => {
    const events: Array<{ type: string; exitCode?: number }> = [];

    const result = await executionService.executeStream('sleep 30', {
      sessionId: 'none',
      cwd: process.cwd(),
      commandId: 'cmd-kill',
      background: true,
      onEvent: async (event) => {
        events.push({
          type: event.type,
          exitCode: 'exitCode' in event ? event.exitCode : undefined
        });
      }
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    const killResult = await executionService.kill(result.data.commandHandle);
    expect(killResult.success).toBe(true);

    await result.data.continueStreaming;

    expect(events[0]?.type).toBe('start');
    expect(events.some((event) => event.type === 'complete')).toBe(true);
    expect(mockSessionManager.killCommand).not.toHaveBeenCalled();
  });
});
