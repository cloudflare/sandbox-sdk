#!/usr/bin/env node

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import * as util from 'node:util';
import * as vm from 'node:vm';
import type { RichOutput } from '../../process-pool';

interface Thenable<T> {
  then: (
    onfulfilled?: (value: T) => unknown,
    onrejected?: (reason: unknown) => unknown
  ) => unknown;
}

function isThenable(value: unknown): value is Thenable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof (value as Thenable<unknown>).then === 'function'
  );
}

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

const context = vm.createContext(sandbox);

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

      result = vm.runInContext(code, context, options);

      // If result is a Promise (thenable), await it
      if (isThenable(result)) {
        result = await result;
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
