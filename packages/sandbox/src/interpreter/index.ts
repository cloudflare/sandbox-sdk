/**
 * Code interpreter extension for the Cloudflare Sandbox SDK.
 *
 * This is the first real extraction validating the extension framework: the
 * entire interpreter runtime (the process pool plus the Python/JavaScript
 * executors) ships as **sidecar assets** and runs inside the container, spawned
 * and supervised by the container `ExtensionHost`. None of it is compiled into
 * the core SDK or the container binary anymore.
 *
 * Usage — attach it to a Sandbox subclass and call it as a nested extension:
 *
 * ```ts
 * import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
 * import { withInterpreter } from '@cloudflare/sandbox/interpreter';
 *
 * export class Sandbox extends BaseSandbox<Env> {
 *   interpreter = withInterpreter(this);
 * }
 *
 * const context = await sandbox.interpreter.createCodeContext({ language: 'python' });
 * const result = await sandbox.interpreter.runCode('print("hello")', { context });
 * ```
 */

import { SandboxExtension, type SandboxLike } from '../extensions/index.js';
import type {
  InterpreterContextWire,
  InterpreterSidecarAPI,
  InterpreterSidecarEvent
} from './sidecar-api.js';
import sidecarTarball from './sidecar-package.tgz';
import {
  type CodeContext,
  type CreateContextOptions,
  Execution,
  type ExecutionError,
  type ExecutionResult,
  type OutputMessage,
  type Result,
  type ResultData,
  ResultImpl,
  type RunCodeOptions,
  toResultData
} from './types.js';

export type {
  ChartData,
  CodeContext,
  CreateContextOptions,
  ExecutionError,
  ExecutionResult,
  InterpreterExecutionEvent,
  OutputMessage,
  Result,
  ResultData,
  RunCodeOptions
} from './types.js';
export { Execution, ResultImpl } from './types.js';

const SUPPORTED_LANGUAGES = [
  'python',
  'python3',
  'javascript',
  'js',
  'node',
  'typescript',
  'ts'
];

/** Validate the requested language before issuing a sidecar call. */
function validateLanguage(language: string | undefined): void {
  if (!language) return;
  if (!SUPPORTED_LANGUAGES.includes(language.toLowerCase())) {
    throw new Error(
      `Unsupported language '${language}'. Supported languages: python, javascript, typescript`
    );
  }
}

function toCodeContext(raw: InterpreterContextWire): CodeContext {
  return {
    id: raw.id,
    language: raw.language,
    cwd: raw.cwd,
    createdAt: new Date(raw.createdAt),
    lastUsed: new Date(raw.lastUsed)
  };
}

/**
 * The interpreter extension. Bridges to the sidecar over the extension host;
 * reconstructs streamed execution events into serializable execution results.
 */
export class Interpreter extends SandboxExtension {
  readonly #contexts = new Map<string, CodeContext>();

  constructor(sandbox: SandboxLike) {
    super(sandbox, { tarball: sidecarTarball });
  }

  /** Create a new code execution context. */
  async createCodeContext(
    options: CreateContextOptions = {}
  ): Promise<CodeContext> {
    validateLanguage(options.language);
    const api = await this.sidecar<InterpreterSidecarAPI>();
    const raw = await api.createContext({
      language: options.language,
      cwd: options.cwd
    });
    const context = toCodeContext(raw);
    this.#contexts.set(context.id, context);
    return context;
  }

  /** Run code with optional context, collecting results into serializable data. */
  async runCode(
    code: string,
    options: RunCodeOptions = {}
  ): Promise<ExecutionResult> {
    const context =
      options.context ??
      (await this.#getOrCreateDefaultContext(options.language ?? 'python'));

    const execution = new Execution(code, context);

    const api = await this.sidecar<InterpreterSidecarAPI>();
    await api.runCode(context.id, code, options.language, async (event) => {
      await this.#applyEvent(execution, event, options);
    });

    return execution.toJSON();
  }

  /** Run code and surface raw execution events as an SSE byte stream. */
  async runCodeStream(
    code: string,
    options: RunCodeOptions = {}
  ): Promise<ReadableStream<Uint8Array>> {
    const context =
      options.context ??
      (await this.#getOrCreateDefaultContext(options.language ?? 'python'));

    const encoder = new TextEncoder();
    const self = this;
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const api = await self.sidecar<InterpreterSidecarAPI>();
          await api.runCode(context.id, code, options.language, (event) => {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
            );
          });
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      }
    });
  }

  /** List all code contexts (refreshes the local cache). */
  async listCodeContexts(): Promise<CodeContext[]> {
    const api = await this.sidecar<InterpreterSidecarAPI>();
    const raw = await api.listContexts();
    const contexts = raw.map(toCodeContext);
    for (const context of contexts) {
      this.#contexts.set(context.id, context);
    }
    return contexts;
  }

  /** Delete a code context. */
  async deleteCodeContext(contextId: string): Promise<void> {
    const api = await this.sidecar<InterpreterSidecarAPI>();
    await api.deleteContext(contextId);
    this.#contexts.delete(contextId);
  }

  async #getOrCreateDefaultContext(
    language: 'python' | 'javascript' | 'typescript'
  ): Promise<CodeContext> {
    for (const context of this.#contexts.values()) {
      if (context.language === language) {
        return context;
      }
    }
    return this.createCodeContext({ language });
  }

  async #applyEvent(
    execution: Execution,
    event: InterpreterSidecarEvent,
    options: RunCodeOptions
  ): Promise<void> {
    switch (event.type) {
      case 'stdout': {
        const text = event.text;
        execution.logs.stdout.push(text);
        const message: OutputMessage = { text, timestamp: Date.now() };
        await options.onStdout?.(message);
        break;
      }
      case 'stderr': {
        const text = event.text;
        execution.logs.stderr.push(text);
        const message: OutputMessage = { text, timestamp: Date.now() };
        await options.onStderr?.(message);
        break;
      }
      case 'result': {
        const result = new ResultImpl(event as unknown as Result);
        execution.results.push(result);
        await options.onResult?.(toResultData(result));
        break;
      }
      case 'error': {
        const error: ExecutionError = {
          name: event.ename,
          message: event.evalue,
          traceback: event.traceback ?? []
        };
        execution.error = error;
        await options.onError?.(error);
        break;
      }
      case 'execution_complete': {
        execution.executionCount = event.execution_count;
        break;
      }
    }
  }
}

/** Factory — the consumer-facing API. */
export function withInterpreter(sandbox: SandboxLike): Interpreter {
  return new Interpreter(sandbox);
}
