import { spawnSync } from 'node:child_process';
import type { ExecutorPoolConfig, InterpreterLanguage } from './types';

export const SPAWN_TIMEOUT_MS = parseInt(
  process.env.INTERPRETER_SPAWN_TIMEOUT_MS || '60000',
  10
);

export const EXECUTION_TIMEOUT_MS = (() => {
  const val = parseInt(process.env.INTERPRETER_EXECUTION_TIMEOUT_MS || '0', 10);
  return val === 0 ? undefined : val;
})();

export const DEFAULT_EXECUTOR_CONFIGS: Record<
  InterpreterLanguage,
  ExecutorPoolConfig
> = {
  python: {
    executor: 'python',
    minSize: 3,
    maxProcesses: undefined,
    idleTimeout: 5 * 60 * 1000
  },
  javascript: {
    executor: 'javascript',
    minSize: 3,
    maxProcesses: undefined,
    idleTimeout: 5 * 60 * 1000
  },
  typescript: {
    executor: 'typescript',
    minSize: 3,
    maxProcesses: undefined,
    idleTimeout: 5 * 60 * 1000
  }
};

export function summarizeSpawnOutput(data: string): string {
  return data.replace(/\s+/g, ' ').trim().slice(0, 240);
}

export function isMissingJavaScriptExecutorError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith('JavaScript executor binary not found')
  );
}

export const PYTHON_AVAILABLE = (() => {
  try {
    const result = spawnSync('python3', ['--version'], { timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
})();

// Prefer Node.js for user code execution: better npm compatibility and more
// predictable vm module behavior. Bun works as a fallback but may differ in
// edge cases.
export const JS_RUNTIME: 'node' | 'bun' | null = (() => {
  try {
    const nodeResult = spawnSync('node', ['--version'], { timeout: 5000 });
    if (nodeResult.status === 0) {
      return 'node';
    }
  } catch {
    // Node.js not available, try Bun.
  }

  try {
    const bunResult = spawnSync('bun', ['--version'], { timeout: 5000 });
    if (bunResult.status === 0) {
      return 'bun';
    }
  } catch {
    // Bun not available either.
  }

  return null;
})();
