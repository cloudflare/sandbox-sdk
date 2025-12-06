import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Logger } from '@repo/shared';
import { createLogger } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import { Mutex } from 'async-mutex';
import { CONFIG } from '../config';

// Check if Python is available by trying to invoke the binary
const PYTHON_AVAILABLE = (() => {
  try {
    const result = spawnSync('python3', ['--version'], { timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
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
  private logger: Logger;

  // Track which executor belongs to which context
  private contextExecutors: Map<string, InterpreterProcess> = new Map();

  // Track unassigned executors available for new contexts
  private availableExecutors: Map<InterpreterLanguage, InterpreterProcess[]> =
    new Map();

  // Per-language mutexes for atomic pool operations
  private poolLocks: Map<InterpreterLanguage, Mutex> = new Map();

  // Per-executor mutexes for serializing execution
  private executorLocks: Map<string, Mutex> = new Map();

  constructor(
    customConfigs: Partial<
      Record<InterpreterLanguage, Partial<ExecutorPoolConfig>>
    > = {},
    logger?: Logger
  ) {
    this.logger = logger ?? createLogger({ component: 'executor' });
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
        // Environment variables override user config override defaults
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

  private async borrowExecutor(
    language: InterpreterLanguage
  ): Promise<InterpreterProcess> {
    const mutex = this.poolLocks.get(language)!;
    return await mutex.runExclusive(async () => {
      const available = this.availableExecutors.get(language) || [];
      if (available.length > 0) {
        return available.shift()!;
      }
      // Create temporary executor if none available
      const executor = await this.createProcess(language, undefined);
      const pool = this.pools.get(language)!;
      pool.push(executor);
      return executor;
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

    // Transpile TypeScript to JavaScript using Bun's built-in transpiler
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

    // Check if Python is available
    if (language === 'python' && !PYTHON_AVAILABLE) {
      const version = process.env.SANDBOX_VERSION || '<version>';
      return {
        stdout: '',
        stderr: `Python interpreter not available. Use the cloudflare/sandbox:${version}-python image variant for Python code execution. See https://developers.cloudflare.com/sandbox/configuration/dockerfile/`,
        success: false,
        executionId: randomUUID(),
        outputs: [],
        error: {
          type: ErrorCode.PYTHON_NOT_AVAILABLE,
          message: 'Python interpreter not available in this image variant'
        }
      };
    }

    if (sessionId) {
      // Context execution: Get dedicated executor and lock on it
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

      // Lock on the executor to serialize execution
      const mutex = this.getExecutorLock(contextExecutor.id);
      return await mutex.runExclusive(() =>
        this.executeInProcess(
          contextExecutor,
          codeToExecute,
          totalStartTime,
          timeout
        )
      );
    } else {
      // Stateless execution: Borrow executor, execute, return
      const executor = await this.borrowExecutor(language);
      try {
        const mutex = this.getExecutorLock(executor.id);
        return await mutex.runExclusive(() =>
          this.executeInProcess(
            executor,
            codeToExecute,
            totalStartTime,
            timeout
          )
        );
      } finally {
        await this.returnExecutor(language, executor);
      }
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
    const effectiveTimeout = timeout ?? CONFIG.INTERPRETER_EXECUTION_TIMEOUT_MS;
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
    // Enforce per-language process limit if configured
    const config = this.poolConfigs.get(language)!;
    const pool = this.pools.get(language)!;

    if (
      config.maxProcesses !== undefined &&
      pool.length >= config.maxProcesses
    ) {
      throw new Error(
        `Maximum ${language} executor limit reached (${config.maxProcesses}). Cannot create new executor.`
      );
    }

    const startTime = Date.now();
    const id = randomUUID();
    let command: string;
    let args: string[];

    switch (language) {
      case 'python':
        command = 'python3';
        args = [
          '-u',
          '/container-server/dist/runtime/executors/python/ipython_executor.py'
        ];
        break;
      case 'javascript':
        command = 'node';
        args = [
          '/container-server/dist/runtime/executors/javascript/node_executor.js'
        ];
        break;
      case 'typescript':
        // TypeScript is transpiled in execute(), so use the same JS executor
        command = 'node';
        args = [
          '/container-server/dist/runtime/executors/javascript/node_executor.js'
        ];
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

    // Register exit handler for cleanup
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

      // Clean up from all tracking structures
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
          timeoutMs: CONFIG.INTERPRETER_SPAWN_TIMEOUT_MS,
          stdout: readyBuffer,
          stderr: errorBuffer
        });
        reject(
          new Error(
            `${language} executor failed to start within ${CONFIG.INTERPRETER_SPAWN_TIMEOUT_MS}ms`
          )
        );
      }, CONFIG.INTERPRETER_SPAWN_TIMEOUT_MS);

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
        errorBuffer += data.toString();
        this.logger.debug('Interpreter stderr during spawn', {
          language,
          data: data.toString()
        });
      };

      childProcess.stdout?.on('data', readyHandler);
      childProcess.stderr?.on('data', errorHandler);

      childProcess.once('error', (err) => {
        clearTimeout(timeout);
        this.logger.debug('Interpreter spawn error', {
          language,
          error: err.message
        });
        reject(err);
      });

      childProcess.once('exit', (code) => {
        if (code !== 0) {
          clearTimeout(timeout);
          this.logger.debug('Interpreter exited during spawn', {
            language,
            exitCode: code
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

      // Cleanup function to ensure listener is always removed
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        process.process.stdout?.removeListener('data', responseHandler);
      };

      // Set up timeout ONLY if specified (undefined = unlimited)
      if (timeout !== undefined) {
        timer = setTimeout(() => {
          cleanup();
          // NOTE: We don't kill the child process here because it's a pooled interpreter
          // that may be reused. The timeout is enforced, but the interpreter continues.
          // The executor itself also has its own timeout mechanism for VM execution.
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
        } catch (e) {
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
    // Check if Python is available before trying to create a context
    if (language === 'python' && !PYTHON_AVAILABLE) {
      const version = process.env.SANDBOX_VERSION || '<version>';
      throw new Error(
        `Python interpreter not available. Use the cloudflare/sandbox:${version}-python image variant for Python code execution. See https://developers.cloudflare.com/sandbox/configuration/dockerfile/`
      );
    }

    this.logger.debug('Attempting to reserve executor for context', {
      contextId,
      language,
      availableCount: this.availableExecutors.get(language)?.length || 0
    });

    const mutex = this.poolLocks.get(language)!;
    const mutexWaitStart = Date.now();

    await mutex.runExclusive(async () => {
      const mutexWaitTime = Date.now() - mutexWaitStart;
      this.logger.debug('Acquired mutex for context reservation', {
        contextId,
        language,
        mutexWaitTime
      });

      const available = this.availableExecutors.get(language) || [];

      let executor: InterpreterProcess;

      if (available.length > 0) {
        // Use an available executor
        executor = available.shift()!;
        this.availableExecutors.set(language, available);

        this.logger.debug('Assigned available executor to context', {
          contextId,
          language,
          executorId: executor.id,
          remainingAvailable: available.length
        });
      } else {
        // No available executors, create a new one
        this.logger.debug('No available executors, creating new one', {
          contextId,
          language
        });

        const createStart = Date.now();
        executor = await this.createProcess(language, contextId);
        const createTime = Date.now() - createStart;

        // Add to main pool for tracking
        const pool = this.pools.get(language)!;
        pool.push(executor);

        this.logger.debug('Created new executor for context', {
          contextId,
          language,
          executorId: executor.id,
          createTime
        });
      }

      // Assign executor to context
      executor.sessionId = contextId;

      // Track in contextExecutors map
      this.contextExecutors.set(contextId, executor);

      this.logger.debug('Successfully reserved executor for context', {
        contextId,
        language,
        executorId: executor.id,
        totalTime: Date.now() - mutexWaitStart
      });
    });
  }

  async releaseExecutorForContext(
    contextId: string,
    language: InterpreterLanguage
  ): Promise<void> {
    this.logger.debug('Attempting to release executor for context', {
      contextId,
      language
    });

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
      executorId: executor.id,
      processKilled: executor.process.killed,
      processExitCode: executor.process.exitCode
    });

    // Remove from context ownership map
    this.contextExecutors.delete(contextId);

    // Remove exit handler since we're doing manual cleanup
    if (executor.exitHandler) {
      executor.process.removeListener('exit', executor.exitHandler);
    }

    // Clean up executor lock
    this.executorLocks.delete(executor.id);

    // Terminate the executor process immediately
    if (!executor.process.killed) {
      executor.process.kill();
      this.logger.debug('Killed executor process', {
        contextId,
        executorId: executor.id
      });
    }

    // Remove from main pool
    const pool = this.pools.get(language);
    if (pool) {
      const index = pool.indexOf(executor);
      if (index > -1) {
        pool.splice(index, 1);
        this.logger.debug('Removed executor from pool', {
          contextId,
          executorId: executor.id,
          remainingInPool: pool.length
        });
      }
    }

    // Ensure minimum pool is maintained
    this.logger.debug('Ensuring minimum pool after release', {
      contextId,
      language
    });
    await this.ensureMinimumPool(language);

    this.logger.debug('Successfully released executor for context', {
      contextId,
      language
    });
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

    // Use the dedicated method for creating unassigned executors
    for (let i = 0; i < config.minSize; i++) {
      try {
        await this.createUnassignedExecutor(executor);
      } catch (error) {
        this.logger.debug('Failed to pre-warm process', {
          executor,
          processIndex: i,
          error: error instanceof Error ? error.message : String(error)
        });
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

    // Only clean up unassigned executors from availableExecutors pool
    for (const [language, available] of this.availableExecutors.entries()) {
      const config = this.poolConfigs.get(language);
      if (!config) continue;

      // Iterate backwards to safely remove during iteration
      for (let i = available.length - 1; i >= 0; i--) {
        const process = available[i];
        const idleTime = now.getTime() - process.lastUsed.getTime();

        // Keep minimum pool size, clean up idle executors beyond that
        if (
          idleTime > config.idleTimeout &&
          available.length > config.minSize
        ) {
          process.process.kill();
          available.splice(i, 1);

          // Clean up executor lock
          this.executorLocks.delete(process.id);

          // Also remove from main pool
          const pool = this.pools.get(language);
          if (pool) {
            const poolIndex = pool.indexOf(process);
            if (poolIndex > -1) pool.splice(poolIndex, 1);
          }

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
    const executor = await this.createProcess(language, undefined);

    // Add to available pool
    const available = this.availableExecutors.get(language) || [];
    available.push(executor);
    this.availableExecutors.set(language, available);

    // Add to main pool for tracking
    const pool = this.pools.get(language)!;
    pool.push(executor);

    this.logger.debug('Created unassigned executor', {
      language,
      executorId: executor.id
    });
  }

  // For testing: get executor assigned to context
  getExecutorForContext(contextId: string): InterpreterProcess | undefined {
    return this.contextExecutors.get(contextId);
  }

  // For testing: get available executors for language
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

export const processPool = new ProcessPoolManager();
