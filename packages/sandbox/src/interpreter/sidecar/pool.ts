/**
 * Interpreter process pool — sidecar edition.
 *
 * Adapted from the container binary's former `runtime/process-pool.ts`. It is
 * intentionally dependency-light (no `@repo/shared`, no container `CONFIG`) so
 * it bundles cleanly into the standalone interpreter sidecar. Executor binaries
 * are resolved relative to the provisioned extension directory (`EXT_DIR`)
 * rather than baked-in container paths.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Mutex, Semaphore } from 'async-mutex';

/** Minimal logger so the pool stays free of host logging dependencies. */
export interface SidecarLogger {
  debug: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  error: (message: string, error?: unknown, meta?: unknown) => void;
}

const noopLogger: SidecarLogger = {
  debug() {},
  warn() {},
  error() {}
};

const EXT_DIR = process.env.EXT_DIR ?? process.cwd();

const SPAWN_TIMEOUT_MS = parseInt(
  process.env.INTERPRETER_SPAWN_TIMEOUT_MS || '60000',
  10
);
const EXECUTION_TIMEOUT_MS = (() => {
  const val = parseInt(process.env.INTERPRETER_EXECUTION_TIMEOUT_MS || '0', 10);
  return val === 0 ? undefined : val;
})();

function summarizeSpawnOutput(data: string): string {
  return data.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function isMissingJavaScriptExecutorError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith('JavaScript executor binary not found')
  );
}

// Check if Python is available by trying to invoke the binary
const PYTHON_AVAILABLE = (() => {
  try {
    const result = spawnSync('python3', ['--version'], { timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
})();

// Prefer Node.js for user code execution: better npm compatibility and more
// predictable vm module behavior. Bun works as a fallback but may have subtle
// differences in edge cases.
const JS_RUNTIME: 'node' | 'bun' | null = (() => {
  try {
    const nodeResult = spawnSync('node', ['--version'], { timeout: 5000 });
    if (nodeResult.status === 0) {
      return 'node';
    }
  } catch {
    // Node.js not available, try Bun
  }

  try {
    const bunResult = spawnSync('bun', ['--version'], { timeout: 5000 });
    if (bunResult.status === 0) {
      return 'bun';
    }
  } catch {
    // Bun not available either
  }

  return null;
})();

export type InterpreterLanguage = 'python' | 'javascript' | 'typescript';

export interface InterpreterProcess {
  id: string;
  language: InterpreterLanguage;
  process: ChildProcess;
  sessionId?: string;
  lastUsed: Date;
  exitHandler?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  success: boolean;
  executionId: string;
  outputs?: RichOutput[];
  error?: {
    type: string;
    message: string;
    traceback?: string;
  };
}

export interface RichOutput {
  type:
    | 'text'
    | 'image'
    | 'jpeg'
    | 'svg'
    | 'html'
    | 'json'
    | 'latex'
    | 'markdown'
    | 'javascript'
    | 'error';
  data: string;
  metadata?: Record<string, unknown>;
}

export interface PoolConfig {
  maxProcesses?: number;
  idleTimeout: number; // milliseconds
  minSize: number;
}

export interface ExecutorPoolConfig extends PoolConfig {
  executor: InterpreterLanguage;
}

const DEFAULT_EXECUTOR_CONFIGS: Record<
  InterpreterLanguage,
  ExecutorPoolConfig
> = {
  python: {
    executor: 'python',
    minSize: 3,
    maxProcesses: undefined, // unlimited by default
    idleTimeout: 5 * 60 * 1000 // 5 minutes
  },
  javascript: {
    executor: 'javascript',
    minSize: 3,
    maxProcesses: undefined, // unlimited by default
    idleTimeout: 5 * 60 * 1000
  },
  typescript: {
    executor: 'typescript',
    minSize: 3,
    maxProcesses: undefined, // unlimited by default
    idleTimeout: 5 * 60 * 1000
  }
};

export class ProcessPoolManager {
  private pools: Map<InterpreterLanguage, InterpreterProcess[]> = new Map();
  private poolConfigs: Map<InterpreterLanguage, ExecutorPoolConfig> = new Map();
  private cleanupInterval?: NodeJS.Timeout;
  private logger: SidecarLogger;

  // Track which executor belongs to which context
  private contextExecutors: Map<string, InterpreterProcess> = new Map();

  // Track unassigned executors available for new contexts
  private availableExecutors: Map<InterpreterLanguage, InterpreterProcess[]> =
    new Map();

  // Per-language mutexes for atomic pool operations
  private poolLocks: Map<InterpreterLanguage, Mutex> = new Map();

  // Per-executor mutexes for serializing execution
  private executorLocks: Map<string, Mutex> = new Map();

  private javascriptExecutorPath?: string;

  // Per-language semaphore enforcing maxProcesses. null = unlimited.
  private spawnLimits: Map<InterpreterLanguage, Semaphore | null> = new Map();

  // One-shot release functions keyed by process ID.
  private processReleasers: Map<string, () => void> = new Map();

  constructor(
    customConfigs: Partial<
      Record<InterpreterLanguage, Partial<ExecutorPoolConfig>>
    > = {},
    logger: SidecarLogger = noopLogger
  ) {
    this.logger = logger;
    const executorEntries = Object.entries(DEFAULT_EXECUTOR_CONFIGS) as [
      InterpreterLanguage,
      ExecutorPoolConfig
    ][];

    for (const [executor, defaultConfig] of executorEntries) {
      const userConfig = customConfigs[executor] || {};
      const envMinSize = process.env[`${executor.toUpperCase()}_POOL_MIN_SIZE`];
      const envMaxSize = process.env[`${executor.toUpperCase()}_POOL_MAX_SIZE`];

      const config: ExecutorPoolConfig = {
        ...defaultConfig,
        ...userConfig,
        minSize: envMinSize
          ? parseInt(envMinSize, 10)
          : userConfig.minSize || defaultConfig.minSize,
        maxProcesses: envMaxSize
          ? parseInt(envMaxSize, 10)
          : userConfig.maxProcesses !== undefined
            ? userConfig.maxProcesses
            : defaultConfig.maxProcesses
      };

      this.poolConfigs.set(executor, config);
      this.pools.set(executor, []);
      this.availableExecutors.set(executor, []);
      this.poolLocks.set(executor, new Mutex());
      this.spawnLimits.set(
        executor,
        config.maxProcesses !== undefined
          ? new Semaphore(config.maxProcesses)
          : null
      );
    }

    const pythonConfig = this.poolConfigs.get('python');
    if (pythonConfig) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupIdleProcesses();
      }, pythonConfig.idleTimeout / 2);
    }

    // Start pre-warming in background - don't block constructor
    this.startPreWarming().catch((error) => {
      this.logger.debug('Pre-warming failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private getExecutorLock(executorId: string): Mutex {
    const mutex = this.executorLocks.get(executorId);
    if (!mutex) {
      throw new Error(`No mutex found for executor ${executorId}`);
    }
    return mutex;
  }

  private resolveJavaScriptExecutorPath(): string {
    if (this.javascriptExecutorPath) {
      return this.javascriptExecutorPath;
    }

    const candidates = [
      join(EXT_DIR, 'executors/javascript/node_executor.mjs'),
      join(EXT_DIR, 'executors/javascript/node_executor.js')
    ];
    const resolved = candidates.find((path) => existsSync(path));

    if (!resolved) {
      throw new Error(
        `JavaScript executor binary not found. Checked: ${candidates.join(', ')}`
      );
    }

    this.logger.debug('Resolved JavaScript executor path', { path: resolved });
    this.javascriptExecutorPath = resolved;
    return resolved;
  }

  private pythonExecutorPath(): string {
    return join(EXT_DIR, 'executors/python/ipython_executor.py');
  }

  private releaseProcessSlot(processId: string): void {
    const releaser = this.processReleasers.get(processId);
    if (releaser) {
      releaser();
      this.processReleasers.delete(processId);
    }
  }

  private async spawnAndRegister(
    language: InterpreterLanguage,
    sessionId: string | undefined,
    onSpawned: (executor: InterpreterProcess) => void
  ): Promise<InterpreterProcess> {
    const mutex = this.poolLocks.get(language)!;
    const semaphore = this.spawnLimits.get(language) ?? null;

    const release = semaphore
      ? await mutex.runExclusive(async () => {
          if (semaphore.getValue() === 0) {
            const config = this.poolConfigs.get(language)!;
            throw new Error(
              `Maximum ${language} executor limit reached (${config.maxProcesses}). Cannot create new executor.`
            );
          }
          return (await semaphore.acquire())[1];
        })
      : null;

    let executor: InterpreterProcess;
    try {
      executor = await this.createProcess(language, sessionId);
    } catch (err) {
      release?.();
      throw err;
    }

    if (release) this.processReleasers.set(executor.id, release);

    try {
      await mutex.runExclusive(() => {
        if (
          executor.process.exitCode !== null ||
          executor.process.signalCode !== null
        ) {
          throw new Error(
            `Process exited before registration (exit=${executor.process.exitCode}, signal=${executor.process.signalCode})`
          );
        }
        onSpawned(executor);
      });
      return executor;
    } catch (err) {
      if (executor.exitHandler) {
        executor.process.removeListener('exit', executor.exitHandler);
      }
      executor.process.kill();
      this.executorLocks.delete(executor.id);
      this.releaseProcessSlot(executor.id);
      throw err;
    }
  }

  private async borrowExecutor(
    language: InterpreterLanguage
  ): Promise<InterpreterProcess> {
    const mutex = this.poolLocks.get(language)!;

    const existing = await mutex.runExclusive(() => {
      const available = this.availableExecutors.get(language) || [];
      if (available.length > 0) {
        return available.shift()!;
      }
      return null;
    });

    if (existing) return existing;

    return await this.spawnAndRegister(language, undefined, (executor) => {
      const pool = this.pools.get(language)!;
      pool.push(executor);
    });
  }

  private async returnExecutor(
    language: InterpreterLanguage,
    executor: InterpreterProcess
  ): Promise<void> {
    const mutex = this.poolLocks.get(language)!;
    await mutex.runExclusive(async () => {
      const available = this.availableExecutors.get(language) || [];
      available.push(executor);
      this.availableExecutors.set(language, available);
    });
  }

  async execute(
    language: InterpreterLanguage,
    code: string,
    sessionId?: string,
    timeout?: number
  ): Promise<ExecutionResult> {
    const totalStartTime = Date.now();

    let codeToExecute = code;
    if (language === 'typescript') {
      try {
        const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'node' });
        codeToExecute = transpiler.transformSync(code);
      } catch (err) {
        const error = err as Error;
        return {
          stdout: '',
          stderr: `TypeScript compilation error: ${error.message}`,
          success: false,
          executionId: randomUUID(),
          outputs: [],
          error: {
            type: 'TranspileError',
            message: error.message,
            traceback: error.stack
          }
        };
      }
    }

    if (language === 'python' && !PYTHON_AVAILABLE) {
      const version = process.env.SANDBOX_VERSION || '<version>';
      return {
        stdout: '',
        stderr: `Python interpreter not available. Use the cloudflare/sandbox:${version}-python image variant for Python code execution. See https://developers.cloudflare.com/sandbox/configuration/dockerfile/`,
        success: false,
        executionId: randomUUID(),
        outputs: [],
        error: {
          type: 'PYTHON_NOT_AVAILABLE',
          message: 'Python interpreter not available in this image variant'
        }
      };
    }

    if (
      (language === 'javascript' || language === 'typescript') &&
      !JS_RUNTIME
    ) {
      return {
        stdout: '',
        stderr: `JavaScript runtime not available. JavaScript/TypeScript code execution requires Node.js or Bun to be installed in the container.`,
        success: false,
        executionId: randomUUID(),
        outputs: [],
        error: {
          type: 'JAVASCRIPT_NOT_AVAILABLE',
          message:
            'JavaScript runtime (Node.js or Bun) not available in this container'
        }
      };
    }

    if (sessionId) {
      const contextExecutor = this.contextExecutors.get(sessionId);

      if (!contextExecutor || contextExecutor.process.killed) {
        if (contextExecutor) {
          this.contextExecutors.delete(sessionId);
        }
        throw new Error(
          `Context ${sessionId} not found or executor process terminated`
        );
      }

      if (contextExecutor.language !== language) {
        throw new Error(
          `Context ${sessionId} was created for ${contextExecutor.language}, cannot execute ${language} code`
        );
      }

      const mutex = this.getExecutorLock(contextExecutor.id);
      return await mutex.runExclusive(() =>
        this.executeInProcess(
          contextExecutor,
          codeToExecute,
          totalStartTime,
          timeout
        )
      );
    }

    const executor = await this.borrowExecutor(language);
    try {
      const mutex = this.getExecutorLock(executor.id);
      return await mutex.runExclusive(() =>
        this.executeInProcess(executor, codeToExecute, totalStartTime, timeout)
      );
    } finally {
      await this.returnExecutor(language, executor);
    }
  }

  private async executeInProcess(
    process: InterpreterProcess,
    code: string,
    totalStartTime: number,
    timeout?: number
  ): Promise<ExecutionResult> {
    const processAcquireTime = Date.now() - totalStartTime;
    const executionId = randomUUID();

    const execStartTime = Date.now();
    const effectiveTimeout = timeout ?? EXECUTION_TIMEOUT_MS;
    const result = await this.executeCode(
      process,
      code,
      executionId,
      effectiveTimeout
    );
    const execTime = Date.now() - execStartTime;
    const totalTime = Date.now() - totalStartTime;

    this.logger.debug('Code execution complete', {
      processAcquireTime,
      execTime,
      totalTime,
      language: process.language
    });

    return result;
  }

  private async createProcess(
    language: InterpreterLanguage,
    sessionId?: string
  ): Promise<InterpreterProcess> {
    const startTime = Date.now();
    const id = randomUUID();
    let command: string;
    let args: string[];

    switch (language) {
      case 'python':
        command = 'python3';
        args = ['-u', this.pythonExecutorPath()];
        break;
      case 'javascript':
        command = JS_RUNTIME!;
        args = [this.resolveJavaScriptExecutorPath()];
        break;
      case 'typescript':
        command = JS_RUNTIME!;
        args = [this.resolveJavaScriptExecutorPath()];
        break;
    }

    this.logger.debug('Spawning interpreter process', {
      language,
      command,
      args: args.join(' ')
    });

    const childProcess = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        NODE_NO_WARNINGS: '1'
      },
      cwd: '/workspace'
    });

    const interpreterProcess: InterpreterProcess = {
      id,
      language,
      process: childProcess,
      sessionId,
      lastUsed: new Date()
    };

    this.executorLocks.set(id, new Mutex());

    const exitHandler = (
      code: number | null,
      signal: NodeJS.Signals | null
    ) => {
      this.logger.warn('Executor process exited unexpectedly', {
        language,
        processId: id,
        sessionId,
        exitCode: code,
        signal
      });

      if (sessionId) {
        this.contextExecutors.delete(sessionId);
      }

      const pool = this.pools.get(language);
      if (pool) {
        const index = pool.indexOf(interpreterProcess);
        if (index > -1) pool.splice(index, 1);
      }

      const available = this.availableExecutors.get(language);
      if (available) {
        const index = available.indexOf(interpreterProcess);
        if (index > -1) available.splice(index, 1);
      }

      this.executorLocks.delete(id);
      this.releaseProcessSlot(id);
    };

    interpreterProcess.exitHandler = exitHandler;
    childProcess.once('exit', exitHandler);

    return new Promise((resolve, reject) => {
      let readyBuffer = '';
      let errorBuffer = '';

      const timeout = setTimeout(() => {
        childProcess.kill();
        this.logger.debug('Interpreter spawn timeout', {
          language,
          timeoutMs: SPAWN_TIMEOUT_MS,
          stdout: readyBuffer,
          stderr: errorBuffer
        });
        reject(
          new Error(
            `${language} executor failed to start within ${SPAWN_TIMEOUT_MS}ms`
          )
        );
      }, SPAWN_TIMEOUT_MS);

      const readyHandler = (data: Buffer) => {
        readyBuffer += data.toString();
        this.logger.debug('Interpreter stdout during spawn', {
          language,
          data: data.toString()
        });

        if (readyBuffer.includes('"ready"')) {
          clearTimeout(timeout);
          childProcess.stdout?.removeListener('data', readyHandler);
          childProcess.stderr?.removeListener('data', errorHandler);
          const readyTime = Date.now() - startTime;
          this.logger.debug('Interpreter process ready', {
            language,
            processId: id,
            readyTime
          });
          resolve(interpreterProcess);
        }
      };

      const errorHandler = (data: Buffer) => {
        const chunk = data.toString();
        errorBuffer += chunk;
        this.logger.debug('Interpreter stderr during spawn', {
          language,
          bytes: data.length,
          preview: summarizeSpawnOutput(chunk)
        });
      };

      childProcess.stdout?.on('data', readyHandler);
      childProcess.stderr?.on('data', errorHandler);

      childProcess.once('error', (err) => {
        clearTimeout(timeout);
        const nodeError = err as NodeJS.ErrnoException;
        this.logger.debug('Interpreter spawn error', {
          language,
          errorMessage: err.message,
          errorCode: nodeError.code,
          errorName: err.name
        });
        reject(err);
      });

      childProcess.once('exit', (code) => {
        if (code !== 0) {
          clearTimeout(timeout);
          this.logger.debug('Interpreter exited during spawn', {
            language,
            exitCode: code,
            stderrPreview: summarizeSpawnOutput(errorBuffer)
          });
          reject(new Error(`${language} executor exited with code ${code}`));
        }
      });
    });
  }

  private async executeCode(
    process: InterpreterProcess,
    code: string,
    executionId: string,
    timeout?: number
  ): Promise<ExecutionResult> {
    const request = JSON.stringify({ code, executionId, timeout });

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let responseBuffer = '';

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        process.process.stdout?.removeListener('data', responseHandler);
      };

      if (timeout !== undefined) {
        timer = setTimeout(() => {
          cleanup();
          reject(new Error('Execution timeout'));
        }, timeout);
      }

      const responseHandler = (data: Buffer) => {
        responseBuffer += data.toString();

        try {
          const response = JSON.parse(responseBuffer);
          cleanup();

          resolve({
            stdout: response.stdout || '',
            stderr: response.stderr || '',
            success: response.success !== false,
            executionId,
            outputs: response.outputs || [],
            error: response.error || null
          });
        } catch {
          // Incomplete JSON, keep buffering
        }
      };

      process.process.stdout?.on('data', responseHandler);
      process.process.stdin?.write(`${request}\n`);
    });
  }

  async reserveExecutorForContext(
    contextId: string,
    language: InterpreterLanguage
  ): Promise<void> {
    if (language === 'python' && !PYTHON_AVAILABLE) {
      const version = process.env.SANDBOX_VERSION || '<version>';
      throw new Error(
        `Python interpreter not available. Use the cloudflare/sandbox:${version}-python image variant for Python code execution. See https://developers.cloudflare.com/sandbox/configuration/dockerfile/`
      );
    }

    if (
      (language === 'javascript' || language === 'typescript') &&
      !JS_RUNTIME
    ) {
      throw new Error(
        `JavaScript runtime not available. JavaScript/TypeScript code execution requires Node.js or Bun to be installed in the container.`
      );
    }

    const mutex = this.poolLocks.get(language)!;

    const existing = await mutex.runExclusive(() => {
      const available = this.availableExecutors.get(language) || [];
      if (available.length > 0) {
        const executor = available.shift()!;
        this.availableExecutors.set(language, available);
        executor.sessionId = contextId;
        this.contextExecutors.set(contextId, executor);

        this.logger.debug('Assigned available executor to context', {
          contextId,
          language,
          executorId: executor.id
        });
        return executor;
      }

      return null;
    });

    if (existing) return;

    await this.spawnAndRegister(language, contextId, (executor) => {
      const pool = this.pools.get(language)!;
      pool.push(executor);
      executor.sessionId = contextId;
      this.contextExecutors.set(contextId, executor);

      this.logger.debug('Created new executor for context', {
        contextId,
        language,
        executorId: executor.id
      });
    });
  }

  async releaseExecutorForContext(
    contextId: string,
    language: InterpreterLanguage
  ): Promise<void> {
    const executor = this.contextExecutors.get(contextId);
    if (!executor) {
      this.logger.debug('Context already released or never existed', {
        contextId
      });
      return;
    }

    this.logger.debug('Releasing executor for context', {
      contextId,
      language,
      executorId: executor.id
    });

    this.contextExecutors.delete(contextId);

    if (executor.exitHandler) {
      executor.process.removeListener('exit', executor.exitHandler);
    }

    this.executorLocks.delete(executor.id);
    executor.process.kill();

    const pool = this.pools.get(language);
    if (pool) {
      const index = pool.indexOf(executor);
      if (index > -1) {
        pool.splice(index, 1);
      }
    }

    this.releaseProcessSlot(executor.id);

    await this.ensureMinimumPool(language);
  }

  isContextExecutorHealthy(contextId: string): boolean {
    const executor = this.contextExecutors.get(contextId);
    if (!executor) {
      return false;
    }
    return !executor.process.killed && executor.process.exitCode === null;
  }

  private async startPreWarming(): Promise<void> {
    this.logger.debug('Starting pre-warming for all executors');
    const startTime = Date.now();

    const warmupPromises = Array.from(this.poolConfigs.entries()).map(
      async ([executor, config]) => {
        if (config.minSize > 0) {
          await this.preWarmExecutor(executor, config);
        }
      }
    );

    try {
      await Promise.all(warmupPromises);
      const totalTime = Date.now() - startTime;
      this.logger.debug('Pre-warming complete for all executors', {
        totalTime
      });
    } catch (error) {
      this.logger.debug('Pre-warming failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async preWarmExecutor(
    executor: InterpreterLanguage,
    config: ExecutorPoolConfig
  ): Promise<void> {
    const startTime = Date.now();
    this.logger.debug('Pre-warming executor', {
      executor,
      targetCount: config.minSize
    });

    for (let i = 0; i < config.minSize; i++) {
      try {
        await this.createUnassignedExecutor(executor);
      } catch (error) {
        this.logger.debug('Failed to pre-warm process', {
          executor,
          processIndex: i,
          errorMessage: error instanceof Error ? error.message : String(error)
        });

        if (isMissingJavaScriptExecutorError(error)) {
          break;
        }
      }
    }

    const warmupTime = Date.now() - startTime;
    const actualCount = this.availableExecutors.get(executor)?.length || 0;
    this.logger.debug('Pre-warming executor complete', {
      executor,
      actualCount,
      targetCount: config.minSize,
      warmupTime
    });
  }

  private cleanupIdleProcesses(): void {
    const now = new Date();

    for (const [language, available] of this.availableExecutors.entries()) {
      const config = this.poolConfigs.get(language);
      if (!config) continue;

      for (let i = available.length - 1; i >= 0; i--) {
        const process = available[i];
        const idleTime = now.getTime() - process.lastUsed.getTime();

        if (
          idleTime > config.idleTimeout &&
          available.length > config.minSize
        ) {
          if (process.exitHandler) {
            process.process.removeListener('exit', process.exitHandler);
          }
          process.process.kill();
          available.splice(i, 1);

          this.executorLocks.delete(process.id);

          const pool = this.pools.get(language);
          if (pool) {
            const poolIndex = pool.indexOf(process);
            if (poolIndex > -1) pool.splice(poolIndex, 1);
          }

          this.releaseProcessSlot(process.id);

          this.logger.debug('Cleaned up idle unassigned executor', {
            language,
            remainingAvailable: available.length
          });
        }
      }
    }
  }

  async ensureMinimumPool(language: InterpreterLanguage): Promise<void> {
    const config = this.poolConfigs.get(language);
    if (!config) return;

    const available = this.availableExecutors.get(language) || [];
    const currentAvailable = available.length;
    const needed = config.minSize - currentAvailable;

    if (needed > 0) {
      this.logger.debug('Replenishing minimum pool', {
        language,
        currentAvailable,
        needed,
        targetMinimum: config.minSize
      });

      const spawnPromises: Promise<void>[] = [];
      for (let i = 0; i < needed; i++) {
        spawnPromises.push(this.createUnassignedExecutor(language));
      }
      await Promise.all(spawnPromises);
    }
  }

  private async createUnassignedExecutor(
    language: InterpreterLanguage
  ): Promise<void> {
    await this.spawnAndRegister(language, undefined, (executor) => {
      const available = this.availableExecutors.get(language) || [];
      available.push(executor);
      this.availableExecutors.set(language, available);

      const pool = this.pools.get(language)!;
      pool.push(executor);

      this.logger.debug('Created unassigned executor', {
        language,
        executorId: executor.id
      });
    });
  }

  getExecutorForContext(contextId: string): InterpreterProcess | undefined {
    return this.contextExecutors.get(contextId);
  }

  getAvailableExecutors(language: InterpreterLanguage): InterpreterProcess[] {
    return this.availableExecutors.get(language) || [];
  }

  async shutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    const executors = Array.from(this.pools.keys());
    for (const executor of executors) {
      const pool = this.pools.get(executor);
      if (pool) {
        for (const process of pool) {
          process.process.kill();
        }
      }
    }

    this.pools.clear();
    this.executorLocks.clear();
  }
}
