/**
 * Unit tests for the interpreter extension (`@cloudflare/sandbox/interpreter`).
 *
 * Validates the extraction: the extension drives the generic extension bridge
 * (`sandbox.client.extensions`), registers its sidecar manifest once, and
 * reconstructs streamed execution events into the `Execution` result shape.
 */

import type { ExtensionHealth, SandboxExtensionsAPI } from '@repo/shared';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxLike } from '../src/extensions';
import { Interpreter, withInterpreter } from '../src/interpreter';

type ExtensionsApiMock = {
  register: Mock<SandboxExtensionsAPI['register']>;
  call: Mock<SandboxExtensionsAPI['call']>;
  callStream: Mock<SandboxExtensionsAPI['callStream']>;
  health: Mock<SandboxExtensionsAPI['health']>;
  stop: Mock<SandboxExtensionsAPI['stop']>;
};

function makeSandbox(): { sandbox: SandboxLike; api: ExtensionsApiMock } {
  const api: ExtensionsApiMock = {
    register: vi.fn(async () => {}),
    call: vi.fn(async () => undefined),
    callStream: vi.fn(async () => undefined),
    health: vi.fn(async () => ({}) as ExtensionHealth),
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

describe('withInterpreter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not touch the bridge during construction (lazy)', () => {
    const { sandbox, api } = makeSandbox();
    withInterpreter(sandbox);
    expect(api.register).not.toHaveBeenCalled();
    expect(api.call).not.toHaveBeenCalled();
  });

  it('creates a context, registering the sidecar manifest once', async () => {
    const { sandbox, api } = makeSandbox();
    api.call.mockResolvedValue(RAW_CONTEXT);
    const ext = withInterpreter(sandbox);

    const context = await ext.createCodeContext({ language: 'python' });

    expect(api.register).toHaveBeenCalledTimes(1);
    expect(api.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'interpreter' })
    );
    expect(api.call).toHaveBeenCalledWith('interpreter', 'createContext', [
      { language: 'python', cwd: undefined }
    ]);
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
    expect(api.call).not.toHaveBeenCalled();
  });

  it('runs code and reconstructs streamed events into an Execution', async () => {
    const { sandbox, api } = makeSandbox();
    api.callStream.mockImplementation(async (_id, _method, _args, onEvent) => {
      await onEvent('stdout', { type: 'stdout', text: 'hello\n' });
      await onEvent('result', {
        type: 'result',
        text: '42',
        metadata: {}
      });
      await onEvent('execution_complete', {
        type: 'execution_complete',
        execution_count: 1
      });
      return undefined;
    });

    const ext = withInterpreter(sandbox);
    const context = {
      id: 'ctx-1',
      language: 'python',
      cwd: '/workspace',
      createdAt: new Date(),
      lastUsed: new Date()
    };

    const execution = await ext.runCode('print("hello")', { context });

    expect(api.callStream).toHaveBeenCalledWith(
      'interpreter',
      'runCode',
      ['ctx-1', 'print("hello")', undefined],
      expect.any(Function)
    );
    expect(execution.logs.stdout).toEqual(['hello\n']);
    expect(execution.results).toHaveLength(1);
    expect(execution.results[0].text).toBe('42');
    expect(execution.executionCount).toBe(1);
  });

  it('surfaces error events on the Execution', async () => {
    const { sandbox, api } = makeSandbox();
    api.callStream.mockImplementation(async (_id, _method, _args, onEvent) => {
      await onEvent('error', {
        type: 'error',
        ename: 'ValueError',
        evalue: 'boom',
        traceback: ['line 1']
      });
      return undefined;
    });

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

  it('lists and deletes contexts through the bridge', async () => {
    const { sandbox, api } = makeSandbox();
    api.call.mockImplementation(async (_id, method) => {
      if (method === 'listContexts') return [RAW_CONTEXT];
      return undefined;
    });

    const ext = withInterpreter(sandbox);

    const contexts = await ext.listCodeContexts();
    expect(contexts).toHaveLength(1);
    expect(contexts[0].createdAt).toBeInstanceOf(Date);

    await ext.deleteCodeContext('ctx-1');
    expect(api.call).toHaveBeenCalledWith('interpreter', 'deleteContext', [
      'ctx-1'
    ]);
  });

  it('returns an Interpreter instance from the factory', () => {
    const { sandbox } = makeSandbox();
    expect(withInterpreter(sandbox)).toBeInstanceOf(Interpreter);
  });
});
