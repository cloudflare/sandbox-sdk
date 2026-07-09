import { randomUUID } from 'node:crypto';
import { JS_RUNTIME, PYTHON_AVAILABLE } from './config';
import type { ExecutionResult, InterpreterLanguage } from './types';

export function prepareCode(
  language: InterpreterLanguage,
  code: string
): string | ExecutionResult {
  if (language !== 'typescript') return code;

  try {
    const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'node' });
    return transpiler.transformSync(code);
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

export function executionAvailabilityError(
  language: InterpreterLanguage
): ExecutionResult | null {
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

  if ((language === 'javascript' || language === 'typescript') && !JS_RUNTIME) {
    return {
      stdout: '',
      stderr:
        'JavaScript runtime not available. JavaScript/TypeScript code execution requires Node.js or Bun to be installed in the container.',
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

  return null;
}

export function assertLanguageAvailable(language: InterpreterLanguage): void {
  const error = executionAvailabilityError(language);
  if (!error) return;
  throw new Error(error.stderr);
}
