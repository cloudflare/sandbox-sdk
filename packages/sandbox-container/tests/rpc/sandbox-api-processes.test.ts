import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type {
  ProcessLogEvent,
  ProcessLogsRPCOptions,
  ProcessStartOptions,
  ProcessStatus,
  SandboxCommand
} from '@repo/shared';
import { ProcessesRPCAPI } from '../../src/control-plane/processes-rpc';
import { StreamSubscriptionRPC } from '../../src/control-plane/subscription-rpc';

interface ProcessServiceStub {
  start(
    command: SandboxCommand,
    options?: ProcessStartOptions
  ): Promise<ProcessStatus>;
  get(id: string): Promise<ProcessStatus | null>;
  list(): Promise<ProcessStatus[]>;
  openLogs(
    id: string,
    options?: ProcessLogsRPCOptions
  ): Promise<ReadableStream<ProcessLogEvent>>;
  kill(id: string, signal?: number): Promise<void>;
  hasActive(): Promise<boolean>;
}

function status(id = 'proc-public'): ProcessStatus {
  return {
    id,
    pid: 123,
    command: ['node', 'server.js'],
    cwd: '/workspace/app',
    state: 'running' as const,
    startedAt: '2026-07-08T00:00:00.000Z'
  };
}

describe('ProcessesRPCAPI domain', () => {
  let processService: ProcessServiceStub;

  beforeEach(() => {
    vi.clearAllMocks();
    processService = {
      start: vi.fn(async () => status()),
      get: vi.fn(async (id: string) => status(id)),
      list: vi.fn(async () => [status('proc-a'), status('proc-b')]),
      openLogs: vi.fn(async () => new ReadableStream<ProcessLogEvent>()),
      kill: vi.fn(async () => undefined),
      hasActive: vi.fn(async () => true)
    };
  });

  it('exposes final process RPC controls only', () => {
    const api = new ProcessesRPCAPI(processService);
    expect(api.start).toEqual(expect.any(Function));
    expect(api.get).toEqual(expect.any(Function));
    expect(api.list).toEqual(expect.any(Function));
    expect(api.openLogs).toEqual(expect.any(Function));
    expect(api.kill).toEqual(expect.any(Function));
    expect(api.hasActive).toEqual(expect.any(Function));
    expect('logs' in api).toBe(false);
    expect('interrupt' in api).toBe(false);
    expect('terminate' in api).toBe(false);
    expect('waitForExit' in api).toBe(false);
    expect('waitForLog' in api).toBe(false);
  });

  it('starts processes with argv options and returns rich statuses', async () => {
    const api = new ProcessesRPCAPI(processService);
    const result = await api.start(['node', 'server.js'], {
      cwd: '/workspace/app',
      env: { PORT: '8787' },
      timeout: 5000
    });

    expect(result).toEqual(status());
    expect(processService.start).toHaveBeenCalledWith(['node', 'server.js'], {
      cwd: '/workspace/app',
      env: { PORT: '8787' },
      timeout: 5000
    });
  });

  it('returns disposable log subscriptions and delegates kill exactly', async () => {
    const api = new ProcessesRPCAPI(processService);
    const logStream = new ReadableStream<ProcessLogEvent>({
      start(controller) {
        controller.enqueue({
          type: 'stdout',
          cursor: 'c1',
          timestamp: 't1',
          data: new Uint8Array([65])
        });
        controller.close();
      }
    });
    processService.openLogs = vi.fn(async () => logStream);

    expect(await api.get('proc-a')).toEqual(status('proc-a'));
    expect(await api.list()).toHaveLength(2);
    const subscription = await api.openLogs('proc-a', { replay: true });
    expect(subscription).toBeInstanceOf(StreamSubscriptionRPC);
    await api.kill('proc-a', 2);
    expect(await api.hasActive()).toBe(true);

    expect(processService.get).toHaveBeenCalledWith('proc-a');
    expect(processService.list).toHaveBeenCalled();
    expect(processService.openLogs).toHaveBeenCalledWith('proc-a', {
      replay: true
    });
    expect(processService.kill).toHaveBeenCalledWith('proc-a', 2);
    expect(processService.hasActive).toHaveBeenCalled();
  });
});
