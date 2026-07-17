import { ErrorCode, Operation } from '@repo/shared/errors';
import { describe, expect, it } from 'vitest';
import {
  InvalidTerminalCwdError,
  OperationInterruptedError,
  ProcessError
} from '../src';
import {
  createErrorFromResponse,
  FileNotFoundError,
  InvalidProcessCursorError,
  InvalidProcessCwdError,
  InvalidProcessEnvironmentError,
  ProcessAbortedError,
  ProcessSpawnFailedError,
  ProcessWaitTimeoutError,
  RPCTransportError,
  SandboxError,
  StaleProcessHandleError
} from '../src/errors';

const timestamp = new Date(0).toISOString();

describe('public error class exports', () => {
  it('exports lifecycle errors through the root barrel', () => {
    expect(OperationInterruptedError.prototype).toBeInstanceOf(SandboxError);
    expect(ProcessError.prototype).toBeInstanceOf(SandboxError);
    expect(InvalidTerminalCwdError.prototype).toBeInstanceOf(SandboxError);
  });

  it('preserves instanceof relationships through the errors barrel', () => {
    const fileError = new FileNotFoundError({
      code: ErrorCode.FILE_NOT_FOUND,
      message: 'missing',
      context: {
        path: '/workspace/missing.txt',
        operation: Operation.FILE_READ
      },
      httpStatus: 404,
      timestamp
    });

    expect(fileError).toBeInstanceOf(FileNotFoundError);
    expect(fileError).toBeInstanceOf(SandboxError);
    expect(fileError.path).toBe('/workspace/missing.txt');
  });

  it('preserves lifecycle and transport class prototypes', () => {
    const interrupted = new OperationInterruptedError({
      code: ErrorCode.OPERATION_INTERRUPTED,
      message: 'interrupted',
      context: {
        reason: 'runtime_replaced',
        operation: 'files.readFile',
        phase: 'rpc_call',
        admitted: 'unknown',
        retryable: false
      },
      httpStatus: 409,
      timestamp
    });
    const transport = new RPCTransportError({
      code: ErrorCode.RPC_TRANSPORT_ERROR,
      message: 'closed',
      context: {
        kind: 'peer_closed',
        originalMessage: 'Peer closed WebSocket: 1006',
        errorName: 'Error'
      },
      httpStatus: 503,
      timestamp
    });

    expect(interrupted).toBeInstanceOf(OperationInterruptedError);
    expect(interrupted).toBeInstanceOf(SandboxError);
    expect(transport).toBeInstanceOf(RPCTransportError);
    expect(transport).toBeInstanceOf(SandboxError);
  });

  it.each([
    [
      ErrorCode.INVALID_PROCESS_CWD,
      { cwd: '/missing', reason: 'missing' },
      InvalidProcessCwdError
    ],
    [
      ErrorCode.INVALID_PROCESS_ENVIRONMENT,
      { name: 'BAD', reason: 'invalid' },
      InvalidProcessEnvironmentError
    ],
    [
      ErrorCode.INVALID_PROCESS_CURSOR,
      { processId: 'proc_1', cursor: 'bad', reason: 'invalid' },
      InvalidProcessCursorError
    ],
    [
      ErrorCode.PROCESS_SPAWN_FAILED,
      { processId: 'proc_1', command: 'missing', stderr: 'ENOENT' },
      ProcessSpawnFailedError
    ]
  ])('adapts %s to its public process class', (code, context, ErrorClass) => {
    const error = createErrorFromResponse({
      code,
      message: 'process failure',
      context,
      httpStatus: 400,
      timestamp
    });
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error).toBeInstanceOf(SandboxError);
  });

  it('adapts invalid terminal cwd to its public class', () => {
    const error = createErrorFromResponse({
      code: ErrorCode.INVALID_TERMINAL_CWD,
      message: 'missing cwd',
      context: {
        terminalId: 'terminal-1',
        cwd: '/missing',
        reason: 'ENOENT'
      },
      httpStatus: 400,
      timestamp
    });

    expect(error).toBeInstanceOf(InvalidTerminalCwdError);
    expect(error).toBeInstanceOf(SandboxError);
  });

  it('preserves process error class prototypes', () => {
    const stale = new StaleProcessHandleError({
      code: ErrorCode.STALE_PROCESS_HANDLE,
      message: 'stale',
      context: {
        processId: 'proc_1',
        pid: 123,
        operation: 'status'
      },
      httpStatus: 409,
      timestamp
    });
    const timeout = new ProcessWaitTimeoutError({
      code: ErrorCode.PROCESS_WAIT_TIMEOUT,
      message: 'timeout',
      context: {
        processId: 'proc_1',
        operation: 'waitForExit',
        timeout: 1000
      },
      httpStatus: 408,
      timestamp
    });
    const aborted = new ProcessAbortedError({
      code: ErrorCode.PROCESS_ABORTED,
      message: 'aborted',
      context: {
        processId: 'proc_1',
        operation: 'logs'
      },
      httpStatus: 499,
      timestamp
    });

    expect(stale).toBeInstanceOf(StaleProcessHandleError);
    expect(stale).toBeInstanceOf(SandboxError);
    expect(stale.pid).toBe(123);
    expect(timeout).toBeInstanceOf(ProcessWaitTimeoutError);
    expect(timeout.operation).toBe('waitForExit');
    expect(aborted).toBeInstanceOf(ProcessAbortedError);
    expect(aborted.operation).toBe('logs');
    expect(createErrorFromResponse(stale.errorResponse)).toBeInstanceOf(
      StaleProcessHandleError
    );
    expect(createErrorFromResponse(timeout.errorResponse)).toBeInstanceOf(
      ProcessWaitTimeoutError
    );
    expect(createErrorFromResponse(aborted.errorResponse)).toBeInstanceOf(
      ProcessAbortedError
    );
  });
});
