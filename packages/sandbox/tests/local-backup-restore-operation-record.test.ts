import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupRestoreOperationRecord } from '../src/durable-operation-records';
import {
  ErrorCode,
  OperationInterruptedError,
  RPCTransportError
} from '../src/errors';
import { Sandbox } from '../src/sandbox';
import { createMockControlClient } from './helpers/mock-control-client';

vi.mock('@cloudflare/containers', () => {
  class MockContainer {
    ctx: DurableObjectState<{}>;
    env: unknown;

    constructor(ctx: DurableObjectState<{}>, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }

    async getState(): Promise<{ status: string }> {
      return { status: 'healthy' };
    }
  }

  return {
    Container: MockContainer,
    ContainerProxy: MockContainer,
    getContainer: vi.fn(),
    switchPort: vi.fn()
  };
});

type StoredValue = unknown;

function createStorage(initial = new Map<string, StoredValue>()) {
  return {
    get: vi.fn(async (key: string) => initial.get(key)),
    put: vi.fn(async (key: string, value: StoredValue) => {
      initial.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      initial.delete(key);
    }),
    list: vi.fn(async () => new Map<string, StoredValue>())
  } as unknown as DurableObjectStorage;
}

function createMockR2Bucket() {
  const store = new Map<string, { data: ArrayBuffer; size: number }>();
  return {
    put: vi.fn(async (key: string, data: string | ArrayBuffer | Uint8Array) => {
      let bytes: Uint8Array;
      if (typeof data === 'string') {
        bytes = new TextEncoder().encode(data);
      } else if (data instanceof Uint8Array) {
        bytes = new Uint8Array(data);
      } else {
        bytes = new Uint8Array(data);
      }
      store.set(key, {
        data: bytes.buffer as ArrayBuffer,
        size: bytes.byteLength
      });
    }),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        json: async <T>() =>
          JSON.parse(new TextDecoder().decode(entry.data)) as T,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(entry.data));
            controller.close();
          }
        })
      };
    }),
    head: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      return { size: entry.size };
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ objects: [], truncated: false }))
  };
}

async function createLocalRestoreSandbox() {
  const storageMap = new Map<string, StoredValue>();
  storageMap.set('currentRuntimeIdentity', { id: 'runtime-1' });
  storageMap.set('sandbox:incarnation', {
    id: 'incarnation-1',
    generation: 1,
    createdAt: '2026-06-15T12:00:00.000Z',
    updatedAt: '2026-06-15T12:00:00.000Z'
  });

  const bucket = createMockR2Bucket();
  const backupId = '12345678-1234-1234-1234-123456789012';
  await bucket.put(
    `backups/${backupId}/meta.json`,
    JSON.stringify({
      id: backupId,
      dir: '/workspace/project',
      sizeBytes: 4,
      ttl: 3600,
      createdAt: '2026-06-15T12:00:00.000Z'
    })
  );
  await bucket.put(
    `backups/${backupId}/data.sqsh`,
    new Uint8Array([0x68, 0x73, 0x71, 0x73])
  );

  const ctx = {
    storage: createStorage(storageMap),
    blockConcurrencyWhile: vi.fn(<T>(callback: () => Promise<T>) => callback()),
    waitUntil: vi.fn(),
    id: {
      toString: () => 'test-sandbox-id',
      equals: vi.fn(),
      name: 'test-sandbox'
    },
    container: { running: true }
  } as unknown as DurableObjectState<{}>;

  const sandbox = new Sandbox(ctx, { BACKUP_BUCKET: bucket });
  await vi.waitFor(() => {
    expect(ctx.blockConcurrencyWhile).toHaveBeenCalled();
  });

  sandbox.client = createMockControlClient();
  vi.spyOn(sandbox.client.utils, 'createSession').mockResolvedValue({
    success: true,
    id: 'backup-session',
    message: 'Created'
  } as never);
  vi.spyOn(sandbox.client.utils, 'deleteSession').mockResolvedValue({
    success: true,
    sessionId: 'backup-session',
    timestamp: '2026-06-15T12:00:00.000Z'
  } as never);
  vi.spyOn(sandbox.client.files, 'writeFileStream').mockResolvedValue({
    success: true,
    path: `/var/backups/${backupId}.sqsh`,
    bytesWritten: 4,
    timestamp: '2026-06-15T12:00:00.000Z'
  } as never);
  vi.spyOn(sandbox.client.commands, 'execute').mockResolvedValue({
    success: true,
    stdout: '',
    stderr: '',
    exitCode: 0,
    command: '',
    timestamp: '2026-06-15T12:00:00.000Z'
  } as never);

  return { sandbox, storageMap, backupId };
}

describe('local backup restore operation records', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
  });

  it('writes a verified operation record after local restore succeeds', async () => {
    const { sandbox, storageMap, backupId } = await createLocalRestoreSandbox();

    const result = await sandbox.restoreBackup({
      id: backupId,
      dir: '/workspace/project',
      localBucket: true
    });

    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record).toMatchObject({
      kind: 'backup.restore',
      status: 'committed',
      phase: 'verified',
      runtimeIdentityID: 'runtime-1',
      payload: {
        backupId,
        dir: '/workspace/project',
        archiveSize: 4
      },
      result
    });
  });

  it('recovers internally when local archive streaming loses the RPC transport once', async () => {
    const { sandbox, storageMap, backupId } = await createLocalRestoreSandbox();
    const writeFileStreamSpy = vi
      .spyOn(sandbox.client.files, 'writeFileStream')
      .mockRejectedValueOnce(
        new RPCTransportError({
          code: ErrorCode.RPC_TRANSPORT_ERROR,
          message: 'RPC session was shut down by disposing the main stub',
          httpStatus: 503,
          context: {
            kind: 'session_disposed',
            originalMessage:
              'RPC session was shut down by disposing the main stub',
            errorName: 'Error'
          },
          timestamp: '2026-06-15T12:00:00.000Z'
        })
      )
      .mockResolvedValueOnce({
        success: true,
        path: `/var/backups/${backupId}.sqsh`,
        bytesWritten: 4,
        timestamp: '2026-06-15T12:00:00.000Z'
      });

    const result = await sandbox.restoreBackup({
      id: backupId,
      dir: '/workspace/project',
      localBucket: true
    });

    expect(result).toEqual({
      success: true,
      id: backupId,
      dir: '/workspace/project'
    });
    expect(writeFileStreamSpy).toHaveBeenCalledTimes(2);
    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record.status).toBe('committed');
    expect(record.phase).toBe('verified');
  });

  it('surfaces OPERATION_INTERRUPTED after exhausting local restore recovery attempts', async () => {
    const { sandbox, backupId } = await createLocalRestoreSandbox();
    vi.spyOn(sandbox.client.files, 'writeFileStream').mockRejectedValue(
      new RPCTransportError({
        code: ErrorCode.RPC_TRANSPORT_ERROR,
        message: 'RPC session was shut down by disposing the main stub',
        httpStatus: 503,
        context: {
          kind: 'session_disposed',
          originalMessage:
            'RPC session was shut down by disposing the main stub',
          errorName: 'Error'
        },
        timestamp: '2026-06-15T12:00:00.000Z'
      })
    );

    let thrown: unknown;
    try {
      await sandbox.restoreBackup({
        id: backupId,
        dir: '/workspace/project',
        localBucket: true
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OperationInterruptedError);
    const interrupted = thrown as OperationInterruptedError;
    expect(interrupted.context).toMatchObject({
      reason: 'recovery_exhausted',
      operation: 'backup.restore',
      backupId,
      dir: '/workspace/project',
      recoveryAttempts: 2,
      maxRecoveryAttempts: 2
    });
  });
});
