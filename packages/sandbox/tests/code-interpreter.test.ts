/**
 * Unit tests for the code interpreter extension (`@cloudflare/sandbox/interpreter`).
 *
 * Exercises the extension's behaviour against a mocked control-plane
 * interpreter API: language validation, default-context creation and reuse,
 * streaming-callback accumulation, cache re-sync, and the not-ready retry path.
 * This doubles as the reference for the canonical `RpcTarget`-based extension
 * shape.
 */

import type {
  CodeContext,
  ExecutionError,
  OutputMessage,
  Result
} from '@repo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Interpreter,
  type SandboxLike,
  withInterpreter
} from '../src/code-interpreter';

type StreamCallbacks = {
  onStdout: (output: OutputMessage) => void | Promise<void>;
  onStderr: (output: OutputMessage) => void | Promise<void>;
  onResult: (result: Result) => void | Promise<void>;
  onError: (error: ExecutionError) => void | Promise<void>;
};

function makeContext(language: string, id = `ctx-${language}`): CodeContext {
  return {
    id,
    language,
    cwd: '/workspace',
    createdAt: new Date(),
    lastUsed: new Date()
  };
}

function makeSandbox() {
  let counter = 0;
  const interpreter = {
    createCodeContext: vi.fn(async (options: { language?: string } = {}) =>
      makeContext(options.language ?? 'python', `ctx-${++counter}`)
    ),
    runCodeStream: vi.fn(
      async (
        _contextId: string,
        _code: string,
        _language: string | undefined,
        _callbacks: StreamCallbacks,
        _timeout?: number
      ) => undefined
    ),
    streamCode: vi.fn(
      async (_contextId: string, _code: string, _language?: string) =>
        new ReadableStream()
    ),
    listCodeContexts: vi.fn(async () => [] as CodeContext[]),
    deleteCodeContext: vi.fn(async (_contextId: string) => undefined)
  };
  const sandbox = { client: { interpreter } } as unknown as SandboxLike;
  return { sandbox, interpreter };
}

function notReadyError(): Error {
  return Object.assign(new Error('interpreter is initializing'), {
    code: 'INTERPRETER_NOT_READY'
  });
}

describe('withInterpreter', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns an Interpreter RpcTarget instance', () => {
    const { sandbox } = makeSandbox();
    const interpreter = withInterpreter(sandbox);
    expect(interpreter).toBeInstanceOf(Interpreter);
  });

  it('does not touch the control client at construction (lazy)', () => {
    const { sandbox, interpreter: rpc } = makeSandbox();
    withInterpreter(sandbox);
    expect(rpc.createCodeContext).not.toHaveBeenCalled();
    expect(rpc.listCodeContexts).not.toHaveBeenCalled();
  });

  describe('createContext', () => {
    it('creates a context via the control client', async () => {
      const { sandbox, interpreter: rpc } = makeSandbox();
      const ext = withInterpreter(sandbox);

      const ctx = await ext.createContext({ language: 'python' });

      expect(rpc.createCodeContext).toHaveBeenCalledWith({
        language: 'python'
      });
      expect(ctx.language).toBe('python');
    });

    it('rejects unsupported languages before calling the client', async () => {
      const { sandbox, interpreter: rpc } = makeSandbox();
      const ext = withInterpreter(sandbox);

      await expect(
        ext.createContext({ language: 'cobol' as never })
      ).rejects.toThrow(/Unsupported language/);
      expect(rpc.createCodeContext).not.toHaveBeenCalled();
    });
  });

  describe('runCode', () => {
    it('creates a default context then accumulates streamed output', async () => {
      const { sandbox, interpreter: rpc } = makeSandbox();
      rpc.runCodeStream.mockImplementationOnce(
        async (_ctxId, _code, _lang, callbacks: StreamCallbacks) => {
          await callbacks.onStdout({ text: 'hello', timestamp: 0 });
          await callbacks.onStderr({ text: 'warn', timestamp: 0 });
          await callbacks.onResult({ text: '42' } as Result);
        }
      );
      const ext = withInterpreter(sandbox);

      const result = await ext.runCode('print("hello")', {
        language: 'python'
      });

      expect(rpc.createCodeContext).toHaveBeenCalledTimes(1);
      expect(result.logs.stdout).toEqual(['hello']);
      expect(result.logs.stderr).toEqual(['warn']);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].text).toBe('42');
    });

    it('reuses the cached default context for the same language', async () => {
      const { sandbox, interpreter: rpc } = makeSandbox();
      const ext = withInterpreter(sandbox);

      await ext.runCode('1', { language: 'python' });
      await ext.runCode('2', { language: 'python' });

      expect(rpc.createCodeContext).toHaveBeenCalledTimes(1);
      expect(rpc.runCodeStream).toHaveBeenCalledTimes(2);
    });

    it('forwards user callbacks alongside internal accumulation', async () => {
      const { sandbox, interpreter: rpc } = makeSandbox();
      rpc.runCodeStream.mockImplementationOnce(
        async (_ctxId, _code, _lang, callbacks: StreamCallbacks) => {
          await callbacks.onStdout({ text: 'out', timestamp: 0 });
        }
      );
      const onStdout = vi.fn();
      const ext = withInterpreter(sandbox);

      await ext.runCode('x', { language: 'python', onStdout });

      expect(onStdout).toHaveBeenCalledWith({ text: 'out', timestamp: 0 });
    });
  });

  describe('runCodeStream', () => {
    it('creates a default context and returns the raw stream', async () => {
      const { sandbox, interpreter: rpc } = makeSandbox();
      const ext = withInterpreter(sandbox);

      const stream = await ext.runCodeStream('print(1)', {
        language: 'python'
      });

      expect(rpc.createCodeContext).toHaveBeenCalledTimes(1);
      expect(rpc.streamCode).toHaveBeenCalledTimes(1);
      expect(stream).toBeInstanceOf(ReadableStream);
    });
  });

  describe('listContexts', () => {
    it('returns the server list and re-syncs the local cache', async () => {
      const { sandbox, interpreter: rpc } = makeSandbox();
      const remote = makeContext('python', 'remote-1');
      rpc.listCodeContexts.mockResolvedValueOnce([remote]);
      const ext = withInterpreter(sandbox);

      const list = await ext.listContexts();

      expect(list).toEqual([remote]);
      // Cached now: a subsequent runCode for python reuses it (no create).
      await ext.runCode('1', { language: 'python' });
      expect(rpc.createCodeContext).not.toHaveBeenCalled();
      expect(rpc.runCodeStream).toHaveBeenCalledWith(
        'remote-1',
        expect.any(String),
        'python',
        expect.any(Object),
        undefined
      );
    });
  });

  describe('deleteContext', () => {
    it('deletes via the client and drops it from the cache', async () => {
      const { sandbox, interpreter: rpc } = makeSandbox();
      const ext = withInterpreter(sandbox);

      const ctx = await ext.createContext({ language: 'python' });
      await ext.deleteContext(ctx.id);

      expect(rpc.deleteCodeContext).toHaveBeenCalledWith(ctx.id);
      // Cache dropped: next python run must create a fresh context.
      await ext.runCode('1', { language: 'python' });
      expect(rpc.createCodeContext).toHaveBeenCalledTimes(2);
    });
  });

  describe('readiness retry', () => {
    it('retries on INTERPRETER_NOT_READY then succeeds', async () => {
      vi.useFakeTimers();
      const { sandbox, interpreter: rpc } = makeSandbox();
      rpc.createCodeContext
        .mockRejectedValueOnce(notReadyError())
        .mockResolvedValueOnce(makeContext('python', 'ctx-ready'));
      const ext = withInterpreter(sandbox);

      const pending = ext.createContext({ language: 'python' });
      await vi.runAllTimersAsync();
      const ctx = await pending;

      expect(rpc.createCodeContext).toHaveBeenCalledTimes(2);
      expect(ctx.id).toBe('ctx-ready');
    });

    it('does not retry on unrelated errors', async () => {
      const { sandbox, interpreter: rpc } = makeSandbox();
      rpc.createCodeContext.mockRejectedValueOnce(new Error('boom'));
      const ext = withInterpreter(sandbox);

      await expect(ext.createContext({ language: 'python' })).rejects.toThrow(
        'boom'
      );
      expect(rpc.createCodeContext).toHaveBeenCalledTimes(1);
    });
  });
});
