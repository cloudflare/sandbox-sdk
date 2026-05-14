import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { ServiceResult } from '@sandbox-container/core/types';
import {
  canonicalizeExecutionSessionId,
  ExecutionService,
  SESSIONLESS_SESSION_ID
} from '@sandbox-container/services/execution-service.js';
import type { SessionManager } from '@sandbox-container/services/session-manager';
import type { RawExecResult } from '@sandbox-container/session';
import { mocked } from '../test-utils';

const mockSessionManager = {
  executeInSession: vi.fn(),
  withSession: vi.fn(),
  executeStreamInSession: vi.fn(),
  killCommand: vi.fn()
} as unknown as SessionManager;

describe('ExecutionService', () => {
  let executionService: ExecutionService;

  beforeEach(() => {
    vi.clearAllMocks();
    executionService = new ExecutionService(mockSessionManager);
  });

  it('resolves the sentinel session ID to a sessionless target', () => {
    expect(
      executionService.resolveTarget({ sessionId: SESSIONLESS_SESSION_ID })
    ).toEqual({ mode: 'sessionless' });
    expect(
      executionService.resolveTarget({ sessionId: 'sessionless' })
    ).toEqual({ mode: 'sessionless' });
  });

  it('canonicalizes sessionless and fallback session inputs', () => {
    expect(
      canonicalizeExecutionSessionId({
        sessionId: SESSIONLESS_SESSION_ID,
        fallbackSessionId: 'default'
      })
    ).toBe(SESSIONLESS_SESSION_ID);

    expect(
      canonicalizeExecutionSessionId({
        sessionId: 'sessionless',
        fallbackSessionId: 'default'
      })
    ).toBe(SESSIONLESS_SESSION_ID);

    expect(
      canonicalizeExecutionSessionId({
        sessionId: undefined,
        fallbackSessionId: 'session-123'
      })
    ).toBe('session-123');

    expect(canonicalizeExecutionSessionId({})).toBe('default');
  });

  it('routes explicit session targets through SessionManager', async () => {
    mocked(mockSessionManager.executeInSession).mockResolvedValue({
      success: true,
      data: {
        stdout: 'ok\n',
        stderr: '',
        exitCode: 0,
        command: 'echo ok',
        duration: 1,
        timestamp: new Date().toISOString()
      }
    } as ServiceResult<RawExecResult>);

    const result = await executionService.execute('echo ok', {
      sessionId: 'session-123',
      cwd: '/tmp'
    });

    expect(result.success).toBe(true);
    expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
      'session-123',
      'echo ok',
      {
        cwd: '/tmp',
        timeoutMs: undefined,
        env: undefined,
        origin: undefined
      }
    );
  });

  it('routes sentinel session IDs through the one-shot backend', async () => {
    const result = await executionService.execute('printf sessionless', {
      sessionId: SESSIONLESS_SESSION_ID
    });

    expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stdout).toBe('sessionless');
      expect(result.data.exitCode).toBe(0);
    }
  });

  it('streams sessionless commands without SessionManager', async () => {
    const events: Array<{ type: string; data?: string; exitCode?: number }> =
      [];

    const result = await executionService.executeStream(
      'printf streamed-output',
      async (event) => {
        events.push({
          type: event.type,
          data: event.data,
          exitCode: event.exitCode
        });
      },
      {
        sessionId: SESSIONLESS_SESSION_ID,
        commandId: 'cmd-1'
      }
    );

    expect(result.success).toBe(true);
    expect(mockSessionManager.executeStreamInSession).not.toHaveBeenCalled();
    if (result.success) {
      expect(result.data.commandHandle).toEqual({
        mode: 'sessionless',
        pid: expect.any(Number)
      });
      await result.data.continueStreaming;
    }

    expect(events[0]?.type).toBe('start');
    expect(events.some((event) => event.type === 'stdout')).toBe(true);
    expect(events.find((event) => event.type === 'stdout')?.data).toBe(
      'streamed-output'
    );
    expect(events[events.length - 1]?.type).toBe('complete');
    expect(events[events.length - 1]?.exitCode).toBe(0);
  });
});
