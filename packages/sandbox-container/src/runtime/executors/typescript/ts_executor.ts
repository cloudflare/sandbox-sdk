#!/usr/bin/env node

import * as readline from 'node:readline';
import * as util from 'node:util';
import * as vm from 'node:vm';
import { transformSync } from 'esbuild';
import type { RichOutput } from '../../process-pool';

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

console.log(JSON.stringify({ status: "ready" }));

rl.on('line', async (line: string) => {
  try {
    const request = JSON.parse(line);
    const { code, executionId } = request;
    
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    
    let stdout = '';
    let stderr = '';
    
    (process.stdout.write as any) = (chunk: string | Buffer, encoding?: BufferEncoding, callback?: () => void) => {
      stdout += chunk.toString();
      if (callback) callback();
      return true;
    };
    
    (process.stderr.write as any) = (chunk: string | Buffer, encoding?: BufferEncoding, callback?: () => void) => {
      stderr += chunk.toString();
      if (callback) callback();
      return true;
    };
    
    let result: unknown;
    let success = true;
    
    try {
      const transpileResult = transformSync(code, {
        loader: 'ts',
        target: 'es2020',
        format: 'cjs',
        sourcemap: false,
        treeShaking: false,
        minify: false,
      });
      
      const jsCode = transpileResult.code;
      result = vm.runInContext(jsCode, context, {
        filename: `<execution-${executionId}>`,
        timeout: 30000
      });
      
    } catch (error: unknown) {
      const err = error as Error;
      if (err.message?.includes('Transform failed')) {
        stderr += `TypeScript compilation error: ${err.message}\n`;
      } else {
        stderr += err.stack || err.toString();
      }
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
          data: util.inspect(result, { showHidden: false, depth: null, colors: false }),
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
    console.log(JSON.stringify({
      stdout: '',
      stderr: `Error processing request: ${err.message}`,
      success: false,
      executionId: 'unknown',
      outputs: []
    }));
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