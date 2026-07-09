import { ErrorCode } from '@repo/shared/errors';
import { translateRPCError } from '../container-control/rpc-error';
import {
  ProcessAbortedError,
  ProcessError,
  ProcessReadyTimeoutError,
  ProcessWaitTimeoutError
} from '../errors';

export type WaitOperation = 'output' | 'waitForExit' | 'waitForLog';

export async function withLocalWait<T>(
  work: (settlementSignal: AbortSignal) => Promise<T>,
  options: {
    processId: string;
    operation: WaitOperation | 'waitForPort' | 'logs';
    timeout?: number;
    signal?: AbortSignal;
    port?: number;
  }
): Promise<T> {
  const { signal, timeout } = options;
  const settlement = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const competitors: Promise<T>[] = [work(settlement.signal)];

  if (timeout !== undefined) {
    competitors.push(
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(timeoutError(options, timeout)),
          timeout
        );
      })
    );
  }
  if (signal !== undefined) {
    competitors.push(
      new Promise<T>((_, reject) => {
        const abort = () =>
          reject(abortError(options.processId, options.operation, signal));
        if (signal.aborted) abort();
        else {
          abortListener = abort;
          signal.addEventListener('abort', abort, { once: true });
        }
      })
    );
  }

  try {
    return await Promise.race(competitors);
  } finally {
    settlement.abort();
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined)
      signal?.removeEventListener('abort', abortListener);
  }
}

export function processFailure(
  processId: string,
  pid: number,
  failure: { code: string; message: string }
): ProcessError {
  return new ProcessError({
    code: ErrorCode.PROCESS_ERROR,
    message: failure.message,
    context: { processId, pid },
    httpStatus: 500,
    timestamp: new Date().toISOString()
  });
}

export function streamClosed(message: string): never {
  translateRPCError(new Error(message), {
    operation: 'consume process subscription',
    translateTransportErrorsAsInterruptions: false
  });
}

function timeoutError(
  options: {
    processId: string;
    operation: WaitOperation | 'waitForPort' | 'logs';
    port?: number;
  },
  timeout: number
): ProcessWaitTimeoutError | ProcessReadyTimeoutError {
  if (options.operation === 'waitForPort') {
    const condition = `port ${options.port ?? 'unknown'}`;
    return new ProcessReadyTimeoutError({
      code: ErrorCode.PROCESS_READY_TIMEOUT,
      message: `Process did not become ready within ${timeout}ms. Waiting for: ${condition}`,
      context: {
        processId: options.processId,
        command: options.processId,
        condition,
        timeout
      },
      httpStatus: 408,
      timestamp: new Date().toISOString()
    });
  }
  const operation =
    options.operation === 'logs' ? 'waitForLog' : options.operation;
  return new ProcessWaitTimeoutError({
    code: ErrorCode.PROCESS_WAIT_TIMEOUT,
    message: `Process ${operation} did not complete within ${timeout}ms`,
    context: { processId: options.processId, operation, timeout },
    httpStatus: 408,
    timestamp: new Date().toISOString()
  });
}

export function abortError(
  processId: string,
  operation: string,
  signal: AbortSignal
): Error {
  if (signal.reason instanceof Error && signal.reason.name !== 'AbortError')
    return signal.reason;
  return new ProcessAbortedError({
    code: ErrorCode.PROCESS_ABORTED,
    message: `Process ${operation} was aborted`,
    context: { processId, operation },
    httpStatus: 499,
    timestamp: new Date().toISOString()
  });
}
