import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Logger } from '@repo/shared';
import { createLogger } from '@repo/shared';
import { CONFIG } from '../config';

export type InterpreterLanguage = 'python' | 'javascript' | 'typescript';

export interface InterpreterProcess {
  id: string;
  language: InterpreterLanguage;
  process: ChildProcess;
  sessionId?: string;
  lastUsed: Date;
  isAvailable: boolean;
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
  maxProcesses: number;
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
    maxProcesses: 15,
    idleTimeout: 5 * 60 * 1000 // 5 minutes
  },
  javascript: {
    executor: 'javascript',
    minSize: 3,
    maxProcesses: 10,
    idleTimeout: 5 * 60 * 1000
  },
  typescript: {
    executor: 'typescript',
    minSize: 3,
    maxProcesses: 10,
    idleTimeout: 5 * 60 * 1000
  }
};

export class ProcessPoolManager {
  private pools: Map<InterpreterLanguage, InterpreterProcess[]> = new Map();
  private poolConfigs: Map<InterpreterLanguage, ExecutorPoolConfig> = new Map();
  private cleanupInterval?: NodeJS.Timeout;
  private logger: Logger;

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
          : userConfig.maxProcesses || defaultConfig.maxProcesses
      };

      this.poolConfigs.set(executor, config);
      this.pools.set(executor, []);
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

  async execute(
    language: InterpreterLanguage,
    code: string,
    sessionId?: string,
    timeout?: number
  ): Promise<ExecutionResult> {
    const totalStartTime = Date.now();
    const process = await this.getProcess(language, sessionId);
    const processAcquireTime = Date.now() - totalStartTime;

    const executionId = randomUUID();

    try {
      const execStartTime = Date.now();
      // Use provided timeout, or fall back to config (which may be undefined = unlimited)
      const effectiveTimeout =
        timeout ?? CONFIG.INTERPRETER_EXECUTION_TIMEOUT_MS;
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
        language
      });
      return result;
    } finally {
      this.releaseProcess(process, sessionId);
    }
  }

  private async getProcess(
    language: InterpreterLanguage,
    sessionId?: string
  ): Promise<InterpreterProcess> {
    const pool = this.pools.get(language)!;

    if (sessionId) {
      const existingProcess = pool.find(
        (p) => p.sessionId === sessionId && p.isAvailable
      );
      if (existingProcess) {
        existingProcess.isAvailable = false;
        existingProcess.lastUsed = new Date();
        return existingProcess;
      }
    }

    const availableProcess = pool.find((p) => p.isAvailable && !p.sessionId);
    if (availableProcess) {
      availableProcess.isAvailable = false;
      availableProcess.sessionId = sessionId;
      availableProcess.lastUsed = new Date();
      return availableProcess;
    }

    const config = this.poolConfigs.get(language)!;
    if (pool.length < config.maxProcesses) {
      const newProcess = await this.createProcess(language, sessionId);
      pool.push(newProcess);
      return newProcess;
    }

    return new Promise((resolve) => {
      const checkForAvailable = () => {
        const available = pool.find((p) => p.isAvailable);
        if (available) {
          available.isAvailable = false;
          available.sessionId = sessionId;
          available.lastUsed = new Date();
          resolve(available);
        } else {
          setTimeout(checkForAvailable, 100);
        }
      };
      checkForAvailable();
    });
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
        command = 'node';
        args = [
          '/container-server/dist/runtime/executors/typescript/ts_executor.js'
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
      lastUsed: new Date(),
      isAvailable: false
    };

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

  private releaseProcess(
    process: InterpreterProcess,
    sessionId?: string
  ): void {
    if (!sessionId) {
      process.sessionId = undefined;
      process.isAvailable = true;
    } else {
      process.isAvailable = true;
    }
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

    const pool = this.pools.get(executor);
    if (!pool) {
      this.logger.debug('No pool found for executor', { executor });
      return;
    }

    for (let i = 0; i < config.minSize; i++) {
      try {
        const sessionId = `pre-warm-${executor}-${i}-${Date.now()}`;
        const process = await this.createProcess(executor, sessionId);

        process.isAvailable = true;
        process.sessionId = undefined;
        pool.push(process);
      } catch (error) {
        this.logger.debug('Failed to pre-warm process', {
          executor,
          processIndex: i,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const warmupTime = Date.now() - startTime;
    const actualCount = pool.filter((p) => p.isAvailable).length;
    this.logger.debug('Pre-warming executor complete', {
      executor,
      actualCount,
      targetCount: config.minSize,
      warmupTime
    });
  }

  private cleanupIdleProcesses(): void {
    const now = new Date();

    const executors = Array.from(this.pools.keys());
    for (const executor of executors) {
      const pool = this.pools.get(executor);
      const config = this.poolConfigs.get(executor);

      if (!pool || !config) {
        continue;
      }

      for (let i = pool.length - 1; i >= 0; i--) {
        const process = pool[i];
        const idleTime = now.getTime() - process.lastUsed.getTime();

        // Only clean up excess processes beyond minimum pool size
        if (
          process.isAvailable &&
          idleTime > config.idleTimeout &&
          pool.filter((p) => p.isAvailable).length > config.minSize
        ) {
          process.process.kill();
          pool.splice(i, 1);
          this.logger.debug('Cleaned up idle process', {
            executor,
            remainingCount: pool.length
          });
        }
      }
    }
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
  }
}

export const processPool = new ProcessPoolManager();
