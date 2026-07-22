import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  registerShutdownHandlers,
  startServer,
  webSocketUpgradeFailedResponse
} from '../src/server';

describe('server WebSocket upgrade failures', () => {
  it('returns 503 so SDK upgrade transports can retry', async () => {
    const response = webSocketUpgradeFailedResponse();

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe('WebSocket upgrade failed');
  });
});

describe('terminal WebSocket runtime fencing', () => {
  const runtimeIncarnationID = '00000000-0000-4000-8000-000000000001';
  const originalRandomUUID = crypto.randomUUID;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    crypto.randomUUID = (() =>
      runtimeIncarnationID) as typeof crypto.randomUUID;
    const server = await startServer();
    cleanup = server.cleanup;
    crypto.randomUUID = originalRandomUUID;
  });

  afterAll(async () => {
    crypto.randomUUID = originalRandomUUID;
    await cleanup?.();
  });

  it('rejects missing runtime incarnation before upgrade', async () => {
    const response = await fetch(
      'http://localhost:3000/ws/terminal?terminalId=terminal-1',
      {
        headers: { Upgrade: 'websocket' }
      }
    );

    expect(response.status).toBe(409);
  });

  it('rejects mismatched runtime incarnation before upgrade', async () => {
    const response = await fetch(
      'http://localhost:3000/ws/terminal?terminalId=terminal-1&runtimeIncarnationID=other',
      { headers: { Upgrade: 'websocket' } }
    );

    expect(response.status).toBe(409);
  });

  it('accepts matching runtime incarnation through pre-upgrade validation', async () => {
    const response = await fetch(
      `http://localhost:3000/ws/terminal?terminalId=terminal-1&runtimeIncarnationID=${runtimeIncarnationID}`,
      { headers: { Upgrade: 'websocket' } }
    );

    expect(response.status).not.toBe(409);
  });
});

describe('registerShutdownHandlers', () => {
  const originalExit = process.exit;

  afterAll(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.exit = originalExit;
  });

  it('runs cleanup once for repeated SIGTERM signals', async () => {
    let cleanupCalls = 0;
    let resolveCleanup!: () => void;
    const cleanupDone = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    const exitCodes: (string | number | null | undefined)[] = [];
    process.exit = ((code?: string | number | null | undefined) => {
      exitCodes.push(code);
      return undefined as never;
    }) as typeof process.exit;

    registerShutdownHandlers(async () => {
      cleanupCalls += 1;
      await cleanupDone;
    });

    process.emit('SIGTERM');
    process.emit('SIGTERM');
    await Promise.resolve();

    expect(cleanupCalls).toBe(1);
    expect(exitCodes).toEqual([]);

    resolveCleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(exitCodes).toEqual([0, 0]);
  });

  it('replaces earlier cleanup owners on later registration', async () => {
    let oldCleanupCalls = 0;
    let newCleanupCalls = 0;
    const exitCodes: (string | number | null | undefined)[] = [];
    process.exit = ((code?: string | number | null | undefined) => {
      exitCodes.push(code);
      return undefined as never;
    }) as typeof process.exit;

    registerShutdownHandlers(async () => {
      oldCleanupCalls += 1;
    });
    registerShutdownHandlers(async () => {
      newCleanupCalls += 1;
    });

    process.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(oldCleanupCalls).toBe(0);
    expect(newCleanupCalls).toBe(1);
    expect(exitCodes).toEqual([0]);
  });
});
