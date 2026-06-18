import { randomUUID } from 'node:crypto';
import { SandboxSidecar, serveSandboxSidecar } from '../../sidecar/index.js';
import {
  type InterpreterLanguage,
  ProcessPoolManager,
  type RichOutput
} from './pool';

export interface InterpreterContextWire {
  id: string;
  language: string;
  cwd: string;
  createdAt: string;
  lastUsed: string;
}

export type InterpreterSidecarEvent =
  | { type: 'stdout'; text: string }
  | { type: 'stderr'; text: string }
  | {
      type: 'result';
      metadata: Record<string, unknown>;
      [key: string]: unknown;
    }
  | { type: 'execution_complete'; execution_count: number }
  | { type: 'error'; ename: string; evalue: string; traceback: string[] };

export interface InterpreterSidecarAPI {
  createContext(options: {
    language?: string;
    cwd?: string;
  }): Promise<InterpreterContextWire>;
  listContexts(): Promise<InterpreterContextWire[]>;
  deleteContext(contextId: string): Promise<void>;
  runCode(
    contextId: string,
    code: string,
    language: string | undefined,
    onEvent: (event: InterpreterSidecarEvent) => void | Promise<void>
  ): Promise<void>;
}

class InterpreterSidecar
  extends SandboxSidecar
  implements InterpreterSidecarAPI
{
  readonly #pool = new ProcessPoolManager();
  readonly #contexts = new Map<string, InterpreterContextWire>();

  async createContext(options: {
    language?: string;
    cwd?: string;
  }): Promise<InterpreterContextWire> {
    const id = randomUUID();
    const language = mapLanguage(options.language || 'python');
    const now = new Date().toISOString();
    const context: InterpreterContextWire = {
      id,
      language,
      cwd: options.cwd || '/workspace',
      createdAt: now,
      lastUsed: now
    };

    try {
      await this.#pool.reserveExecutorForContext(id, language);
    } catch (error) {
      await this.#pool.releaseExecutorForContext(id, language).catch(() => {});
      throw error;
    }

    this.#contexts.set(id, context);
    return context;
  }

  async listContexts(): Promise<InterpreterContextWire[]> {
    return Array.from(this.#contexts.values());
  }

  async deleteContext(contextId: string): Promise<void> {
    const context = this.#contexts.get(contextId);
    if (!context) {
      throw new Error(`Code context '${contextId}' not found`);
    }
    try {
      await this.#pool.releaseExecutorForContext(
        contextId,
        context.language as InterpreterLanguage
      );
    } finally {
      this.#contexts.delete(contextId);
    }
  }

  async runCode(
    contextId: string,
    code: string,
    language: string | undefined,
    onEvent: (event: InterpreterSidecarEvent) => void | Promise<void>
  ): Promise<void> {
    const events = await this.#buildExecutionEvents(contextId, code, language);
    for (const event of events) {
      await onEvent(event);
    }
  }

  shutdown(): Promise<void> {
    return this.#pool.shutdown();
  }

  async #buildExecutionEvents(
    contextId: string,
    code: string,
    language?: string
  ): Promise<InterpreterSidecarEvent[]> {
    const context = this.#contexts.get(contextId);
    if (!context) {
      throw new Error(`Context ${contextId} not found`);
    }

    context.lastUsed = new Date().toISOString();

    if (!this.#pool.isContextExecutorHealthy(contextId)) {
      throw new Error(
        'Context executor has terminated. Please delete and recreate the context.'
      );
    }

    const execLanguage = mapLanguage(language || context.language);
    const result = await this.#pool.execute(
      execLanguage,
      code,
      contextId,
      undefined
    );

    const events: InterpreterSidecarEvent[] = [];

    if (result.stdout) {
      events.push({ type: 'stdout', text: result.stdout });
    }
    if (result.stderr) {
      events.push({ type: 'stderr', text: result.stderr });
    }
    if (result.outputs && result.outputs.length > 0) {
      for (const output of result.outputs) {
        events.push({
          type: 'result',
          ...formatOutputData(output),
          metadata: output.metadata || {}
        });
      }
    }

    if (result.success) {
      events.push({ type: 'execution_complete', execution_count: 1 });
    } else if (result.error) {
      events.push({
        type: 'error',
        ename: result.error.type || 'ExecutionError',
        evalue: result.error.message || 'Code execution failed',
        traceback: result.error.traceback
          ? result.error.traceback.split('\n')
          : []
      });
    } else {
      events.push({
        type: 'error',
        ename: 'ExecutionError',
        evalue: result.stderr || 'Code execution failed',
        traceback: []
      });
    }

    return events;
  }
}

function mapLanguage(language: string): InterpreterLanguage {
  switch (language.toLowerCase()) {
    case 'python':
    case 'python3':
      return 'python';
    case 'javascript':
    case 'js':
    case 'node':
      return 'javascript';
    case 'typescript':
    case 'ts':
      return 'typescript';
    default:
      return 'python';
  }
}

function formatOutputData(output: RichOutput): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  switch (output.type) {
    case 'image':
      result.png = output.data;
      break;
    case 'jpeg':
      result.jpeg = output.data;
      break;
    case 'svg':
      result.svg = output.data;
      break;
    case 'html':
      result.html = output.data;
      break;
    case 'json':
      result.json =
        typeof output.data === 'string' ? JSON.parse(output.data) : output.data;
      break;
    case 'latex':
      result.latex = output.data;
      break;
    case 'markdown':
      result.markdown = output.data;
      break;
    case 'javascript':
      result.javascript = output.data;
      break;
    case 'text':
      result.text = output.data;
      break;
    default:
      result.text = output.data || '';
  }

  return result;
}

const sidecar = new InterpreterSidecar();
const server = serveSandboxSidecar(sidecar, {
  readyMessage: 'interpreter-sidecar listening'
});

function shutdown(): void {
  sidecar.shutdown().finally(() => {
    server.close(() => process.exit(0));
  });
}

process.removeAllListeners('SIGTERM');
process.removeAllListeners('SIGINT');
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
