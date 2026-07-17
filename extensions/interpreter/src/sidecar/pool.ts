import { randomUUID } from 'node:crypto';
import { Mutex, Semaphore } from 'async-mutex';
import {
  DEFAULT_EXECUTOR_CONFIGS,
  EXECUTION_TIMEOUT_MS,
  isMissingJavaScriptExecutorError
} from './config';
import {
  assertLanguageAvailable,
  executionAvailabilityError,
  prepareCode
} from './language-support';
import { SidecarProcessLifecycle } from './lifecycle';
import {
  type ExecutionResult,
  type ExecutorPoolConfig,
  type InterpreterLanguage,
  type InterpreterProcess,
  noopLogger,
  type SidecarLogger
} from './types';

export type {
  ExecutionResult,
  ExecutorPoolConfig,
  InterpreterLanguage,
  InterpreterProcess,
  PoolConfig,
  RichOutput,
  SidecarLogger
} from './types';
export class ProcessPoolManager {
  private pools: Map<InterpreterLanguage, InterpreterProcess[]> = new Map();
  private poolConfigs: Map<InterpreterLanguage, ExecutorPoolConfig> = new Map();
  private cleanupInterval?: NodeJS.Timeout;
  private logger: SidecarLogger;
  private lifecycle: SidecarProcessLifecycle;
  // Context executors are reserved until explicit context release.
  private contextExecutors: Map<string, InterpreterProcess> = new Map();
  // Available executors are unassigned and reusable for non-context executions.
  private availableExecutors: Map<InterpreterLanguage, InterpreterProcess[]> =
    new Map();
  // Per-language mutexes protect pool and available-executor membership.
  private poolLocks: Map<InterpreterLanguage, Mutex> = new Map();
  // Per-executor mutexes serialize code execution on a single process.
  private executorLocks: Map<string, Mutex> = new Map();
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
    this.lifecycle = new SidecarProcessLifecycle(logger, {
      registerExecutorLock: (executorId, mutex) => {
        this.executorLocks.set(executorId, mutex);
      },
      releaseProcessSlot: (processId) => {
        this.releaseProcessSlot(processId);
      },
      handleProcessExit: (executor) => {
        this.removeExecutorFromState(executor);
      }
    });
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
      executor = await this.lifecycle.createProcess(language, sessionId);
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
      this.removeExecutorFromState(executor);
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
    await mutex.runExclusive(() => {
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
    const codeToExecute = prepareCode(language, code);
    if (typeof codeToExecute !== 'string') return codeToExecute;
    const availabilityError = executionAvailabilityError(language);
    if (availabilityError) return availabilityError;
    if (sessionId) {
      const contextExecutor = this.contextExecutors.get(sessionId);
      if (!contextExecutor || contextExecutor.process.killed) {
        if (contextExecutor) this.contextExecutors.delete(sessionId);
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
    const result = await this.lifecycle.executeCode(
      process,
      code,
      executionId,
      timeout ?? EXECUTION_TIMEOUT_MS
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
  async reserveExecutorForContext(
    contextId: string,
    language: InterpreterLanguage
  ): Promise<void> {
    assertLanguageAvailable(language);
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
    if (executor.exitHandler) {
      executor.process.removeListener('exit', executor.exitHandler);
    }
    executor.process.kill();
    this.removeExecutorFromState(executor);
    this.releaseProcessSlot(executor.id);
    await this.ensureMinimumPool(language);
  }
  isContextExecutorHealthy(contextId: string): boolean {
    const executor = this.contextExecutors.get(contextId);
    if (!executor) return false;
    return !executor.process.killed && executor.process.exitCode === null;
  }
  private async startPreWarming(): Promise<void> {
    this.logger.debug('Starting pre-warming for all executors');
    const startTime = Date.now();
    const warmupPromises = Array.from(this.poolConfigs.entries()).map(
      async ([executor, config]) => {
        if (config.minSize > 0) await this.preWarmExecutor(executor, config);
      }
    );
    try {
      await Promise.all(warmupPromises);
      this.logger.debug('Pre-warming complete for all executors', {
        totalTime: Date.now() - startTime
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
        if (isMissingJavaScriptExecutorError(error)) break;
      }
    }
    const actualCount = this.availableExecutors.get(executor)?.length || 0;
    this.logger.debug('Pre-warming executor complete', {
      executor,
      actualCount,
      targetCount: config.minSize,
      warmupTime: Date.now() - startTime
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
          this.removeExecutorFromState(process);
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
      await Promise.all(
        Array.from({ length: needed }, () =>
          this.createUnassignedExecutor(language)
        )
      );
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
  private removeExecutorFromState(executor: InterpreterProcess): void {
    if (executor.sessionId) this.contextExecutors.delete(executor.sessionId);
    const pool = this.pools.get(executor.language);
    if (pool) {
      const index = pool.indexOf(executor);
      if (index > -1) pool.splice(index, 1);
    }
    const available = this.availableExecutors.get(executor.language);
    if (available) {
      const index = available.indexOf(executor);
      if (index > -1) available.splice(index, 1);
    }
    this.executorLocks.delete(executor.id);
  }
  getExecutorForContext(contextId: string): InterpreterProcess | undefined {
    return this.contextExecutors.get(contextId);
  }
  getAvailableExecutors(language: InterpreterLanguage): InterpreterProcess[] {
    return this.availableExecutors.get(language) || [];
  }
  async shutdown(): Promise<void> {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    const executors = Array.from(this.pools.keys());
    for (const executor of executors) {
      const pool = this.pools.get(executor);
      if (pool) {
        for (const process of pool) process.process.kill();
      }
    }
    this.pools.clear();
    this.executorLocks.clear();
  }
}
