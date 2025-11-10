#!/usr/bin/env node

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import * as util from 'node:util';
import * as vm from 'node:vm';
import type { RichOutput } from '../../process-pool';

// Create CommonJS-like globals for the sandbox
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

const sandbox = {
  console: console,
  process: process,
  require: require,
  Buffer: Buffer,
  setTimeout: setTimeout,
  setInterval: setInterval,
  clearTimeout: clearTimeout,
  clearInterval: clearInterval,
  setImmediate: setImmediate,
  clearImmediate: clearImmediate,
  global: global,
  __dirname: __dirname,
  __filename: __filename
};

const context = vm.createContext(sandbox, {
  microtaskMode: 'afterEvaluate'
});

console.log(JSON.stringify({ status: 'ready' }));

rl.on('line', async (line: string) => {
  try {
    const request = JSON.parse(line);
    const { code, executionId, timeout } = request;

    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;

    let stdout = '';
    let stderr = '';

    (process.stdout.write as any) = (
      chunk: string | Buffer,
      encoding?: BufferEncoding,
      callback?: () => void
    ) => {
      stdout += chunk.toString();
      if (callback) callback();
      return true;
    };

    (process.stderr.write as any) = (
      chunk: string | Buffer,
      encoding?: BufferEncoding,
      callback?: () => void
    ) => {
      stderr += chunk.toString();
      if (callback) callback();
      return true;
    };

    let result: unknown;
    let success = true;

    try {
      const options: vm.RunningScriptOptions = {
        filename: `<execution-${executionId}>`
      };

      // Only add timeout if specified (undefined = unlimited)
      if (timeout !== undefined) {
        options.timeout = timeout;
      }

      // Track execution time for the synchronous part
      const startTime = Date.now();

      result = vm.runInContext(code, context, options);

      const syncExecutionTime = Date.now() - startTime;

      if (
        result &&
        typeof result === 'object' &&
        'then' in result &&
        typeof result.then === 'function'
      ) {
        // We need to manually drain the microtask queue for promises from the inner context
        // Create a loop that keeps draining microtasks until the promise settles
        const promise = result as Promise<unknown>;
        let keepDraining = true;
        let timeoutHandle: NodeJS.Timeout | null = null;

        result = await new Promise((resolve, reject) => {
          // VM's timeout only applies to synchronous execution, so we need to handle async timeout ourselves
          if (timeout && timeout > 0) {
            const remainingTimeout = timeout - syncExecutionTime;
            if (remainingTimeout <= 0) {
              // Already exceeded timeout during sync execution
              keepDraining = false;
              reject(new Error(`Execution timed out after ${timeout}ms`));
              return;
            }
            timeoutHandle = setTimeout(() => {
              keepDraining = false;
              reject(new Error(`Execution timed out after ${timeout}ms`));
            }, remainingTimeout);
          }

          promise
            .then(
              (value) => {
                keepDraining = false;
                if (timeoutHandle) clearTimeout(timeoutHandle);
                resolve(value);
              },
              (error) => {
                keepDraining = false;
                if (timeoutHandle) clearTimeout(timeoutHandle);
                reject(error);
              }
            )
            .catch((err) => {
              // Just in case
              keepDraining = false;
              if (timeoutHandle) clearTimeout(timeoutHandle);
              reject(err);
            });

          // Drain microtasks in a loop until the promise settles
          const drainMicrotasks = () => {
            if (!keepDraining) return;

            try {
              vm.runInContext('', context);
            } catch (err) {
              // Context might error, but we continue draining
            }

            // Schedule next drain
            setImmediate(drainMicrotasks);
          };
          setImmediate(drainMicrotasks);
        });
      }
    } catch (error: unknown) {
      const err = error as Error;
      stderr += err.stack || err.toString();
      success = false;
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    const outputs: RichOutput[] = [];

    if (result !== undefined) {
      if (typeof result === 'object' && result !== null) {
        outputs.push({
          type: 'json',
          data: JSON.stringify(result, null, 2),
          metadata: {}
        });
      } else {
        outputs.push({
          type: 'text',
          data: util.inspect(result, {
            showHidden: false,
            depth: null,
            colors: false
          }),
          metadata: {}
        });
      }
    }

    const response = {
      stdout,
      stderr,
      success,
      executionId,
      outputs
    };

    console.log(JSON.stringify(response));
  } catch (error: unknown) {
    const err = error as Error;
    console.log(
      JSON.stringify({
        stdout: '',
        stderr: `Error processing request: ${err.message}`,
        success: false,
        executionId: 'unknown',
        outputs: []
      })
    );
  }
});

process.on('SIGTERM', () => {
  rl.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  rl.close();
  process.exit(0);
});
