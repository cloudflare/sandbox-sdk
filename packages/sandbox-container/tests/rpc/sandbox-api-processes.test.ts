import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import {
  type SandboxAPIDeps,
  SandboxControlAPI
} from '@sandbox-container/control-plane';
import type { ProcessService } from '@sandbox-container/services/process-service';

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

function buildApi(processService: ProcessService): SandboxControlAPI {
  return new SandboxControlAPI({
    processService,
    logger: mockLogger
  } as unknown as SandboxAPIDeps);
}

describe('SandboxControlAPI processes.startProcess', () => {
  let mockProcessService: ProcessService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessService = {
      startProcess: vi.fn().mockResolvedValue({
        success: true,
        data: {
          id: 'proc-1',
          pid: 1234,
          command: 'sleep 10',
          status: 'running',
          startTime: new Date('2026-01-01T00:00:00.000Z')
        }
      })
    } as unknown as ProcessService;
  });

  it('accepts process options as the second argument', async () => {
    const api = buildApi(mockProcessService);

    const result = await api.processes.startProcess('sleep 10', {
      sessionId: 'session-1',
      processId: 'proc-1',
      timeoutMs: 1000,
      env: { TEST_ENV: '1' },
      cwd: '/workspace/app',
      encoding: 'utf8',
      autoCleanup: false
    });

    expect(mockProcessService.startProcess).toHaveBeenCalledWith('sleep 10', {
      sessionId: 'session-1',
      processId: 'proc-1',
      timeoutMs: 1000,
      env: { TEST_ENV: '1' },
      cwd: '/workspace/app',
      encoding: 'utf8',
      autoCleanup: false
    });
    expect(result).toEqual({
      success: true,
      processId: 'proc-1',
      pid: 1234,
      command: 'sleep 10',
      timestamp: '2026-01-01T00:00:00.000Z'
    });
  });
});
