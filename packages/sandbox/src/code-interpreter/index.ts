/**
 * Code Interpreter extension for Cloudflare Sandbox.
 *
 * Usage:
 *   import { withInterpreter } from '@cloudflare/sandbox/interpreter';
 *
 *   const sandbox = getSandbox(env.Sandbox, id);
 *   const interpreter = withInterpreter(sandbox);
 *   const result = await interpreter.runCode('print("hello")');
 *
 * Or inside a Sandbox subclass:
 *   interpreter = withInterpreter(this);
 *   await this.interpreter.runCode('print("hello")');
 */

import type {
  CodeContext,
  ContextCreateResult,
  ContextListResult,
  CreateContextOptions,
  ExecutionResult,
  RunCodeOptions
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
  containerFetch(
    requestOrUrl: Request | string | URL,
    portOrInit?: number | RequestInit,
    portParam?: number
  ): Promise<Response>;
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
// SSE parsing for streaming execution
// ---------------------------------------------------------------------------

interface StreamingExecutionData {
  type: 'result' | 'stdout' | 'stderr' | 'error' | 'execution_complete';
  text?: string;
  html?: string;
  png?: string;
  jpeg?: string;
  svg?: string;
  latex?: string;
  markdown?: string;
  javascript?: string;
  json?: unknown;
  data?: unknown;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// withInterpreter — the factory function
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

function isInterpreterNotReady(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('not ready') ||
    msg.includes('initializing') ||
    msg.includes('interpreter_not_ready')
  );
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

  async function containerJSON<T>(
    path: string,
    init?: RequestInit
  ): Promise<T> {
    return withRetry(async () => {
      const response = await sandbox.containerFetch(
        new Request(`http://localhost:3000${path}`, {
          ...init,
          headers: {
            'Content-Type': 'application/json',
            ...(init?.headers as Record<string, string>)
          }
        })
      );
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new Error(
          `Interpreter request failed (${response.status}): ${text}`
        );
      }
      return response.json() as Promise<T>;
    });
  }

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

    const data = await containerJSON<ContextCreateResult>('/api/contexts', {
      method: 'POST',
      body: JSON.stringify({
        language: options.language || 'python',
        cwd: options.cwd || '/workspace',
        env_vars: options.envVars
      })
    });

    if (!data.success) {
      throw new Error(`Failed to create context: ${JSON.stringify(data)}`);
    }

    const context: CodeContext = {
      id: data.contextId,
      language: data.language,
      cwd: data.cwd || '/workspace',
      createdAt: new Date(data.timestamp),
      lastUsed: new Date(data.timestamp)
    };
    contexts.set(context.id, context);
    return context;
  }

  async function runCode(
    code: string,
    options: RunCodeOptions = {}
  ): Promise<ExecutionResult> {
    let context = options.context;
    if (!context) {
      const language = options.language || 'python';
      context = await getOrCreateDefaultContext(language);
    }

    const execution = new Execution(code, context);

    const response = await withRetry(async () => {
      const res = await sandbox.containerFetch(
        new Request('http://localhost:3000/api/execute/code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context_id: context!.id,
            code,
            language: options.language
          })
        })
      );
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Code execution failed (${res.status}): ${text}`);
      }
      if (!res.body) {
        throw new Error('Code execution returned no body');
      }
      return res;
    });

    // Parse SSE stream and collect results
    const reader = response.body!.getReader();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += new TextDecoder().decode(value);
        }
        if (done) break;

        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          await processSSELine(line, execution, options);
          newlineIdx = buffer.indexOf('\n');
        }
      }
      // Process remaining buffer
      if (buffer.length > 0) {
        await processSSELine(buffer, execution, options);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancel errors
      }
      reader.releaseLock();
    }

    return execution.toJSON();
  }

  async function runCodeStream(
    code: string,
    options: RunCodeOptions = {}
  ): Promise<ReadableStream> {
    let context = options.context;
    if (!context) {
      const language = options.language || 'python';
      context = await getOrCreateDefaultContext(language);
    }

    return withRetry(async () => {
      const res = await sandbox.containerFetch(
        new Request('http://localhost:3000/api/execute/code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context_id: context!.id,
            code,
            language: options.language
          })
        })
      );
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Code execution failed (${res.status}): ${text}`);
      }
      if (!res.body) {
        throw new Error('Code execution returned no body');
      }
      return res.body;
    });
  }

  async function listContexts(): Promise<CodeContext[]> {
    const data = await containerJSON<ContextListResult>('/api/contexts', {
      method: 'GET'
    });

    if (!data.success) {
      throw new Error(`Failed to list contexts: ${JSON.stringify(data)}`);
    }

    const result = data.contexts.map((ctx) => ({
      id: ctx.id,
      language: ctx.language,
      cwd: ctx.cwd || '/workspace',
      createdAt: new Date(data.timestamp),
      lastUsed: new Date(data.timestamp)
    }));

    for (const ctx of result) {
      contexts.set(ctx.id, ctx);
    }

    return result;
  }

  async function deleteContext(contextId: string): Promise<void> {
    const response = await sandbox.containerFetch(
      new Request(`http://localhost:3000/api/contexts/${contextId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      })
    );

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`Failed to delete context (${response.status}): ${text}`);
    }

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function processSSELine(
  line: string,
  execution: Execution,
  options: RunCodeOptions
): Promise<void> {
  if (!line.trim()) return;
  if (!line.startsWith('data: ')) return;

  try {
    const data = JSON.parse(line.substring(6)) as StreamingExecutionData;

    switch (data.type) {
      case 'stdout':
        if (data.text) {
          execution.logs.stdout.push(data.text);
          await options.onStdout?.({
            text: data.text,
            timestamp: data.timestamp || Date.now()
          });
        }
        break;

      case 'stderr':
        if (data.text) {
          execution.logs.stderr.push(data.text);
          await options.onStderr?.({
            text: data.text,
            timestamp: data.timestamp || Date.now()
          });
        }
        break;

      case 'result':
        execution.results.push(new ResultImpl(data) as any);
        if (options.onResult) {
          await options.onResult(new ResultImpl(data));
        }
        break;

      case 'error':
        execution.error = {
          name: data.ename || 'Error',
          message: data.evalue || 'Unknown error',
          traceback: data.traceback || []
        };
        await options.onError?.(execution.error);
        break;

      case 'execution_complete':
        break;
    }
  } catch {
    // Ignore unparseable SSE lines
  }
}
