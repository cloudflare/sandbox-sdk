import type {
  ExtensionConnectRequest,
  SandboxExtensionsAPI
} from '@repo/shared';
import { EXTENSION_TARBALL_REQUIRED } from '@repo/shared';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxLike } from '../../../packages/sandbox/src/extensions';
import { Interpreter, withInterpreter } from '../src/index';
import type { InterpreterSidecarAPI } from '../src/sidecar-api';

type ExtensionsApiMock = {
  connect: Mock<SandboxExtensionsAPI['connect']>;
  health: Mock<SandboxExtensionsAPI['health']>;
  stop: Mock<SandboxExtensionsAPI['stop']>;
};

function makeSandbox(): { sandbox: SandboxLike; api: ExtensionsApiMock } {
  const api: ExtensionsApiMock = {
    connect: vi.fn(async () => ({}) as unknown),
    health: vi.fn(async (packageHash: string) => ({
      packageHash,
      id: 'cloudflare-sandbox-interpreter-sidecar',
      version: '0.0.0-test',
      provisioned: true,
      running: true,
      responsive: true,
      pid: 123,
      bin: 'sandbox-interpreter-sidecar',
      readinessTimeoutMs: 30_000
    })),
    stop: vi.fn(async () => {})
  };
  return {
    sandbox: {
      client: { extensions: api as unknown as SandboxExtensionsAPI }
    } as unknown as SandboxLike,
    api
  };
}

const RAW_CONTEXT = {
  id: 'ctx-1',
  language: 'python',
  cwd: '/workspace',
  createdAt: '2024-01-01T00:00:00.000Z',
  lastUsed: '2024-01-01T00:00:00.000Z'
};

function tarballRequired(): Error {
  const error = new Error('need tarball');
  error.name = EXTENSION_TARBALL_REQUIRED;
  return error;
}

describe('withInterpreter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not touch the bridge during construction (lazy)', () => {
    const { sandbox, api } = makeSandbox();
    withInterpreter(sandbox);
    expect(api.connect).not.toHaveBeenCalled();
  });

  it('creates a context through the sidecar, shipping the tarball on demand', async () => {
    const { sandbox, api } = makeSandbox();
    const stub: InterpreterSidecarAPI = {
      createContext: vi.fn(async () => RAW_CONTEXT),
      listContexts: vi.fn(async () => []),
      deleteContext: vi.fn(async () => {}),
      runCode: vi.fn(async () => {})
    };
    api.connect
      .mockRejectedValueOnce(tarballRequired())
      .mockResolvedValue(stub);
    const ext = withInterpreter(sandbox);

    const context = await ext.createCodeContext({ language: 'python' });

    expect(api.connect).toHaveBeenCalledTimes(2);
    const first = api.connect.mock.calls[0][0] as ExtensionConnectRequest;
    const second = api.connect.mock.calls[1][0] as ExtensionConnectRequest;
    expect(first.packageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.tarball).toBeUndefined();
    expect(second.packageHash).toBe(first.packageHash);
    expect(second.tarball).toBeInstanceOf(Uint8Array);
    expect(stub.createContext).toHaveBeenCalledWith({
      language: 'python',
      cwd: undefined
    });
    expect(context.id).toBe('ctx-1');
    expect(context.createdAt).toBeInstanceOf(Date);
  });

  it('rejects unsupported languages before any RPC', async () => {
    const { sandbox, api } = makeSandbox();
    const ext = withInterpreter(sandbox);

    await expect(
      ext.createCodeContext({
        language: 'ruby' as unknown as 'python'
      })
    ).rejects.toThrow(/Unsupported language/);
    expect(api.connect).not.toHaveBeenCalled();
  });

  it('runs code and reconstructs streamed callback events into an Execution', async () => {
    const { sandbox, api } = makeSandbox();
    const stub: InterpreterSidecarAPI = {
      createContext: vi.fn(async () => RAW_CONTEXT),
      listContexts: vi.fn(async () => []),
      deleteContext: vi.fn(async () => {}),
      runCode: vi.fn(async (_contextId, _code, _language, onEvent) => {
        await onEvent({ type: 'stdout', text: 'hello\n' });
        await onEvent({ type: 'result', text: '42', metadata: {} });
        await onEvent({ type: 'execution_complete', execution_count: 1 });
      })
    };
    api.connect.mockResolvedValue(stub);

    const ext = withInterpreter(sandbox);
    const context = {
      id: 'ctx-1',
      language: 'python',
      cwd: '/workspace',
      createdAt: new Date(),
      lastUsed: new Date()
    };

    const execution = await ext.runCode('print("hello")', { context });

    expect(stub.runCode).toHaveBeenCalledWith(
      'ctx-1',
      'print("hello")',
      undefined,
      expect.any(Function)
    );
    expect(execution.logs.stdout).toEqual(['hello\n']);
    expect(execution.results).toHaveLength(1);
    expect(execution.results[0].text).toBe('42');
    expect(execution.executionCount).toBe(1);
  });

  it('passes RPC-safe plain data to onResult (no class instance)', async () => {
    const { sandbox, api } = makeSandbox();
    const stub: InterpreterSidecarAPI = {
      createContext: vi.fn(async () => RAW_CONTEXT),
      listContexts: vi.fn(async () => []),
      deleteContext: vi.fn(async () => {}),
      runCode: vi.fn(async (_contextId, _code, _language, onEvent) => {
        await onEvent({ type: 'result', text: '42', metadata: {} });
      })
    };
    api.connect.mockResolvedValue(stub);

    const ext = withInterpreter(sandbox);
    const context = {
      id: 'ctx-1',
      language: 'python',
      cwd: '/workspace',
      createdAt: new Date(),
      lastUsed: new Date()
    };

    const received: unknown[] = [];
    await ext.runCode('40 + 2', {
      context,
      onResult: (result) => {
        received.push(result);
      }
    });

    expect(received).toHaveLength(1);
    const result = received[0] as Record<string, unknown>;
    expect(result.text).toBe('42');
    // Must be plain data so it survives the Worker/DO callback boundary:
    // no methods, and structured-cloneable.
    expect(typeof (result as { formats?: unknown }).formats).toBe('undefined');
    expect(() => structuredClone(result)).not.toThrow();
  });

  it('surfaces error events on the Execution', async () => {
    const { sandbox, api } = makeSandbox();
    const stub: InterpreterSidecarAPI = {
      createContext: vi.fn(async () => RAW_CONTEXT),
      listContexts: vi.fn(async () => []),
      deleteContext: vi.fn(async () => {}),
      runCode: vi.fn(async (_contextId, _code, _language, onEvent) => {
        await onEvent({
          type: 'error',
          ename: 'ValueError',
          evalue: 'boom',
          traceback: ['line 1']
        });
      })
    };
    api.connect.mockResolvedValue(stub);

    const ext = withInterpreter(sandbox);
    const context = {
      id: 'ctx-1',
      language: 'python',
      cwd: '/workspace',
      createdAt: new Date(),
      lastUsed: new Date()
    };

    const execution = await ext.runCode('raise ValueError', { context });

    expect(execution.error).toEqual({
      name: 'ValueError',
      message: 'boom',
      traceback: ['line 1']
    });
  });

  it('lists and deletes contexts through the sidecar', async () => {
    const { sandbox, api } = makeSandbox();
    const stub: InterpreterSidecarAPI = {
      createContext: vi.fn(async () => RAW_CONTEXT),
      listContexts: vi.fn(async () => [RAW_CONTEXT]),
      deleteContext: vi.fn(async () => {}),
      runCode: vi.fn(async () => {})
    };
    api.connect.mockResolvedValue(stub);

    const ext = withInterpreter(sandbox);

    const contexts = await ext.listCodeContexts();
    expect(contexts).toHaveLength(1);
    expect(contexts[0].createdAt).toBeInstanceOf(Date);

    await ext.deleteCodeContext('ctx-1');
    expect(stub.deleteContext).toHaveBeenCalledWith('ctx-1');
  });

  it('returns an Interpreter instance from the factory', () => {
    const { sandbox } = makeSandbox();
    expect(withInterpreter(sandbox)).toBeInstanceOf(Interpreter);
  });
});
