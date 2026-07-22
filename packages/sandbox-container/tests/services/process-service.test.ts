import { beforeEach, describe, expect, it, vi } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  RuntimeManagedProcess,
  RuntimeProcessLogEvent,
  RuntimeProcessStatus
} from '@repo/sandbox-execution';
import {
  ErrorCode,
  type Logger,
  type ProcessStartOptions,
  type ProcessStatus,
  type SandboxCommand
} from '@repo/shared';
import { ProcessService } from '../../src/services/process-service';

interface StartCall {
  runId: string;
  command: SandboxCommand;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onTerminal?: (status: RuntimeProcessStatus) => void | Promise<void>;
}

interface SupervisorStub {
  start(options: StartCall): Promise<RuntimeManagedProcess>;
  get(runId: string): RuntimeManagedProcess | undefined;
  list(): RuntimeProcessStatus[];
  removeTerminal(runId: string): boolean;
  hasActive(): boolean;
  [Symbol.asyncDispose](): Promise<void>;
}

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn()
};
logger.child = vi.fn(() => logger);

function streamOf<T>(events: T[]): ReadableStream<T> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    }
  });
}

type TestRuntimeProcessStatus = RuntimeProcessStatus & { runId?: string };

function runtimeProcess(
  status: TestRuntimeProcessStatus = runningStatus(),
  overrides: Partial<RuntimeManagedProcess> = {}
): RuntimeManagedProcess {
  const base: RuntimeManagedProcess = {
    pid: status.pid,
    snapshot: vi.fn((): RuntimeProcessStatus => status),
    logs: vi.fn(() => streamOf<RuntimeProcessLogEvent>([])),
    waitForExit: vi.fn(
      async (): Promise<RuntimeProcessStatus> => ({
        pid: status.pid,
        command: status.command,
        state: 'exited',
        exit: { code: 0, timedOut: false },
        startedAt: status.startedAt,
        endedAt: '2026-07-08T00:00:01.000Z'
      })
    ),
    kill: vi.fn(async () => undefined)
  };
  return { ...base, ...overrides };
}

function runningStatus(
  overrides: Partial<TestRuntimeProcessStatus> = {}
): TestRuntimeProcessStatus {
  return {
    pid: 123,
    command: ['node', 'server.js'],
    cwd: '/workspace/app',
    state: 'running',
    startedAt: '2026-07-08T00:00:00.000Z',
    ...overrides
  } as RuntimeProcessStatus;
}

function supervisor(
  processes: Record<string, RuntimeManagedProcess> = {}
): SupervisorStub {
  const byRunId = new Map(Object.entries(processes));
  return {
    start: vi.fn(async (options: StartCall) => {
      const process = runtimeProcess(
        runningStatus({ command: options.command, cwd: options.cwd })
      );
      byRunId.set(options.runId, process);
      return process;
    }),
    get: vi.fn((runId: string) => byRunId.get(runId)),
    list: vi.fn(() =>
      [...byRunId.values()].map((process) => process.snapshot())
    ),
    removeTerminal: vi.fn((runId: string) => byRunId.delete(runId)),
    hasActive: vi.fn(() =>
      [...byRunId.values()].some(
        (process) => process.snapshot().state === 'running'
      )
    ),
    [Symbol.asyncDispose]: vi.fn(async () => undefined)
  };
}

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const values: T[] = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return values;
      values.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
}

describe('ProcessService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts with required PID, rich running status, and unchanged empty later argv', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'process-service-'));
    try {
      const stub = supervisor();
      const service = new ProcessService({ supervisor: stub, logger });
      const status = await service.start(['printf', ''], {
        cwd: temp,
        env: { PORT: '8787' },
        timeout: 5000
      });

      expect(status).toMatchObject({
        id: expect.stringMatching(/[0-9a-f-]{36}/),
        pid: 123,
        command: ['printf', ''],
        cwd: temp,
        state: 'running',
        startedAt: expect.any(String)
      });
      expect(stub.start).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: status.id,
          command: ['printf', ''],
          cwd: temp,
          env: { PORT: '8787' },
          timeoutMs: 5000
        })
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('defaults process cwd to the workspace', async () => {
    const stub = supervisor();
    const service = new ProcessService({ supervisor: stub, logger });

    await service.start(['pwd']);

    expect(stub.start).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/workspace' })
    );
  });

  it('validates only argv[0], cwd, environment and timeout before starting', async () => {
    const service = new ProcessService({ supervisor: supervisor(), logger });
    const temp = await mkdtemp(join(tmpdir(), 'process-service-'));
    const filePath = join(temp, 'file');
    await writeFile(filePath, 'not a directory');
    try {
      await expect(
        service.start([] as unknown as SandboxCommand)
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_COMMAND
      });
      await expect(
        service.start([''] as unknown as SandboxCommand)
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_COMMAND
      });
      await expect(
        service.start(['node', 1] as unknown as SandboxCommand)
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_COMMAND });
      await expect(service.start(['node'], { cwd: '' })).rejects.toMatchObject({
        code: ErrorCode.INVALID_PROCESS_CWD,
        details: { cwd: '', reason: 'cwd must be a non-empty string' }
      });
      await expect(
        service.start(['node'], { cwd: join(temp, 'missing') })
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_PROCESS_CWD,
        details: { cwd: join(temp, 'missing') }
      });
      await expect(
        service.start(['node'], { cwd: filePath })
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_PROCESS_CWD,
        details: { cwd: filePath }
      });
      await expect(
        service.start(['node'], { env: { 'BAD=NAME': 'x' } })
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_PROCESS_ENVIRONMENT,
        details: { name: 'BAD=NAME', reason: 'environment name is invalid' }
      });
      await expect(
        service.start(['node'], {
          env: { BAD: 1 }
        } as unknown as ProcessStartOptions)
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_PROCESS_ENVIRONMENT,
        details: { name: 'BAD', reason: 'environment value must be a string' }
      });
      await expect(
        service.start(['node'], { timeout: 0 })
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_COMMAND
      });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('returns process statuses directly for get and list with numeric signal exits', async () => {
    const exited = runtimeProcess({
      pid: 321,
      command: ['false'],
      state: 'exited',
      exit: { code: 1, signal: 15, timedOut: false },
      startedAt: 'start',
      endedAt: 'end'
    });
    const service = new ProcessService({
      supervisor: supervisor({ 'proc-public': exited }),
      logger
    });

    const expected: ProcessStatus = {
      id: 'proc-public',
      pid: 321,
      command: ['false'],
      state: 'exited',
      exit: { code: 1, signal: 15, timedOut: false },
      startedAt: 'start',
      endedAt: 'end'
    };
    expect(await service.list()).toEqual([]);
    expect(await service.get('proc-public')).toEqual(expected);
    expect(await service.list()).toEqual([expected]);
  });

  it('maps runtime failures to error statuses and terminal error log events', async () => {
    const process = runtimeProcess(runningStatus(), {
      logs: vi.fn(() =>
        streamOf<RuntimeProcessLogEvent>([
          {
            type: 'terminal',
            state: 'error',
            cursor: 'c3',
            timestamp: 't3',
            error: { code: 'DRAIN_FAILED', message: 'stdout failed' }
          }
        ])
      )
    });
    const service = new ProcessService({
      supervisor: supervisor({ 'proc-public': process }),
      logger
    });
    const events = await readAll(
      await service.openLogs('proc-public', { replay: true })
    );

    expect(events).toEqual([
      {
        type: 'terminal',
        state: 'error',
        cursor: 'c3',
        timestamp: 't3',
        error: { code: 'DRAIN_FAILED', message: 'stdout failed' }
      }
    ]);
  });

  it('delegates exact numeric kill signals and is idempotent for retained exited records', async () => {
    const running = runtimeProcess(runningStatus({ pid: 222 }));
    const exited = runtimeProcess({
      pid: 333,
      command: ['true'],
      state: 'exited',
      exit: { code: 0, timedOut: false },
      startedAt: 's',
      endedAt: 'e'
    });
    const errored = runtimeProcess({
      pid: 444,
      command: ['broken'],
      state: 'error',
      error: { code: 'DRAIN_FAILED', message: 'supervisor failed' },
      startedAt: 's',
      endedAt: 'e'
    });
    const service = new ProcessService({
      supervisor: supervisor({ running, exited, errored }),
      logger
    });

    await service.kill('running', 9);
    await service.kill('exited', 2);
    await expect(service.kill('errored', 15)).rejects.toMatchObject({
      code: ErrorCode.PROCESS_ERROR,
      details: { processId: 'errored' }
    });

    expect(running.kill).toHaveBeenCalledWith(9);
    expect(exited.kill).not.toHaveBeenCalled();
    expect(errored.kill).not.toHaveBeenCalled();
  });

  it('throws typed not-found invalid-cursor spawn-failure and kill errors', async () => {
    const service = new ProcessService({ supervisor: supervisor(), logger });
    await expect(service.openLogs('missing')).rejects.toMatchObject({
      code: ErrorCode.PROCESS_NOT_FOUND
    });
    await expect(
      service.openLogs('missing', { since: '' })
    ).rejects.toMatchObject({
      code: ErrorCode.INVALID_PROCESS_CURSOR,
      details: {
        processId: 'missing',
        cursor: '',
        reason: 'cursor must be a non-empty string'
      }
    });
    await expect(service.kill('missing')).rejects.toMatchObject({
      code: ErrorCode.PROCESS_NOT_FOUND
    });
    const process = runtimeProcess(runningStatus(), {
      logs: vi.fn(() => {
        throw new Error('Invalid process log cursor');
      }),
      kill: vi.fn(async () => {
        throw new Error('kill failed');
      })
    });
    const failingService = new ProcessService({
      supervisor: supervisor({ 'proc-public': process }),
      logger
    });
    await expect(
      failingService.openLogs('proc-public', { since: 'bad' })
    ).rejects.toMatchObject({
      code: ErrorCode.INVALID_PROCESS_CURSOR,
      details: {
        processId: 'proc-public',
        cursor: 'bad',
        reason: 'Invalid process log cursor'
      }
    });
    await expect(failingService.kill('proc-public')).rejects.toMatchObject({
      code: ErrorCode.PROCESS_ERROR,
      details: { processId: 'proc-public' }
    });
    await expect(
      new ProcessService({
        supervisor: {
          ...supervisor(),
          start: vi.fn(async () => {
            throw Object.assign(new Error('spawn ENOENT'), {
              code: 'ENOENT',
              path: '/missing-executable'
            });
          })
        },
        logger
      }).start(['/missing-executable'])
    ).rejects.toMatchObject({
      code: ErrorCode.PROCESS_SPAWN_FAILED,
      details: { command: '/missing-executable', processId: expect.any(String) }
    });
  });

  it('evicts only service-owned terminal process records and prunes completion retention', async () => {
    const processes = new Map<string, RuntimeManagedProcess>();
    const stub = supervisor();
    stub.start = vi.fn(async (options: StartCall) => {
      const process = runtimeProcess(
        runningStatus({ command: options.command, cwd: options.cwd })
      );
      processes.set(options.runId, process);
      return process;
    });
    stub.get = vi.fn((runId: string) => processes.get(runId));
    stub.list = vi.fn(() =>
      [...processes.values()].map((process) => process.snapshot())
    );
    stub.removeTerminal = vi.fn((runId: string) => processes.delete(runId));
    const service = new ProcessService({ supervisor: stub, logger });
    const active = await service.start(['sleep']);
    const startCalls = (stub.start as ReturnType<typeof vi.fn>).mock.calls;

    for (let index = 0; index < 65; index++) {
      const status = await service.start(['true']);
      const process = processes.get(status.id);
      const terminalStatus: RuntimeProcessStatus = {
        pid: status.pid,
        command: ['true'],
        state: 'exited',
        exit: { code: 0, timedOut: false },
        startedAt: `${index}`,
        endedAt: `${index}`
      };
      if (process) process.snapshot = vi.fn(() => terminalStatus);
      const startOptions = startCalls.at(-1)?.[0] as StartCall | undefined;
      await startOptions?.onTerminal?.(terminalStatus);
    }

    expect(stub.removeTerminal).toHaveBeenCalledTimes(1);
    expect(stub.removeTerminal).not.toHaveBeenCalledWith(active.id);

    const evictedId = (stub.removeTerminal as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    const evictedStartOptions = startCalls.find(
      ([options]) => options.runId === evictedId
    )?.[0] as StartCall | undefined;
    await evictedStartOptions?.onTerminal?.({
      pid: 1,
      command: ['true'],
      state: 'exited',
      exit: { code: 0, timedOut: false },
      startedAt: 'again-start',
      endedAt: 'again-end'
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('process.complete success'),
      expect.objectContaining({ processId: evictedId })
    );
  });

  it('emits exactly-once authoritative process completion telemetry', async () => {
    const stub = supervisor();
    const service = new ProcessService({ supervisor: stub, logger });
    const status = await service.start(['node']);
    const startOptions = (stub.start as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as StartCall;
    const terminalStatus: RuntimeProcessStatus = {
      pid: status.pid,
      command: ['node'],
      state: 'error',
      error: { code: 'SPAWN_FAILED', message: 'boom' },
      startedAt: '2026-07-08T00:00:00.000Z',
      endedAt: '2026-07-08T00:00:02.500Z'
    };

    await startOptions.onTerminal?.(terminalStatus);
    await startOptions.onTerminal?.(terminalStatus);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('process.complete error'),
      undefined,
      expect.objectContaining({
        event: 'process.complete',
        outcome: 'error',
        processId: status.id,
        pid: status.pid,
        durationMs: 2500,
        processOutcome: 'supervisor_error',
        failureCode: 'SPAWN_FAILED'
      })
    );
  });

  it.each([
    [{ code: 7, timedOut: false }, 'exit'],
    [{ code: 143, signal: 15, timedOut: false }, 'signal']
  ] as const)(
    'emits the exact completion outcome %#',
    async (exit, processOutcome) => {
      const stub = supervisor();
      const service = new ProcessService({ supervisor: stub, logger });
      const status = await service.start(['node']);
      const startOptions = (stub.start as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as StartCall;

      await startOptions.onTerminal?.({
        pid: status.pid,
        command: ['node'],
        state: 'exited',
        exit,
        startedAt: '2026-07-08T00:00:00.000Z',
        endedAt: '2026-07-08T00:00:01.000Z'
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('process.complete success'),
        expect.objectContaining({
          processOutcome,
          exitCode: exit.code,
          signal: 'signal' in exit ? exit.signal : undefined
        })
      );
    }
  );

  it('shuts down the supervisor', async () => {
    const stub = supervisor();
    const service = new ProcessService({ supervisor: stub, logger });
    await service.shutdown();
    expect(stub[Symbol.asyncDispose]).toHaveBeenCalled();
  });
});
