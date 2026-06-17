/**
 * Code Interpreter extension for Cloudflare Sandbox.
 *
 * Talks to the container over the control-plane RPC channel, so it must be
 * constructed with a Sandbox instance (the `this` of a Sandbox subclass),
 * not the stub returned by `getSandbox()`.
 *
 *   import { withInterpreter } from '@cloudflare/sandbox/interpreter';
 *
 *   export class MySandbox extends Sandbox<Env> {
 *     interpreter = withInterpreter(this);
 *
 *     async run(code: string) {
 *       return this.interpreter.runCode(code, { language: 'python' });
 *     }
 *   }
 */

import { RpcTarget } from 'cloudflare:workers';
import type {
  CodeContext,
  CreateContextOptions,
  ExecutionError,
  ExecutionResult,
  OutputMessage,
  Result,
  RunCodeOptions,
  SandboxInterpreterAPI
} from '@repo/shared';
import { Execution, ResultImpl } from '@repo/shared';

// Re-export interpreter types so consumers can import from '@cloudflare/sandbox/interpreter'
export type {
  CodeContext,
  CreateContextOptions,
  ExecutionResult,
  RunCodeOptions
};

// ---------------------------------------------------------------------------
// SandboxLike — the minimal public interface an extension depends on
// ---------------------------------------------------------------------------

export type SandboxLike = {
  readonly client: {
    readonly interpreter: SandboxInterpreterAPI;
  };
};

// ---------------------------------------------------------------------------
// Supported languages
// ---------------------------------------------------------------------------

const SUPPORTED_LANGUAGES = new Set([
  'python',
  'python3',
  'javascript',
  'js',
  'node',
  'typescript',
  'ts'
]);

function validateLanguage(language: string | undefined): void {
  if (!language) return;
  if (!SUPPORTED_LANGUAGES.has(language.toLowerCase())) {
    throw new Error(
      `Unsupported language '${language}'. Supported languages: python, javascript, typescript`
    );
  }
}

// ---------------------------------------------------------------------------
// Interpreter — the extension's public API, as an RpcTarget
//
// This is the canonical shape for a Sandbox extension:
//
//   1. Extend `RpcTarget` so the instance can be passed by reference across
//      the Workers RPC boundary. Only `RpcTarget` instances may be exposed
//      this way; a plain object of closures cannot (its methods are dropped
//      by structured clone). This makes `sandbox.<ext>.method()` reachable
//      from a Worker once the runtime supports getter pipelining (see note).
//   2. Capture the Sandbox in an ECMAScript `#private` field. Private fields
//      are NOT observable as own properties on the RPC receiver, so the
//      sandbox reference can never be read or invoked across the boundary.
//      Only the public async methods below are callable.
//   3. Stay lazy: the constructor only stores the reference. The control
//      client (`sandbox.client.interpreter`) is dereferenced per-call via
//      `#rpc`, never at construction time — so `ext = withX(this)` as a class
//      field initializer is safe (it runs after the base constructor).
//
// Note on Worker access: direct property pipelining (`stub.interpreter.x()`)
// is currently broken under the vite-plugin runtime — the same constraint
// documented on `TunnelsRpcTarget`. Until it lifts, expose extension methods
// to the Worker via thin delegate methods on the Sandbox subclass (e.g.
// `runPython()` calling `this.interpreter.runCode(...)`), or a
// `call<Ext>(method, args)` dispatch + Proxy as `tunnels` does. The
// `RpcTarget` base keeps the pipelining shape ready for when it works.
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

function isInterpreterNotReady(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as { code?: unknown }).code === 'INTERPRETER_NOT_READY') {
    return true;
  }
  const msg = error.message.toLowerCase();
  return msg.includes('not ready') || msg.includes('initializing');
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (isInterpreterNotReady(lastError) && attempt < MAX_RETRIES - 1) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export class Interpreter extends RpcTarget {
  // ECMAScript private fields (not TS `private`) so they are not observable
  // as own properties on the RPC receiver and cannot be reached from a Worker.
  readonly #sandbox: SandboxLike;
  // Best-effort cache of contexts created through this instance. The container
  // is the source of truth; `listContexts()` re-syncs it.
  readonly #contexts = new Map<string, CodeContext>();

  constructor(sandbox: SandboxLike) {
    super();
    this.#sandbox = sandbox;
  }

  get #rpc(): SandboxInterpreterAPI {
    return this.#sandbox.client.interpreter;
  }

  async #getOrCreateDefaultContext(
    language: 'python' | 'javascript' | 'typescript'
  ): Promise<CodeContext> {
    for (const ctx of this.#contexts.values()) {
      if (ctx.language === language) return ctx;
    }
    return this.createContext({ language });
  }

  async createContext(
    options: CreateContextOptions = {}
  ): Promise<CodeContext> {
    validateLanguage(options.language);
    const context = await withRetry(() => this.#rpc.createCodeContext(options));
    this.#contexts.set(context.id, context);
    return context;
  }

  async runCode(
    code: string,
    options: RunCodeOptions = {}
  ): Promise<ExecutionResult> {
    let context = options.context;
    if (!context) {
      context = await this.#getOrCreateDefaultContext(
        options.language || 'python'
      );
    }

    const execution = new Execution(code, context);
    const contextId = context.id;

    await withRetry(() =>
      this.#rpc.runCodeStream(
        contextId,
        code,
        options.language,
        {
          onStdout: (output: OutputMessage) => {
            execution.logs.stdout.push(output.text);
            return options.onStdout?.(output);
          },
          onStderr: (output: OutputMessage) => {
            execution.logs.stderr.push(output.text);
            return options.onStderr?.(output);
          },
          onResult: async (result: Result) => {
            execution.results.push(new ResultImpl(result));
            if (options.onResult) return options.onResult(result);
          },
          onError: (error: ExecutionError) => {
            execution.error = error;
            return options.onError?.(error);
          }
        },
        options.timeout
      )
    );

    return execution.toJSON();
  }

  async runCodeStream(
    code: string,
    options: RunCodeOptions = {}
  ): Promise<ReadableStream> {
    let context = options.context;
    if (!context) {
      context = await this.#getOrCreateDefaultContext(
        options.language || 'python'
      );
    }
    const contextId = context.id;
    return withRetry(() =>
      this.#rpc.streamCode(contextId, code, options.language)
    );
  }

  async listContexts(): Promise<CodeContext[]> {
    const list = await withRetry(() => this.#rpc.listCodeContexts());
    for (const ctx of list) {
      this.#contexts.set(ctx.id, ctx);
    }
    return list;
  }

  async deleteContext(contextId: string): Promise<void> {
    await withRetry(() => this.#rpc.deleteCodeContext(contextId));
    this.#contexts.delete(contextId);
  }
}

// ---------------------------------------------------------------------------
// withInterpreter — the factory consumers use as a class-field initializer
// ---------------------------------------------------------------------------

export function withInterpreter(sandbox: SandboxLike): Interpreter {
  return new Interpreter(sandbox);
}
