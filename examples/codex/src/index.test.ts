import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ExecCall {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface GitCheckoutCall {
  repo: string;
  options?: Record<string, unknown>;
}

const mockExecCalls: ExecCall[] = [];
const mockGitCheckoutCalls: GitCheckoutCall[] = [];

// Avoid passing options object to vi.mock virtual call as it triggers ts(2554) with current ts declarations
vi.mock('cloudflare:workers', () => {
  return {
    DurableObject: class {},
    RpcTarget: class {}
  };
});

vi.mock('@cloudflare/sandbox', () => {
  return {
    getSandbox: vi.fn().mockImplementation((_ns: unknown, _id: string) => {
      return {
        setEnvVars: async () => {},
        mkdir: async () => {},
        writeFile: async () => {},
        gitCheckout: async (
          repo: string,
          options?: Record<string, unknown>
        ) => {
          mockGitCheckoutCalls.push({ repo, options });
        },
        exec: async (argv: string[], options?: Record<string, unknown>) => {
          const opt = options as Record<string, unknown> | undefined;
          mockExecCalls.push({
            argv,
            cwd: opt?.cwd as string | undefined,
            env: opt?.env as Record<string, string> | undefined
          });
          return {
            waitForExit: async () => {},
            output: async () => {
              return {
                exitCode: 0,
                stdout: 'mock-stdout',
                stderr: 'mock-stderr'
              };
            }
          };
        }
      };
    }),
    Sandbox: class {}
  };
});

import worker from './index.js';

interface FakeEnv {
  Sandbox: unknown;
  OPENAI_API_KEY: string;
  CODEX_AUTH_JSON: string;
}

describe('Codex example cwd', () => {
  beforeEach(() => {
    mockExecCalls.length = 0;
    mockGitCheckoutCalls.length = 0;
  });

  it('proves cwd propagation GREEN (no standalone cd, explicit cwd on both execs, .git suffix removal check)', async () => {
    const request = new Request('http://localhost/', {
      method: 'POST',
      body: JSON.stringify({
        repo: 'https://github.com/user/my-repo.git',
        task: 'fix-bug'
      })
    });
    const env: FakeEnv = {
      Sandbox: {},
      OPENAI_API_KEY: 'test-key',
      CODEX_AUTH_JSON: ''
    };

    const response = await worker.fetch(request, env as unknown as Env);
    expect(response.status).toBe(200);

    // Exact count and sequence assertion (with .git suffix removal check)
    expect(mockExecCalls).toHaveLength(2);
    expect(mockExecCalls).toEqual([
      expect.objectContaining({
        cwd: '/workspace/my-repo'
      }),
      {
        argv: ['/bin/bash', '-lc', 'git diff'],
        cwd: '/workspace/my-repo',
        env: undefined
      }
    ]);

    // Explicitly verify the first call runs codex (and contains task)
    expect(mockExecCalls[0].argv[2]).toContain('codex exec');
    expect(mockExecCalls[0].argv[2]).toContain('fix-bug');

    // Explicit standalone 'cd' absence check
    const cdCall = mockExecCalls.find((c) =>
      c.argv.some((a) => a === 'cd my-repo' || a.startsWith('cd '))
    );
    expect(cdCall).toBeUndefined();
  });
});
