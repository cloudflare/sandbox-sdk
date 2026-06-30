import { describe, expect, it, vi } from 'vitest';
import {
  GitCloneError,
  GitNetworkError,
  InvalidGitUrlError
} from '../src/errors';
import type { SandboxLike } from '../src/extensions';
import { Git, withGit } from '../src/git';
import {
  buildCloneArgs,
  determineErrorCode,
  generateTargetDirectory,
  gitCloneTimeoutSeconds,
  parseBranchList,
  validateGitUrl,
  validatePath
} from '../src/git/manager';

type ExecResult = { stdout: string; stderr: string; exitCode: number };

function createGit(
  execImpl: (command: string, options?: unknown) => ExecResult,
  envVars?: Record<string, string>,
  registerGitAuthInterceptor?: SandboxLike['registerGitAuthInterceptor']
) {
  const execute = vi.fn(async (command: string, options?: unknown) =>
    execImpl(command, options)
  );
  const sandbox = {
    client: { commands: { execute } },
    envVars,
    registerGitAuthInterceptor
  } as unknown as SandboxLike;
  return { git: withGit(sandbox), execute };
}

describe('git manager (pure logic)', () => {
  it('builds a timeout-wrapped clone command with blob filter', () => {
    const args = buildCloneArgs(
      'https://github.com/owner/repo.git',
      '/workspace/repo'
    );
    // Default clone timeout is 600s (600000ms).
    expect(args.slice(0, 5)).toEqual(['timeout', '-k', '5', '600', 'git']);
    expect(args).toContain('--filter=blob:none');
    expect(args).toContain('clone');
    expect(args.slice(-2)).toEqual([
      'https://github.com/owner/repo.git',
      '/workspace/repo'
    ]);
  });

  it('adds branch and depth flags when provided', () => {
    const args = buildCloneArgs('https://x/y.git', '/workspace/y', {
      branch: 'dev',
      depth: 1
    });
    expect(args).toContain('--branch');
    expect(args).toContain('dev');
    expect(args).toContain('--depth');
    expect(args).toContain('1');
  });

  it('derives the default target directory from the repo URL', () => {
    expect(generateTargetDirectory('https://github.com/owner/repo.git')).toBe(
      '/workspace/repo'
    );
  });

  it('formats clone timeout seconds without trailing zeros', () => {
    expect(gitCloneTimeoutSeconds(120_000)).toBe('120');
    expect(gitCloneTimeoutSeconds(1_500)).toBe('1.5');
  });

  it('parses and deduplicates branch listings', () => {
    const stdout = [
      '* main',
      '  feature',
      '  remotes/origin/main',
      '  remotes/origin/HEAD -> origin/main'
    ].join('\n');
    expect(parseBranchList(stdout)).toEqual(['main', 'feature']);
  });

  it('classifies error codes from exit codes and stderr', () => {
    expect(determineErrorCode('clone', 'timed out', 124)).toBe(
      'GIT_NETWORK_ERROR'
    );
    expect(determineErrorCode('clone', 'repository not found', 128)).toBe(
      'GIT_REPOSITORY_NOT_FOUND'
    );
    expect(determineErrorCode('clone', 'boom', 1)).toBe('GIT_CLONE_FAILED');
    expect(determineErrorCode('checkout', 'boom', 1)).toBe(
      'GIT_CHECKOUT_FAILED'
    );
  });

  it('validates url and path format', () => {
    expect(validateGitUrl('https://x/y.git').isValid).toBe(true);
    expect(validateGitUrl('').isValid).toBe(false);
    expect(validateGitUrl('a\0b').isValid).toBe(false);
    expect(validatePath('/workspace/repo').isValid).toBe(true);
    expect(validatePath('a\0b').isValid).toBe(false);
  });
});

describe('Git extension', () => {
  it('is constructed via withGit', () => {
    const { git } = createGit(() => ({ stdout: '', stderr: '', exitCode: 0 }));
    expect(git).toBeInstanceOf(Git);
  });

  it('clones and reports the checked-out branch', async () => {
    const { git, execute } = createGit((command) => {
      if (command.includes('--show-current')) {
        return { stdout: 'main\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await git.checkout('https://github.com/owner/repo.git');

    expect(result.success).toBe(true);
    expect(result.branch).toBe('main');
    expect(result.targetDir).toBe('/workspace/repo');
    // Sessionless by default.
    expect(execute.mock.calls[0][1]).toBeUndefined();
  });

  it('runs in the provided session and target dir', async () => {
    const { git, execute } = createGit(() => ({
      stdout: 'main\n',
      stderr: '',
      exitCode: 0
    }));

    await git.checkout('https://github.com/owner/repo.git', {
      targetDir: '/work/app',
      sessionId: 'sess-1'
    });

    expect(execute.mock.calls[0][1]).toEqual({ sessionId: 'sess-1' });
    // Branch query runs with cwd set to the target dir.
    expect(execute.mock.calls[1][1]).toEqual({
      cwd: '/work/app',
      sessionId: 'sess-1'
    });
  });

  it('rejects an invalid git url before executing', async () => {
    const { git, execute } = createGit(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0
    }));

    await expect(git.checkout('')).rejects.toBeInstanceOf(InvalidGitUrlError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('throws GitCloneError on a non-zero clone exit', async () => {
    const { git } = createGit(() => ({
      stdout: '',
      stderr: 'fatal: boom',
      exitCode: 1
    }));

    await expect(
      git.checkout('https://github.com/owner/repo.git')
    ).rejects.toBeInstanceOf(GitCloneError);
  });

  it('throws GitNetworkError when the clone times out', async () => {
    const { git } = createGit(() => ({
      stdout: '',
      stderr: '',
      exitCode: 124
    }));

    await expect(
      git.checkout('https://github.com/owner/repo.git')
    ).rejects.toBeInstanceOf(GitNetworkError);
  });

  it('lists branches from a cloned repo', async () => {
    const { git } = createGit(() => ({
      stdout: '* main\n  dev\n',
      stderr: '',
      exitCode: 0
    }));

    expect(await git.listBranches('/workspace/repo')).toEqual(['main', 'dev']);
  });

  it('merges sandbox env vars into sessionless git commands', async () => {
    const { git, execute } = createGit(
      () => ({ stdout: 'main\n', stderr: '', exitCode: 0 }),
      { GITHUB_TOKEN: 'tok', HTTPS_PROXY: 'http://proxy:8080' }
    );

    await git.checkout('https://github.com/owner/repo.git');

    for (const call of execute.mock.calls) {
      expect((call[1] as { env?: Record<string, string> }).env).toEqual({
        GITHUB_TOKEN: 'tok',
        HTTPS_PROXY: 'http://proxy:8080'
      });
    }
  });

  it('does not require ContainerProxy when auth is not configured', async () => {
    const { git, execute } = createGit(() => ({
      stdout: 'main\n',
      stderr: '',
      exitCode: 0
    }));

    await git.checkout('https://github.com/owner/repo.git');

    expect(execute).toHaveBeenCalled();
  });

  it('registers git auth interception when auth matches the checkout host', async () => {
    const registerGitAuthInterceptor = vi.fn(async () => {});
    const execute = vi.fn(async (_command: string, _options?: unknown) => ({
      stdout: 'main\n',
      stderr: '',
      exitCode: 0
    }));
    const sandbox = {
      client: { commands: { execute } },
      registerGitAuthInterceptor
    } as unknown as SandboxLike;
    const git = withGit(sandbox, {
      auth: { github: { token: 'secret-token' } }
    });

    await git.checkout('https://github.com/owner/repo.git');

    expect(registerGitAuthInterceptor).toHaveBeenCalledWith({
      hosts: { 'github.com': { token: 'secret-token' } }
    });
  });

  it('registers only the checkout host credentials', async () => {
    const registerGitAuthInterceptor = vi.fn(async () => {});
    const { git } = createGit(
      () => ({ stdout: 'main\n', stderr: '', exitCode: 0 }),
      undefined,
      registerGitAuthInterceptor
    );

    await git.checkout('https://github.com/owner/repo.git', {
      auth: {
        github: { token: 'github-token' },
        gitlab: { token: 'gitlab-token' }
      }
    });

    expect(registerGitAuthInterceptor).toHaveBeenCalledWith({
      hosts: { 'github.com': { token: 'github-token' } }
    });
  });

  it('does not register git auth interception when auth is disabled per checkout', async () => {
    const registerGitAuthInterceptor = vi.fn(async () => {});
    const { git } = createGit(
      () => ({ stdout: 'main\n', stderr: '', exitCode: 0 }),
      undefined,
      registerGitAuthInterceptor
    );
    const configuredGit = withGit(
      {
        client: {
          commands: {
            execute: vi.fn(async () => ({
              stdout: 'main\n',
              stderr: '',
              exitCode: 0
            }))
          }
        },
        registerGitAuthInterceptor
      } as unknown as SandboxLike,
      { auth: { github: { token: 'secret-token' } } }
    );

    await git.checkout('https://github.com/owner/repo.git', { auth: false });
    await configuredGit.checkout('https://github.com/owner/repo.git', {
      auth: false
    });

    expect(registerGitAuthInterceptor).not.toHaveBeenCalled();
  });

  it('throws an obvious ContainerProxy error when auth is configured without interception support', async () => {
    const { git, execute } = createGit(() => ({
      stdout: 'main\n',
      stderr: '',
      exitCode: 0
    }));

    await expect(
      git.checkout('https://github.com/owner/repo.git', {
        auth: { github: { token: 'secret-token' } }
      })
    ).rejects.toThrow(/exporting ContainerProxy/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not inject sandbox env vars when a session is provided', async () => {
    const { git, execute } = createGit(
      () => ({ stdout: 'main\n', stderr: '', exitCode: 0 }),
      { GITHUB_TOKEN: 'tok' }
    );

    await git.checkout('https://github.com/owner/repo.git', {
      sessionId: 'sess-1'
    });

    for (const call of execute.mock.calls) {
      expect((call[1] as { sessionId?: string }).sessionId).toBe('sess-1');
      expect((call[1] as { env?: Record<string, string> }).env).toBeUndefined();
    }
  });
});
