import type {
  SandboxExecOptions,
  SandboxExecStringOutput,
  SandboxProcessPromise
} from '@repo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

type GitCommand = string | string[];

function decodeBasicAuthorization(header: string | undefined): string {
  if (!header?.startsWith('Basic ')) return '';
  return atob(header.slice('Basic '.length));
}

function outputFor(
  command: GitCommand,
  result: ExecResult
): SandboxExecStringOutput {
  return {
    ...result,
    success: result.exitCode === 0,
    duration: 1,
    command: Array.isArray(command) ? command.join(' ') : command,
    timestamp: new Date().toISOString()
  };
}

function createGit(
  execImpl: (command: GitCommand, options?: SandboxExecOptions) => ExecResult,
  envVars?: Record<string, string>,
  registerExtensionHTTPProxyLease?: (config: {
    extensionId: string;
    operationId?: string;
    routes: Array<{
      upstreamOrigin: string;
      allowedPathPrefix: string;
      injectHeaders?: Record<string, string>;
    }>;
  }) => Promise<{
    id: string;
    internalBaseURL: string;
    dispose: () => Promise<void>;
  }>
) {
  const exec = vi.fn((command: GitCommand, options?: SandboxExecOptions) => {
    const result = execImpl(command, options);
    return {
      output: vi.fn(async () => outputFor(command, result))
    } as unknown as SandboxProcessPromise;
  });
  const sandbox = {
    client: { commands: { execute: vi.fn() } },
    exec,
    envVars,
    registerExtensionHTTPProxyLease
  } as unknown as SandboxLike;
  return { git: withGit(sandbox), exec };
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
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is constructed via withGit', () => {
    const { git } = createGit(() => ({ stdout: '', stderr: '', exitCode: 0 }));
    expect(git).toBeInstanceOf(Git);
  });

  it('clones and reports the checked-out branch', async () => {
    const { git, exec } = createGit((command) => {
      if (Array.isArray(command) && command.includes('--show-current')) {
        return { stdout: 'main\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await git.checkout('https://github.com/owner/repo.git');

    expect(result.success).toBe(true);
    expect(result.branch).toBe('main');
    expect(result.targetDir).toBe('/workspace/repo');
    expect(exec.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['git', 'clone'])
    );
    expect(exec.mock.calls[0][1]).toEqual(
      expect.objectContaining({ stdout: 'pipe', stderr: 'pipe' })
    );
  });

  it('runs in the provided session and target dir', async () => {
    const { git, exec } = createGit(() => ({
      stdout: 'main\n',
      stderr: '',
      exitCode: 0
    }));

    await git.checkout('https://github.com/owner/repo.git', {
      targetDir: '/work/app',
      sessionId: 'sess-1'
    });

    expect(exec.mock.calls[0][1]).toEqual(
      expect.objectContaining({ sessionId: 'sess-1' })
    );
    // Branch query runs with cwd set to the target dir.
    expect(exec.mock.calls[1][1]).toEqual({
      cwd: '/work/app',
      sessionId: 'sess-1',
      stdout: 'pipe',
      stderr: 'pipe'
    });
  });

  it('rejects an invalid git url before executing', async () => {
    const { git, exec } = createGit(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0
    }));

    await expect(git.checkout('')).rejects.toBeInstanceOf(InvalidGitUrlError);
    expect(exec).not.toHaveBeenCalled();
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

  it('leaves sessionless env handling to sandbox exec', async () => {
    const { git, exec } = createGit(
      () => ({ stdout: 'main\n', stderr: '', exitCode: 0 }),
      { GITHUB_TOKEN: 'tok', HTTPS_PROXY: 'http://proxy:8080' }
    );

    await git.checkout('https://github.com/owner/repo.git');

    for (const call of exec.mock.calls) {
      expect((call[1] as { env?: Record<string, string> }).env).toBeUndefined();
    }
  });

  it('does not require ContainerProxy when auth is not configured', async () => {
    const { git, exec } = createGit(() => ({
      stdout: 'main\n',
      stderr: '',
      exitCode: 0
    }));

    await git.checkout('https://github.com/owner/repo.git');

    expect(exec).toHaveBeenCalled();
  });

  it('uses an operation-scoped internal proxy lease for configured HTTPS auth', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
    const dispose = vi.fn(async () => {});
    const registerExtensionHTTPProxyLease = vi.fn(async () => ({
      id: 'lease-1',
      internalBaseURL: 'http://sandbox-extension-proxy.internal/lease-1',
      dispose
    }));
    const exec = vi.fn((command: GitCommand) => {
      const result = { stdout: 'main\n', stderr: '', exitCode: 0 };
      return {
        output: vi.fn(async () => outputFor(command, result))
      } as unknown as SandboxProcessPromise;
    });
    const sandbox = {
      client: { commands: { execute: vi.fn() } },
      exec,
      registerExtensionHTTPProxyLease
    } as unknown as SandboxLike;
    const git = withGit(sandbox, {
      auth: { github: { token: 'secret-token' } }
    });

    await git.checkout('https://github.com/owner/repo.git');

    expect(registerExtensionHTTPProxyLease).toHaveBeenCalledWith({
      extensionId: 'git',
      routes: [
        expect.objectContaining({
          upstreamOrigin: 'https://github.com',
          allowedPathPrefix: '/owner/repo.git',
          injectHeaders: {
            authorization: expect.stringMatching(/^Basic /)
          }
        })
      ]
    });
    const [leaseConfig] = registerExtensionHTTPProxyLease.mock
      .calls[0] as unknown as [
      Parameters<NonNullable<SandboxLike['registerExtensionHTTPProxyLease']>>[0]
    ];
    const route = leaseConfig.routes[0]!;
    expect(route.expiresAt).toBe(
      Date.parse('2026-07-01T00:00:00Z') + 600_000 + 10_000
    );
    const cloneCommand = exec.mock.calls[0][0] as string[];
    expect(cloneCommand).toContain(
      'http://sandbox-extension-proxy.internal/lease-1/owner/repo.git'
    );
    expect(cloneCommand).not.toContain('https://github.com/owner/repo.git');
    const remoteSetURLCall = exec.mock.calls[1] as unknown as [
      GitCommand,
      SandboxExecOptions | undefined
    ];
    expect(remoteSetURLCall[0]).toEqual([
      'git',
      'remote',
      'set-url',
      'origin',
      'https://github.com/owner/repo.git'
    ]);
    expect(remoteSetURLCall[1]).toEqual(
      expect.objectContaining({ cwd: '/workspace/repo' })
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('uses only the checkout host credentials in the proxy lease', async () => {
    const registerExtensionHTTPProxyLease = vi.fn(async () => ({
      id: 'lease-1',
      internalBaseURL: 'http://sandbox-extension-proxy.internal/lease-1',
      dispose: vi.fn(async () => {})
    }));
    const { git } = createGit(
      () => ({ stdout: 'main\n', stderr: '', exitCode: 0 }),
      undefined,
      registerExtensionHTTPProxyLease
    );

    await git.checkout('https://github.com/owner/repo.git', {
      auth: {
        github: { token: 'github-token' },
        gitlab: { token: 'gitlab-token' }
      }
    });

    expect(registerExtensionHTTPProxyLease).toHaveBeenCalledOnce();
    const [leaseConfig] = registerExtensionHTTPProxyLease.mock
      .calls[0] as unknown as [
      Parameters<NonNullable<SandboxLike['registerExtensionHTTPProxyLease']>>[0]
    ];
    const route = leaseConfig.routes[0]!;
    expect(route.upstreamOrigin).toBe('https://github.com');
    expect(decodeBasicAuthorization(route.injectHeaders?.authorization)).toBe(
      'x-access-token:github-token'
    );
  });

  it('supports URL username/password credentials without exposing them to git argv', async () => {
    const registerExtensionHTTPProxyLease = vi.fn(async () => ({
      id: 'lease-1',
      internalBaseURL: 'http://sandbox-extension-proxy.internal/lease-1',
      dispose: vi.fn(async () => {})
    }));
    const { git, exec } = createGit(
      () => ({ stdout: 'main\n', stderr: '', exitCode: 0 }),
      undefined,
      registerExtensionHTTPProxyLease
    );

    await git.checkout('https://octo:secret-token@github.com/owner/repo.git');

    const [leaseConfig] = registerExtensionHTTPProxyLease.mock
      .calls[0] as unknown as [
      Parameters<NonNullable<SandboxLike['registerExtensionHTTPProxyLease']>>[0]
    ];
    const route = leaseConfig.routes[0]!;
    expect(decodeBasicAuthorization(route.injectHeaders?.authorization)).toBe(
      'octo:secret-token'
    );
    expect((exec.mock.calls[0][0] as string[]).join(' ')).not.toContain(
      'secret-token'
    );
  });

  it('uses bearer auth headers when configured', async () => {
    const registerExtensionHTTPProxyLease = vi.fn(async () => ({
      id: 'lease-1',
      internalBaseURL: 'http://sandbox-extension-proxy.internal/lease-1',
      dispose: vi.fn(async () => {})
    }));
    const { git } = createGit(
      () => ({ stdout: 'main\n', stderr: '', exitCode: 0 }),
      undefined,
      registerExtensionHTTPProxyLease
    );

    await git.checkout('https://github.com/owner/repo.git', {
      auth: { github: { type: 'bearer', token: 'bearer-token' } }
    });

    const [leaseConfig] = registerExtensionHTTPProxyLease.mock
      .calls[0] as unknown as [
      Parameters<NonNullable<SandboxLike['registerExtensionHTTPProxyLease']>>[0]
    ];
    expect(leaseConfig.routes[0]!.injectHeaders?.authorization).toBe(
      'Bearer bearer-token'
    );
  });

  it('skips HTTP auth proxying for SSH-style repository URLs', async () => {
    const registerExtensionHTTPProxyLease = vi.fn(async () => ({
      id: 'lease-1',
      internalBaseURL: 'http://sandbox-extension-proxy.internal/lease-1',
      dispose: vi.fn(async () => {})
    }));
    const { git, exec } = createGit(
      () => ({ stdout: 'main\n', stderr: '', exitCode: 0 }),
      undefined,
      registerExtensionHTTPProxyLease
    );

    await git.checkout('git@github.com:owner/repo.git', {
      auth: { github: { token: 'github-token' } }
    });

    expect(registerExtensionHTTPProxyLease).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalled();
  });

  it('does not create a proxy lease when auth is disabled per checkout', async () => {
    const registerExtensionHTTPProxyLease = vi.fn(async () => ({
      id: 'lease-1',
      internalBaseURL: 'http://sandbox-extension-proxy.internal/lease-1',
      dispose: vi.fn(async () => {})
    }));
    const exec = vi.fn((command: GitCommand) => {
      const result = { stdout: 'main\n', stderr: '', exitCode: 0 };
      return {
        output: vi.fn(async () => outputFor(command, result))
      } as unknown as SandboxProcessPromise;
    });
    const configuredGit = withGit(
      {
        client: { commands: { execute: vi.fn() } },
        exec,
        registerExtensionHTTPProxyLease
      } as unknown as SandboxLike,
      { auth: { github: { token: 'secret-token' } } }
    );

    await configuredGit.checkout('https://github.com/owner/repo.git', {
      auth: false
    });

    expect(registerExtensionHTTPProxyLease).not.toHaveBeenCalled();
    expect(exec.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['https://github.com/owner/repo.git'])
    );
  });

  it('converts credential-bearing HTTPS URLs into proxy auth without exposing the token', async () => {
    const dispose = vi.fn(async () => {});
    const registerExtensionHTTPProxyLease = vi.fn(async () => ({
      id: 'lease-1',
      internalBaseURL: 'http://sandbox-extension-proxy.internal/lease-1',
      dispose
    }));
    const { git, exec } = createGit(
      () => ({ stdout: 'main\n', stderr: '', exitCode: 0 }),
      undefined,
      registerExtensionHTTPProxyLease
    );

    const result = await git.checkout(
      'https://secret-token@github.com/owner/repo.git'
    );

    expect(result.repoUrl).toBe('https://github.com/owner/repo.git');
    const cloneCommand = exec.mock.calls[0][0] as string[];
    expect(cloneCommand.join(' ')).not.toContain('secret-token');
    expect(cloneCommand).toContain(
      'http://sandbox-extension-proxy.internal/lease-1/owner/repo.git'
    );
    expect(registerExtensionHTTPProxyLease).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects configured auth for cleartext HTTP repository URLs', async () => {
    const registerExtensionHTTPProxyLease = vi.fn(async () => ({
      id: 'lease-1',
      internalBaseURL: 'http://sandbox-extension-proxy.internal/lease-1',
      dispose: vi.fn(async () => {})
    }));
    const { git, exec } = createGit(
      () => ({ stdout: 'main\n', stderr: '', exitCode: 0 }),
      undefined,
      registerExtensionHTTPProxyLease
    );

    await expect(
      git.checkout('http://github.com/owner/repo.git', {
        auth: { github: { token: 'secret-token' } }
      })
    ).rejects.toThrow(/HTTPS Git URLs/);
    expect(exec).not.toHaveBeenCalled();
    expect(registerExtensionHTTPProxyLease).not.toHaveBeenCalled();
  });

  it('rejects credential-bearing cleartext HTTP repository URLs', async () => {
    const registerExtensionHTTPProxyLease = vi.fn(async () => ({
      id: 'lease-1',
      internalBaseURL: 'http://sandbox-extension-proxy.internal/lease-1',
      dispose: vi.fn(async () => {})
    }));
    const { git, exec } = createGit(
      () => ({ stdout: 'main\n', stderr: '', exitCode: 0 }),
      undefined,
      registerExtensionHTTPProxyLease
    );

    await expect(
      git.checkout('http://secret-token@github.com/owner/repo.git')
    ).rejects.toThrow(/HTTPS Git URLs/);
    expect(exec).not.toHaveBeenCalled();
    expect(registerExtensionHTTPProxyLease).not.toHaveBeenCalled();
  });

  it('rejects credential-bearing URLs when auth is explicitly disabled', async () => {
    const registerExtensionHTTPProxyLease = vi.fn(async () => ({
      id: 'lease-1',
      internalBaseURL: 'http://sandbox-extension-proxy.internal/lease-1',
      dispose: vi.fn(async () => {})
    }));
    const { git, exec } = createGit(
      () => ({ stdout: 'main\n', stderr: '', exitCode: 0 }),
      undefined,
      registerExtensionHTTPProxyLease
    );

    await expect(
      git.checkout('https://secret-token@github.com/owner/repo.git', {
        auth: false
      })
    ).rejects.toThrow(/credential-bearing Git URLs/);
    expect(exec).not.toHaveBeenCalled();
    expect(registerExtensionHTTPProxyLease).not.toHaveBeenCalled();
  });

  it('does not inject sandbox env vars when a session is provided', async () => {
    const { git, exec } = createGit(
      () => ({ stdout: 'main\n', stderr: '', exitCode: 0 }),
      { GITHUB_TOKEN: 'tok' }
    );

    await git.checkout('https://github.com/owner/repo.git', {
      sessionId: 'sess-1'
    });

    for (const call of exec.mock.calls) {
      expect((call[1] as { sessionId?: string }).sessionId).toBe('sess-1');
      expect((call[1] as { env?: Record<string, string> }).env).toBeUndefined();
    }
  });
});
