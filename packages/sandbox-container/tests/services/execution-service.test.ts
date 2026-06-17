import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { StatelessProcessRunner } from '@repo/sandbox-execution';
import type { Logger } from '@repo/shared';
import { DISABLE_SESSION_TOKEN } from '@repo/shared/internal';
import type { ServiceResult } from '@sandbox-container/core/types';
import { ExecutionService } from '@sandbox-container/services/execution-service';
import type { SessionManager } from '@sandbox-container/services/session-manager';
import type { RawExecResult } from '@sandbox-container/session-types';
import { mocked } from '../test-utils';

type SessionExec = (
  command: string,
  options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    origin?: 'user' | 'internal';
  }
) => Promise<RawExecResult>;

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
  startProcessStreamInSession: vi.fn(),
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

  it('runs missing-session execution without persistent shell state', async () => {
    const first = await executionService.execute(
      'cd /tmp && export SANDBOX_STATE=leaked',
      { cwd: process.cwd() }
    );
    const second = await executionService.execute(
      'printf "%s:%s" "$PWD" "$SANDBOX_STATE"',
      { cwd: process.cwd() }
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (second.success) {
      expect(second.data.stdout).toBe(`${process.cwd()}:`);
    }
    expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
  });

  it('runs sessionless execute without calling SessionManager', async () => {
    const result = await executionService.execute(
      'printf "hello"; printf "warn" >&2; exit 7',
      { sessionId: DISABLE_SESSION_TOKEN, cwd: process.cwd() }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stdout).toBe('hello');
      expect(result.data.stderr).toBe('warn');
      expect(result.data.exitCode).toBe(7);
    }
    expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
  });

  it('terminates timed-out sessionless execution and returns the timeout exit code', async () => {
    const result = await executionService.execute('sleep 1', {
      sessionId: DISABLE_SESSION_TOKEN,
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

  it('inherits outer env and timeout in sessionless withExecution calls', async () => {
    const result = await executionService.withExecution(
      {
        sessionId: DISABLE_SESSION_TOKEN,
        cwd: process.cwd(),
        env: { OUTER_TEST_ENV: 'from-outer' },
        timeoutMs: 500,
        origin: 'internal'
      },
      async (exec) => {
        const envResult = await exec('printf "$OUTER_TEST_ENV"');
        const timeoutResult = await exec('sleep 1');

        return {
          envStdout: envResult.stdout,
          timeoutExitCode: timeoutResult.exitCode,
          timeoutStderr: timeoutResult.stderr
        };
      }
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.envStdout).toBe('from-outer');
    expect(result.data.timeoutExitCode).toBe(124);
    expect(result.data.timeoutStderr).toContain(
      'Command timed out after 500ms'
    );
    expect(mockSessionManager.withSession).not.toHaveBeenCalled();
  });

  it('inherits outer env, timeout, and origin in session-backed withExecution calls', async () => {
    const exec = vi.fn(
      async (
        command: string,
        _options?: Parameters<SessionExec>[1]
      ): Promise<RawExecResult> => ({
        command,
        stdout: '',
        stderr: '',
        exitCode: 0,
        duration: 1,
        timestamp: new Date().toISOString()
      })
    );

    mocked(mockSessionManager.withSession).mockImplementation(
      async <T>(
        _sessionId: string,
        fn: (wrappedExec: SessionExec) => Promise<T>,
        cwd?: string
      ): Promise<ServiceResult<T>> => {
        expect(cwd).toBe('/workspace/outer');
        const result = await fn(exec as SessionExec);
        return {
          success: true,
          data: result
        } as ServiceResult<T>;
      }
    );

    const result = await executionService.withExecution(
      {
        sessionId: 'session-123',
        cwd: '/workspace/outer',
        env: { OUTER_TEST_ENV: 'from-outer' },
        timeoutMs: 5000,
        origin: 'internal'
      },
      async (wrappedExec) => {
        await wrappedExec('printf inherited');
        await wrappedExec('printf overridden', {
          cwd: '/workspace/override',
          env: { OUTER_TEST_ENV: 'from-inner' },
          timeoutMs: 25,
          origin: 'user'
        });
      }
    );

    expect(result.success).toBe(true);
    expect(mockSessionManager.withSession).toHaveBeenCalledWith(
      'session-123',
      expect.any(Function),
      '/workspace/outer'
    );
    expect(exec).toHaveBeenNthCalledWith(1, 'printf inherited', {
      env: { OUTER_TEST_ENV: 'from-outer' },
      timeoutMs: 5000,
      origin: 'internal'
    });
    expect(exec).toHaveBeenNthCalledWith(2, 'printf overridden', {
      cwd: '/workspace/override',
      env: { OUTER_TEST_ENV: 'from-inner' },
      timeoutMs: 25,
      origin: 'user'
    });
  });

  it('lets nested sessionless withExecution options override inherited defaults', async () => {
    const result = await executionService.withExecution(
      {
        sessionId: DISABLE_SESSION_TOKEN,
        cwd: process.cwd(),
        env: { OUTER_TEST_ENV: 'from-outer' },
        timeoutMs: 1000,
        origin: 'internal'
      },
      async (exec) => {
        const envResult = await exec('printf "$OUTER_TEST_ENV"', {
          env: { OUTER_TEST_ENV: 'from-inner' }
        });
        const timeoutResult = await exec('sleep 1', {
          timeoutMs: 50
        });

        return {
          envStdout: envResult.stdout,
          timeoutExitCode: timeoutResult.exitCode,
          timeoutStderr: timeoutResult.stderr
        };
      }
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.envStdout).toBe('from-inner');
    expect(result.data.timeoutExitCode).toBe(124);
    expect(result.data.timeoutStderr).toContain('Command timed out after 50ms');
    expect(mockSessionManager.withSession).not.toHaveBeenCalled();
  });

  it('routes session process streaming as a background process', async () => {
    mocked(mockSessionManager.startProcessStreamInSession).mockResolvedValue({
      success: true,
      data: { continueStreaming: Promise.resolve() }
    });

    const result = await executionService.startProcessStream('sleep 10', {
      sessionId: 'explicit-session',
      cwd: '/workspace/app',
      timeoutMs: 5000,
      env: { TEST_ENV: '1' },
      origin: 'user',
      commandId: 'process-command',
      onEvent: async () => {}
    });

    expect(result.success).toBe(true);
    expect(mockSessionManager.startProcessStreamInSession).toHaveBeenCalledWith(
      'explicit-session',
      'sleep 10',
      expect.any(Function),
      {
        cwd: '/workspace/app',
        env: { TEST_ENV: '1' },
        timeoutMs: 5000,
        origin: 'user'
      },
      'process-command'
    );
  });

  it('streams sessionless output events and completion through the execution package', async () => {
    const events: Array<{ type: string; data?: string; exitCode?: number }> =
      [];
    const startSpy = vi.spyOn(StatelessProcessRunner.prototype, 'start');

    const result = await executionService.startProcessStream(
      'printf "hello"; printf "warn" >&2',
      {
        sessionId: DISABLE_SESSION_TOKEN,
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

    expect(startSpy).toHaveBeenCalledWith(
      'printf "hello"; printf "warn" >&2',
      expect.objectContaining({
        cwd: process.cwd(),
        timeoutMs: undefined,
        env: undefined,
        onOutput: expect.any(Function)
      })
    );
    expect(result.data.commandHandle.sessionId).toBe(DISABLE_SESSION_TOKEN);
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
    expect(
      mockSessionManager.startProcessStreamInSession
    ).not.toHaveBeenCalled();
  });

  it('kills a sessionless streaming process by pid', async () => {
    const events: Array<{ type: string; exitCode?: number }> = [];

    const result = await executionService.startProcessStream('sleep 30', {
      sessionId: DISABLE_SESSION_TOKEN,
      cwd: process.cwd(),
      commandId: 'cmd-kill',
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
