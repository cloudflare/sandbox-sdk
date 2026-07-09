import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  InvalidTerminalCwdContext,
  ProcessAbortedContext,
  ProcessWaitTimeoutContext,
  StaleProcessHandleContext
} from '../src/errors/index.js';
import {
  ErrorCode,
  getHttpStatus,
  getSuggestion
} from '../src/errors/index.js';
import type {
  ISandbox,
  ProcessExit,
  ProcessFailure,
  ProcessLogCursor,
  ProcessLogEvent,
  ProcessOutput,
  ProcessStatus,
  SandboxAPI,
  SandboxCommand,
  SandboxProcessesAPI,
  SandboxTerminalsAPI,
  SandboxWatchAPI,
  TerminalOutputEvent,
  TerminalOutputOptions,
  TerminalOutputSubscriptionAPI,
  WatchRequest,
  WatchSubscriptionAPI
} from '../src/index.js';

describe('process shared contracts', () => {
  it('exposes workerd-aligned public process contracts', () => {
    expectTypeOf<SandboxCommand>().toMatchTypeOf<
      readonly [executable: string, ...args: string[]]
    >();
    expectTypeOf<ProcessExit>().toEqualTypeOf<{
      code: number;
      signal?: number;
      timedOut: boolean;
    }>();
    expectTypeOf<ProcessStatus>().toMatchTypeOf<
      | { state: 'running'; id: string; pid: number }
      | {
          state: 'exited';
          id: string;
          pid: number;
          exit: ProcessExit;
          endedAt: string;
        }
      | {
          state: 'error';
          id: string;
          pid: number;
          error: { code: string; message: string };
          endedAt: string;
        }
    >();
    expectTypeOf<ProcessLogEvent>().not.toMatchTypeOf<{ processId: string }>();
    expectTypeOf<
      Extract<ProcessLogEvent, { state: 'exited' }>
    >().toEqualTypeOf<{
      type: 'terminal';
      state: 'exited';
      cursor: ProcessLogCursor;
      timestamp: string;
      exit: ProcessExit;
    }>();
    expectTypeOf<Extract<ProcessLogEvent, { state: 'error' }>>().toEqualTypeOf<{
      type: 'terminal';
      state: 'error';
      cursor: ProcessLogCursor;
      timestamp: string;
      error: ProcessFailure;
    }>();
    expectTypeOf<
      Extract<ProcessLogEvent, { type: 'exited' }>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<ProcessLogEvent, { type: 'error' }>
    >().toEqualTypeOf<never>();
    expectTypeOf<ProcessOutput<Uint8Array>>().toMatchTypeOf<{
      stdout: Uint8Array;
      stderr: Uint8Array;
      exitCode: number;
      signal?: number;
      timedOut: boolean;
      truncated: boolean;
    }>();
    expectTypeOf<ISandbox['listProcesses']>().returns.toEqualTypeOf<
      Promise<ProcessStatus[]>
    >();
    expectTypeOf<
      SandboxAPI['processes']
    >().toEqualTypeOf<SandboxProcessesAPI>();
  });

  it('keeps process commands non-empty at the untyped boundary', () => {
    const valid: SandboxCommand = ['printf', ''];
    expect(valid).toEqual(['printf', '']);

    const isSandboxCommand = (value: unknown): value is SandboxCommand =>
      Array.isArray(value) &&
      value.length > 0 &&
      typeof value[0] === 'string' &&
      value[0].length > 0 &&
      value.every((part) => typeof part === 'string');

    expect(isSandboxCommand(['printf', ''])).toBe(true);
    expect(isSandboxCommand([''])).toBe(false);
    expect(isSandboxCommand([])).toBe(false);
  });

  it('exposes container-only process APIs without caller-local cancellation', () => {
    expectTypeOf<SandboxProcessesAPI>().toMatchTypeOf<{
      start(command: SandboxCommand): Promise<ProcessStatus>;
      get(id: string): Promise<ProcessStatus | null>;
      list(): Promise<ProcessStatus[]>;
      openLogs(
        id: string
      ): Promise<{ stream(): Promise<ReadableStream<ProcessLogEvent>> }>;
      kill(id: string, signal?: number): Promise<void>;
      hasActive(): Promise<boolean>;
    }>();
    expectTypeOf<SandboxProcessesAPI>().not.toMatchTypeOf<{
      logs(id: string): Promise<ReadableStream<ProcessLogEvent>>;
      interrupt(id: string): Promise<void>;
      terminate(id: string): Promise<void>;
    }>();
  });

  it('requires explicit ownership for terminal output subscriptions', () => {
    expectTypeOf<TerminalOutputSubscriptionAPI>().toEqualTypeOf<{
      stream(): Promise<ReadableStream<TerminalOutputEvent>>;
      cancel(): Promise<void>;
      [Symbol.dispose](): void;
    }>();
    expectTypeOf<SandboxTerminalsAPI['output']>().toEqualTypeOf<
      (
        id: string,
        options?: Omit<TerminalOutputOptions, 'signal'>
      ) => Promise<TerminalOutputSubscriptionAPI>
    >();
  });

  it('requires explicit ownership for filesystem watch subscriptions', () => {
    expectTypeOf<WatchSubscriptionAPI>().toEqualTypeOf<{
      stream(): Promise<ReadableStream<Uint8Array>>;
      cancel(): Promise<void>;
      [Symbol.dispose](): void;
    }>();
    expectTypeOf<SandboxWatchAPI['watch']>().toEqualTypeOf<
      (request: WatchRequest) => Promise<WatchSubscriptionAPI>
    >();
  });

  it('maps process errors to exact statuses suggestions and contexts', () => {
    const expectedStatuses = [
      [ErrorCode.INVALID_PROCESS_CWD, 400],
      [ErrorCode.INVALID_PROCESS_ENVIRONMENT, 400],
      [ErrorCode.PROCESS_SPAWN_FAILED, 500],
      [ErrorCode.INVALID_PROCESS_CURSOR, 400],
      [ErrorCode.STALE_PROCESS_HANDLE, 409],
      [ErrorCode.PROCESS_WAIT_TIMEOUT, 408],
      [ErrorCode.PROCESS_ABORTED, 499],
      [ErrorCode.TERMINAL_NOT_FOUND, 404],
      [ErrorCode.INVALID_TERMINAL_CWD, 400],
      [ErrorCode.INVALID_TERMINAL_CURSOR, 400],
      [ErrorCode.TERMINAL_CONTROL_ERROR, 500]
    ] as const;

    const staleContext: StaleProcessHandleContext = {
      processId: 'proc-public',
      pid: 123,
      operation: 'status'
    };
    const waitTimeoutContext: ProcessWaitTimeoutContext = {
      processId: 'proc-public',
      operation: 'waitForExit',
      timeout: 1000
    };
    const abortedContext: ProcessAbortedContext = {
      processId: 'proc-public',
      operation: 'logs'
    };
    const terminalCwdContext: InvalidTerminalCwdContext = {
      terminalId: 'term-public',
      cwd: '/workspace/app',
      reason: 'Path is not a directory'
    };
    expect(staleContext.pid).toBe(123);
    expect(waitTimeoutContext.operation).toBe('waitForExit');
    expect(abortedContext.operation).toBe('logs');
    expect(terminalCwdContext.cwd).toBe('/workspace/app');

    for (const [code, status] of expectedStatuses) {
      expect(getHttpStatus(code)).toBe(status);
      expect(
        getSuggestion(code, {
          processId: 'proc-public',
          terminalId: 'term-public',
          cwd: '/workspace/app',
          command: 'node',
          timeout: 1000,
          operation: 'logs'
        })
      ).toEqual(expect.any(String));
    }
  });
});
