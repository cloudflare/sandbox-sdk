import { RpcTarget } from 'cloudflare:workers';
import type {
  PortWatchEvent,
  ProcessLogEvent,
  ProcessStatus
} from '@repo/shared';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { SandboxProcess } from '../../src';
import {
  ProcessAbortedError,
  ProcessExitedBeforeLogError,
  ProcessWaitTimeoutError,
  RPCTransportError
} from '../../src';
import { ProcessError } from '../../src/errors';
import { createSandboxProcess } from '../../src/processes';
import type {
  ProcessRPCDescriptor,
  ProcessSubscriptionRPC
} from '../../src/processes/rpc-types';

const now = new Date().toISOString();
const running: ProcessStatus = {
  id: 'p1',
  pid: 123,
  command: ['/bin/true'],
  state: 'running',
  startedAt: now
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function subscription<T>(events: T[]): ProcessSubscriptionRPC<T> {
  return {
    stream: vi.fn(
      async () =>
        new ReadableStream<T>({
          start(controller) {
            for (const event of events) controller.enqueue(event);
            controller.close();
          }
        })
    ),
    cancel: vi.fn(async () => undefined),
    [Symbol.dispose]: vi.fn()
  };
}

function stdout(text: string, cursor: string): ProcessLogEvent {
  return {
    type: 'stdout',
    cursor,
    timestamp: now,
    data: new TextEncoder().encode(text)
  };
}

function stderr(text: string, cursor: string): ProcessLogEvent {
  return {
    type: 'stderr',
    cursor,
    timestamp: now,
    data: new TextEncoder().encode(text)
  };
}

function exited(code: number, cursor: string): ProcessLogEvent {
  return {
    type: 'terminal',
    state: 'exited',
    cursor,
    timestamp: now,
    exit: { code, timedOut: false }
  };
}

function processDescriptor(
  events: ProcessLogEvent[] = [stdout('hello', '1'), exited(0, '2')]
): ProcessRPCDescriptor {
  return {
    id: 'p1',
    pid: 123,
    capability: {
      status: vi.fn(async () => running),
      openLogs: vi.fn(async () => subscription(events)),
      openPortWatch: vi.fn(async (port) =>
        subscription<PortWatchEvent>([
          { type: 'watching', port },
          { type: 'ready', port }
        ])
      ),
      kill: vi.fn(async () => undefined)
    }
  };
}

describe('SandboxProcessImpl', () => {
  it('is an ordinary caller-local facade with readonly identity types', () => {
    const process = createSandboxProcess(processDescriptor());

    expect(process).not.toBeInstanceOf(RpcTarget);
    expect(process).toMatchObject({ id: 'p1', pid: 123 });
    expect('stdin' in process).toBe(false);
    expect('stdout' in process).toBe(false);
    expect('stderr' in process).toBe(false);
    expect('getSnapshot' in process).toBe(false);
    expect('interrupt' in process).toBe(false);
    expect('terminate' in process).toBe(false);
    expectTypeOf(process).toMatchTypeOf<SandboxProcess>();
  });

  it('delegates status and kill only through the private capability', async () => {
    const descriptor = processDescriptor();
    const process = createSandboxProcess(descriptor);

    await expect(process.status()).resolves.toEqual(running);
    await process.kill(9);
    await process.kill();

    expect(descriptor.capability.status).toHaveBeenCalledOnce();
    expect(descriptor.capability.kill).toHaveBeenNthCalledWith(1, 9);
    expect(descriptor.capability.kill).toHaveBeenNthCalledWith(2, 15);
  });

  it('opens logs without transporting AbortSignal', async () => {
    const descriptor = processDescriptor();
    const process = createSandboxProcess(descriptor);
    const controller = new AbortController();

    const stream = await process.logs({
      since: 'cursor',
      replay: true,
      follow: false,
      signal: controller.signal
    });
    await stream.cancel();

    expect(descriptor.capability.openLogs).toHaveBeenCalledWith({
      since: 'cursor',
      replay: true,
      follow: false
    });
  });

  it('releases remote subscription ownership exactly once', async () => {
    const remote = subscription<ProcessLogEvent>([]);
    const descriptor = processDescriptor();
    descriptor.capability.openLogs = vi.fn(async () => remote);
    const stream = await createSandboxProcess(descriptor).logs();

    await stream.cancel();
    await stream.cancel();

    expect(remote.cancel).toHaveBeenCalledTimes(1);
    expect(remote[Symbol.dispose]).toHaveBeenCalledTimes(1);
  });

  it('collects byte output and explicitly decodes utf8', async () => {
    const descriptor = processDescriptor([
      stdout('hello', '1'),
      stderr('warning', '2'),
      exited(7, '3')
    ]);
    const process = createSandboxProcess(descriptor);

    await expect(process.output()).resolves.toMatchObject({
      stdout: expect.any(Uint8Array),
      stderr: expect.any(Uint8Array),
      exitCode: 7,
      truncated: false
    });
    await expect(process.output({ encoding: 'utf8' })).resolves.toEqual({
      stdout: 'hello',
      stderr: 'warning',
      exitCode: 7,
      signal: undefined,
      timedOut: false,
      truncated: false
    });
  });

  it('memoizes one lazy exit-code waiter per handle', async () => {
    const descriptor = processDescriptor([exited(3, '1')]);
    const process = createSandboxProcess(descriptor);

    expect(descriptor.capability.openLogs).not.toHaveBeenCalled();
    const first = process.exitCode;
    const second = process.exitCode;

    expect(first).toBe(second);
    await expect(first).resolves.toBe(3);
    expect(descriptor.capability.openLogs).toHaveBeenCalledTimes(1);
  });

  it('waits for capability-scoped port readiness', async () => {
    const descriptor = processDescriptor();
    descriptor.capability.openLogs = vi.fn(async () => ({
      stream: vi.fn(
        async () => new ReadableStream<ProcessLogEvent>({ start() {} })
      ),
      cancel: vi.fn(async () => undefined),
      [Symbol.dispose]: vi.fn()
    }));
    const process = createSandboxProcess(descriptor);

    await process.waitForPort(8080, {
      mode: 'http',
      path: '/health',
      status: 200,
      interval: 50,
      timeout: 1000
    });

    expect(descriptor.capability.openPortWatch).toHaveBeenCalledWith(8080, {
      mode: 'http',
      path: '/health',
      status: 200,
      interval: 50
    });
  });

  it('uses typed local timeout and abort errors without killing the process', async () => {
    const remote = subscription<ProcessLogEvent>([]);
    remote.stream = vi.fn(
      async () => new ReadableStream<ProcessLogEvent>({ start() {} })
    );
    const descriptor = processDescriptor();
    descriptor.capability.openLogs = vi.fn(async () => remote);
    const process = createSandboxProcess(descriptor);

    await expect(process.waitForExit({ timeout: 1 })).rejects.toBeInstanceOf(
      ProcessWaitTimeoutError
    );
    expect(remote.cancel).toHaveBeenCalledTimes(1);
    expect(remote[Symbol.dispose]).toHaveBeenCalledTimes(1);

    const abort = new AbortController();
    const waiting = process.waitForLog('never', { signal: abort.signal });
    abort.abort();
    await expect(waiting).rejects.toBeInstanceOf(ProcessAbortedError);
    expect(descriptor.capability.kill).not.toHaveBeenCalled();
  });

  it.each([
    ['output', (process: SandboxProcess) => process.output({ timeout: 1 })],
    [
      'waitForExit',
      (process: SandboxProcess) => process.waitForExit({ timeout: 1 })
    ],
    [
      'waitForLog',
      (process: SandboxProcess) => process.waitForLog('never', { timeout: 1 })
    ]
  ])(
    'times out while %s subscription acquisition is pending',
    async (_, wait) => {
      const pending = deferred<ProcessSubscriptionRPC<ProcessLogEvent>>();
      const remote = subscription<ProcessLogEvent>([]);
      const descriptor = processDescriptor();
      descriptor.capability.openLogs = vi.fn(() => pending.promise);

      await expect(
        wait(createSandboxProcess(descriptor))
      ).rejects.toBeInstanceOf(ProcessWaitTimeoutError);
      pending.resolve(remote);
      await vi.waitFor(() => {
        expect(remote.cancel).toHaveBeenCalledOnce();
        expect(remote[Symbol.dispose]).toHaveBeenCalledOnce();
      });
    }
  );

  it('aborts logs while stream setup is pending and releases it later', async () => {
    const pending = deferred<ReadableStream<ProcessLogEvent>>();
    const remote = subscription<ProcessLogEvent>([]);
    remote.stream = vi.fn(() => pending.promise);
    const descriptor = processDescriptor();
    descriptor.capability.openLogs = vi.fn(async () => remote);
    const abort = new AbortController();

    const opening = createSandboxProcess(descriptor).logs({
      signal: abort.signal
    });
    abort.abort();
    await expect(opening).rejects.toBeInstanceOf(ProcessAbortedError);
    pending.resolve(new ReadableStream());
    await vi.waitFor(() => {
      expect(remote.cancel).toHaveBeenCalledOnce();
      expect(remote[Symbol.dispose]).toHaveBeenCalledOnce();
    });
  });

  it.each([
    { code: 0, timedOut: false },
    { code: 7, timedOut: false },
    { code: 143, signal: 15, timedOut: false },
    { code: 137, signal: 9, timedOut: true }
  ])(
    'preserves an unmatched terminal exit in a typed error: $code',
    async (exit) => {
      const process = createSandboxProcess(
        processDescriptor([
          {
            type: 'terminal',
            state: 'exited',
            cursor: 'terminal',
            timestamp: now,
            exit
          }
        ])
      );

      const waiting = process.waitForLog('never');
      await expect(waiting).rejects.toBeInstanceOf(ProcessExitedBeforeLogError);
      await expect(waiting).rejects.toMatchObject({ exit });
    }
  );

  it('matches decoder flush output before reporting terminal closure', async () => {
    const incomplete = new Uint8Array([0xe2, 0x82]);
    const process = createSandboxProcess(
      processDescriptor([
        { type: 'stdout', cursor: '1', timestamp: now, data: incomplete },
        exited(0, '2')
      ])
    );

    await expect(process.waitForLog('�')).resolves.toMatchObject({
      stream: 'stdout',
      match: '�'
    });
  });

  it('matches split UTF-8 and patterns with a bounded rolling window', async () => {
    const encoder = new TextEncoder();
    const emoji = encoder.encode('🙂');
    const events: ProcessLogEvent[] = [
      stdout('x'.repeat(1024 * 1024), '1'),
      { type: 'stdout', cursor: '2', timestamp: now, data: emoji.slice(0, 2) },
      { type: 'stdout', cursor: '3', timestamp: now, data: emoji.slice(2) },
      stdout('NEE', '4'),
      stdout('DLE', '5')
    ];
    const process = createSandboxProcess(processDescriptor(events));

    const result = await process.waitForLog('🙂NEEDLE');
    expect(result.match).toBe('🙂NEEDLE');
    expect(result.text.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('distinguishes supervisor failure and transport closure from exit', async () => {
    const failure: ProcessLogEvent = {
      type: 'terminal',
      state: 'error',
      cursor: '1',
      timestamp: now,
      error: { code: 'PROCESS_ERROR', message: 'supervisor failed' }
    };
    const failed = createSandboxProcess(processDescriptor([failure]));
    await expect(failed.waitForExit()).rejects.toBeInstanceOf(ProcessError);
    await expect(failed.output()).rejects.toBeInstanceOf(ProcessError);
    await expect(failed.exitCode).rejects.toBeInstanceOf(ProcessError);

    const closed = createSandboxProcess(processDescriptor([]));
    await expect(closed.waitForExit()).rejects.toBeInstanceOf(
      RPCTransportError
    );
    await expect(closed.output()).rejects.toBeInstanceOf(RPCTransportError);
  });

  it('cleans up output subscriptions after authoritative nonzero exit', async () => {
    const remote = subscription<ProcessLogEvent>([exited(143, '1')]);
    const descriptor = processDescriptor();
    descriptor.capability.openLogs = vi.fn(async () => remote);

    await expect(
      createSandboxProcess(descriptor).output()
    ).resolves.toMatchObject({
      exitCode: 143
    });
    expect(remote.cancel).toHaveBeenCalledTimes(1);
    expect(remote[Symbol.dispose]).toHaveBeenCalledTimes(1);
  });

  it('applies maxBytes across streams and reports both truncation sources', async () => {
    const process = createSandboxProcess(
      processDescriptor([
        stdout('1234', '1'),
        stderr('5678', '2'),
        { type: 'truncated', timestamp: now },
        exited(0, '3')
      ])
    );

    const output = await process.output({ maxBytes: 6, encoding: 'utf8' });
    expect(output).toMatchObject({
      stdout: '1234',
      stderr: '56',
      truncated: true,
      exitCode: 0
    });
  });

  it('locally aborts logs and cleans up consumer cancellation exactly once', async () => {
    const remote = subscription<ProcessLogEvent>([]);
    remote.stream = vi.fn(
      async () => new ReadableStream<ProcessLogEvent>({ start() {} })
    );
    const descriptor = processDescriptor();
    descriptor.capability.openLogs = vi.fn(async () => remote);
    const abort = new AbortController();
    const stream = await createSandboxProcess(descriptor).logs({
      signal: abort.signal
    });
    const reader = stream.getReader();

    abort.abort();
    await expect(reader.read()).rejects.toBeInstanceOf(ProcessAbortedError);
    await reader.cancel().catch(() => undefined);
    expect(remote.cancel).toHaveBeenCalledTimes(1);
    expect(remote[Symbol.dispose]).toHaveBeenCalledTimes(1);
  });

  it('translates late stream errors and releases their subscription', async () => {
    const remote = subscription<ProcessLogEvent>([]);
    remote.stream = vi.fn(
      async () =>
        new ReadableStream<ProcessLogEvent>({
          start(controller) {
            controller.enqueue(stdout('data', '1'));
            controller.error(new Error('late transport failure'));
          }
        })
    );
    const descriptor = processDescriptor();
    descriptor.capability.openLogs = vi.fn(async () => remote);
    const reader = (await createSandboxProcess(descriptor).logs()).getReader();

    await expect(reader.read()).rejects.toBeInstanceOf(RPCTransportError);
    expect(remote.cancel).toHaveBeenCalledTimes(1);
    expect(remote[Symbol.dispose]).toHaveBeenCalledTimes(1);
  });

  it('releases a subscription when local reader setup fails', async () => {
    const source = new ReadableStream<ProcessLogEvent>();
    source.getReader();
    const remote = subscription<ProcessLogEvent>([]);
    remote.stream = vi.fn(async () => source);
    const descriptor = processDescriptor();
    descriptor.capability.openLogs = vi.fn(async () => remote);

    await expect(
      createSandboxProcess(descriptor).logs()
    ).rejects.toBeInstanceOf(RPCTransportError);
    expect(remote.cancel).toHaveBeenCalledTimes(1);
    expect(remote[Symbol.dispose]).toHaveBeenCalledTimes(1);
  });
});
