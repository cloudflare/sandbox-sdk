import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import {
  type SandboxAPIDeps,
  SandboxControlAPI
} from '@sandbox-container/control-plane';
import type { GitService } from '@sandbox-container/services/git-service';

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

function buildApi(gitService: GitService): SandboxControlAPI {
  return new SandboxControlAPI({
    gitService,
    logger: mockLogger
  } as unknown as SandboxAPIDeps);
}

describe('SandboxControlAPI git.checkout', () => {
  let mockGitService: GitService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitService = {
      cloneRepository: vi.fn().mockResolvedValue({
        success: true,
        data: {
          path: '/workspace/repo',
          branch: 'main'
        }
      })
    } as unknown as GitService;
  });

  it('accepts checkout options as the second argument', async () => {
    const api = buildApi(mockGitService);

    const result = await api.git.checkout('https://github.com/test/repo.git', {
      sessionId: 'session-1',
      branch: 'main',
      targetDir: '/workspace/repo',
      depth: 1,
      timeoutMs: 90_000
    });

    expect(mockGitService.cloneRepository).toHaveBeenCalledWith(
      'https://github.com/test/repo.git',
      {
        sessionId: 'session-1',
        branch: 'main',
        targetDir: '/workspace/repo',
        depth: 1,
        timeoutMs: 90_000
      }
    );
    expect(result).toMatchObject({
      success: true,
      repoUrl: 'https://github.com/test/repo.git',
      branch: 'main',
      targetDir: '/workspace/repo'
    });
  });
});
