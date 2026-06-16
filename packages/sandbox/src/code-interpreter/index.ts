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
// Interpreter interface — the public API returned by withInterpreter()
// ---------------------------------------------------------------------------

export interface Interpreter {
  createContext(options?: CreateContextOptions): Promise<CodeContext>;
  runCode(code: string, options?: RunCodeOptions): Promise<ExecutionResult>;
  runCodeStream(
    code: string,
    options?: RunCodeOptions
  ): Promise<ReadableStream>;
  listContexts(): Promise<CodeContext[]>;
  deleteContext(contextId: string): Promise<void>;
}

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
// withInterpreter — the factory function
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

export function withInterpreter(sandbox: SandboxLike): Interpreter {
  const contexts = new Map<string, CodeContext>();

  const rpc = (): SandboxInterpreterAPI => sandbox.client.interpreter;

  async function getOrCreateDefaultContext(
    language: 'python' | 'javascript' | 'typescript'
  ): Promise<CodeContext> {
    for (const ctx of contexts.values()) {
      if (ctx.language === language) return ctx;
    }
    return createContext({ language });
  }

  async function createContext(
    options: CreateContextOptions = {}
  ): Promise<CodeContext> {
    validateLanguage(options.language);
    const context = await withRetry(() => rpc().createCodeContext(options));
    contexts.set(context.id, context);
    return context;
  }

  async function runCode(
    code: string,
    options: RunCodeOptions = {}
  ): Promise<ExecutionResult> {
    let context = options.context;
    if (!context) {
      context = await getOrCreateDefaultContext(options.language || 'python');
    }

    const execution = new Execution(code, context);
    const contextId = context.id;

    await withRetry(() =>
      rpc().runCodeStream(
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

  async function runCodeStream(
    code: string,
    options: RunCodeOptions = {}
  ): Promise<ReadableStream> {
    let context = options.context;
    if (!context) {
      context = await getOrCreateDefaultContext(options.language || 'python');
    }
    const contextId = context.id;
    return withRetry(() => rpc().streamCode(contextId, code, options.language));
  }

  async function listContexts(): Promise<CodeContext[]> {
    const list = await withRetry(() => rpc().listCodeContexts());
    for (const ctx of list) {
      contexts.set(ctx.id, ctx);
    }
    return list;
  }

  async function deleteContext(contextId: string): Promise<void> {
    await withRetry(() => rpc().deleteCodeContext(contextId));
    contexts.delete(contextId);
  }

  return {
    createContext,
    runCode,
    runCodeStream,
    listContexts,
    deleteContext
  };
}
