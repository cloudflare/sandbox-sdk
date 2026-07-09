import type { ProcessLogEvent } from '@repo/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv, createMockProcess, createMockSandbox, parseSSE, sandboxUrl } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  Sandbox: class {}
}));

const { app } = await import('./bridge-app');
const env = createMockEnv();

function processUrl(path = '', query?: string): string {
  return sandboxUrl('test', path ? `processes/${path}` : 'processes', query);
}

function postProcess(body: Record<string, unknown>) {
  return app.request(
    processUrl(),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    },
    env
  );
}

describe('process routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('launches argv and returns rich status with a required PID', async () => {
    const argv = ['printf', '%s', '$HOME; rm -rf /'];
    const process = createMockProcess({
      id: 'proc-created',
      pid: 42,
      command: argv,
      cwd: '/workspace/app'
    });
    mockSandbox.exec.mockResolvedValueOnce(process);

    const res = await postProcess({
      argv,
      cwd: '/workspace/app',
      env: { A: '1' },
      timeout: 1234
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(await process.status());
    expect((await process.status()).pid).toBe(42);
    expect(mockSandbox.exec).toHaveBeenCalledWith(argv, {
      cwd: '/workspace/app',
      env: { A: '1' },
      timeout: 1234
    });
    expect(env._poolStub.getContainer).toHaveBeenCalledWith('test');
  });

  it.each([
    [{ argv: [] }, 'argv must be a non-empty array'],
    [{ cwd: '/workspace' }, 'argv must be a non-empty array'],
    [{ argv: ['echo', 123] }, 'argv items must be strings'],
    [{ argv: [''] }, 'argv executable must be non-empty'],
    [{ argv: ['sleep', '1'], timeout: '1000' }, 'timeout must be a positive finite number'],
    [{ argv: ['sleep', '1'], timeout: 0 }, 'timeout must be a positive finite number'],
    [{ argv: ['sleep', '1'], timeout: -1 }, 'timeout must be a positive finite number'],
    [{ argv: ['sleep', '1'], timeout: null }, 'timeout must be a positive finite number'],
    [{ argv: ['env'], env: ['A=1'] }, 'env must be an object of strings']
  ])('rejects invalid launch request %#', async (body, error) => {
    const res = await postProcess(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error, code: 'invalid_request' });
    expect(mockSandbox.exec).not.toHaveBeenCalled();
  });

  it('returns listProcesses statuses directly without N+1 inspection', async () => {
    const statuses = [await createMockProcess({ id: 'p1' }).status(), await createMockProcess({ id: 'p2' }).status()];
    mockSandbox.listProcesses.mockResolvedValueOnce(statuses);

    const res = await app.request(processUrl(), {}, env);

    expect(await res.json()).toEqual(statuses);
    expect(mockSandbox.listProcesses).toHaveBeenCalledOnce();
    expect(env._poolStub.lookupContainer).toHaveBeenCalledWith('test');
    expect(env._poolStub.getContainer).not.toHaveBeenCalled();
  });

  it('uses status for a requested process', async () => {
    const process = createMockProcess({ id: 'target' });
    mockSandbox.getProcess.mockResolvedValueOnce(process);

    const res = await app.request(processUrl('target'), {}, env);

    expect(await res.json()).toEqual(await process.status());
    expect(process.status).toHaveBeenCalled();
    expect(env._poolStub.lookupContainer).toHaveBeenCalledWith('test');
    expect(env._poolStub.getContainer).not.toHaveBeenCalled();
  });

  it('returns 404 when a process is absent', async () => {
    mockSandbox.getProcess.mockResolvedValueOnce(null);
    expect((await app.request(processUrl('missing'), {}, env)).status).toBe(404);
  });

  it('base64-encodes only stdout/stderr bytes and omits processId', async () => {
    const process = createMockProcess({
      id: 'loggy',
      logs: [
        {
          type: 'stdout',
          cursor: 'c1',
          timestamp: '2026-07-08T00:00:00.000Z',
          data: new Uint8Array([0, 1, 2, 255])
        },
        {
          type: 'terminal',
          state: 'exited',
          cursor: 'c2',
          timestamp: '2026-07-08T00:00:01.000Z',
          exit: { code: 0, timedOut: false }
        }
      ]
    });
    mockSandbox.getProcess.mockResolvedValueOnce(process);

    const res = await app.request(processUrl('loggy/logs', 'since=c0&replay=true&follow=1'), {}, env);
    const events = parseSSE(await res.text()).map((event) => JSON.parse(event.data));

    expect(process.logs).toHaveBeenCalledWith({
      since: 'c0',
      replay: true,
      follow: true
    });
    expect(events).toEqual([
      {
        type: 'stdout',
        cursor: 'c1',
        timestamp: '2026-07-08T00:00:00.000Z',
        data: 'AAEC/w=='
      },
      {
        type: 'terminal',
        state: 'exited',
        cursor: 'c2',
        timestamp: '2026-07-08T00:00:01.000Z',
        exit: { code: 0, timedOut: false }
      }
    ]);
  });

  it('cancels log observation without killing the process', async () => {
    let cancelled = false;
    const logs = new ReadableStream<ProcessLogEvent>({
      start(controller) {
        controller.enqueue({
          type: 'stdout',
          cursor: 'c1',
          timestamp: '2026-07-08T00:00:00.000Z',
          data: new TextEncoder().encode('started\n')
        });
      },
      cancel() {
        cancelled = true;
      }
    });
    const process = createMockProcess({ id: 'observed' });
    process.logs.mockResolvedValueOnce(logs);
    mockSandbox.getProcess.mockResolvedValueOnce(process);

    const res = await app.request(processUrl('observed/logs', 'replay=true&follow=true'), {}, env);
    const reader = res.body!.getReader();

    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    await Promise.resolve();

    expect(cancelled).toBe(true);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it.each([
    { body: undefined, expectedSignal: 15 },
    { body: {}, expectedSignal: 15 },
    { body: { signal: 9 }, expectedSignal: 9 }
  ])('kills with validated numeric signal %#', async ({ body, expectedSignal }) => {
    const process = createMockProcess({ id: 'p-kill' });
    mockSandbox.getProcess.mockResolvedValueOnce(process);
    const res = await app.request(
      processUrl('p-kill/kill'),
      body === undefined
        ? { method: 'POST' }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          },
      env
    );
    expect(res.status).toBe(204);
    expect(process.kill).toHaveBeenCalledWith(expectedSignal);
    expect(env._poolStub.lookupContainer).toHaveBeenCalledWith('test');
    expect(env._poolStub.getContainer).not.toHaveBeenCalled();
  });

  it.each([0, 65, 1.5, 'TERM', null])('rejects invalid kill signal %s', async (signal) => {
    const process = createMockProcess({ id: 'p-kill' });
    mockSandbox.getProcess.mockResolvedValueOnce(process);
    const res = await app.request(
      processUrl('p-kill/kill'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signal })
      },
      env
    );
    expect(res.status).toBe(400);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it.each([null, [], 'TERM'])('rejects invalid kill body %s', async (body) => {
    const process = createMockProcess({ id: 'p-kill' });
    mockSandbox.getProcess.mockResolvedValueOnce(process);
    const res = await app.request(
      processUrl('p-kill/kill'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      },
      env
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'invalid_request' });
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('does not expose interrupt or terminate process aliases', async () => {
    expect((await app.request(processUrl('p/interrupt'), { method: 'POST' }, env)).status).toBe(404);
    expect((await app.request(processUrl('p/terminate'), { method: 'POST' }, env)).status).toBe(404);
  });

  it('publishes discriminated process status and numeric kill in OpenAPI', async () => {
    const res = await app.request('http://localhost/v1/openapi.json', {}, env);
    const schema = (await res.json()) as {
      components: { schemas: Record<string, unknown> };
      paths: Record<string, unknown>;
    };

    expect(schema.components.schemas.ProcessStatus).toMatchObject({
      discriminator: { propertyName: 'state' }
    });
    expect(schema.components.schemas[`Process${'Snapshot'}`]).toBeUndefined();
    expect(schema.paths['/v1/sandbox/{id}/processes/{processId}/kill']).toBeDefined();
    expect(schema.paths['/v1/sandbox/{id}/processes/{processId}/interrupt']).toBeUndefined();
    expect(schema.paths['/v1/sandbox/{id}/processes/{processId}/terminate']).toBeUndefined();
  });
});
