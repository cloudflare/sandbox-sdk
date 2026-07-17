import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mutex } from 'async-mutex';
import { JS_RUNTIME, SPAWN_TIMEOUT_MS, summarizeSpawnOutput } from './config';
import type {
  ExecutionResult,
  InterpreterLanguage,
  InterpreterProcess,
  SidecarLogger
} from './types';

const SIDECAR_DIST_DIR = dirname(fileURLToPath(import.meta.url));

interface ProcessLifecycleHooks {
  registerExecutorLock: (executorId: string, mutex: Mutex) => void;
  releaseProcessSlot: (processId: string) => void;
  handleProcessExit: (executor: InterpreterProcess) => void;
}

/** Owns child-process protocol and path resolution; pool membership lives above. */
export class SidecarProcessLifecycle {
  private javascriptExecutorPath?: string;

  constructor(
    private logger: SidecarLogger,
    private hooks: ProcessLifecycleHooks
  ) {}

  async createProcess(
    language: InterpreterLanguage,
    sessionId?: string
  ): Promise<InterpreterProcess> {
    const startTime = Date.now();
    const id = randomUUID();
    const { command, args } = this.spawnCommand(language);

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

    this.hooks.registerExecutorLock(id, new Mutex());

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

      this.hooks.handleProcessExit(interpreterProcess);
      this.hooks.releaseProcessSlot(id);
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

  async executeCode(
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
          // Incomplete JSON, keep buffering.
        }
      };

      process.process.stdout?.on('data', responseHandler);
      process.process.stdin?.write(`${request}\n`);
    });
  }

  private spawnCommand(language: InterpreterLanguage): {
    command: string;
    args: string[];
  } {
    switch (language) {
      case 'python':
        return { command: 'python3', args: ['-u', this.pythonExecutorPath()] };
      case 'javascript':
      case 'typescript':
        return {
          command: JS_RUNTIME!,
          args: [this.resolveJavaScriptExecutorPath()]
        };
    }
  }

  private resolveJavaScriptExecutorPath(): string {
    if (this.javascriptExecutorPath) {
      return this.javascriptExecutorPath;
    }

    const candidates = [
      join(SIDECAR_DIST_DIR, 'executors/javascript/node_executor.mjs'),
      join(SIDECAR_DIST_DIR, 'executors/javascript/node_executor.js')
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
    return join(SIDECAR_DIST_DIR, 'executors/python/ipython_executor.py');
  }
}
