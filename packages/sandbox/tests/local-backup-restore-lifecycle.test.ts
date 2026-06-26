import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupRestoreOperationRecord } from '../src/backup/restore-operation-store';
import { ErrorCode, RPCTransportError } from '../src/errors';
import { Sandbox } from '../src/sandbox';

vi.mock('./interpreter', () => ({
  CodeInterpreter: vi.fn().mockImplementation(() => ({}))
}));

vi.mock('@cloudflare/containers', () => {
  class MockContainer {
    ctx: unknown;
    env: unknown;
    sleepAfter: string | number = '10m';

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }

    async getState(): Promise<{ status: string }> {
      return { status: 'healthy' };
    }

    renewActivityTimeout(): void {}
  }

  return {
    Container: MockContainer,
    ContainerProxy: MockContainer,
    getContainer: vi.fn(),
    switchPort: vi.fn((request: Request) => request)
  };
});

type StoredValue = unknown;

type LocalBucket = ReturnType<typeof createMockR2Bucket>;

function createStorage(initial = new Map<string, StoredValue>()) {
  const storage = {
    get: vi.fn(async (key: string) => initial.get(key) ?? null),
    put: vi.fn(async (key: string, value: StoredValue) => {
      initial.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      initial.delete(key);
    }),
    list: vi.fn(async () => new Map<string, StoredValue>()),
    transaction: vi.fn(
      async (callback: (txn: DurableObjectTransaction) => unknown) =>
        callback(storage as unknown as DurableObjectTransaction)
    )
  };
  return storage as unknown as DurableObjectStorage;
}

function createDisposedRPCError(): RPCTransportError {
  return new RPCTransportError({
    code: ErrorCode.RPC_TRANSPORT_ERROR,
    message: 'RPC session was shut down by disposing the main stub',
    httpStatus: 503,
    context: {
      kind: 'session_disposed',
      originalMessage: 'RPC session was shut down by disposing the main stub',
      errorName: 'Error'
    },
    timestamp: '2026-06-23T12:00:00.000Z'
  });
}

function createMockR2Bucket() {
  const store = new Map<string, { data: ArrayBuffer; size: number }>();
  return {
    put: vi.fn(async (key: string, data: string | Uint8Array) => {
      const bytes =
        typeof data === 'string' ? new TextEncoder().encode(data) : data;
      store.set(key, {
        data: new Uint8Array(bytes).buffer as ArrayBuffer,
        size: bytes.byteLength
      });
    }),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        arrayBuffer: async () => entry.data,
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

async function createLocalRestoreSandbox(
  params: { bucket?: LocalBucket } = {}
) {
  const storageMap = new Map<string, StoredValue>();
  storageMap.set('currentRuntimeIdentity', { id: 'runtime-1' });
  storageMap.set('sandbox:lifetime', {
    id: 'lifetime-1',
    generation: 1,
    createdAt: '2026-06-23T12:00:00.000Z',
    updatedAt: '2026-06-23T12:00:00.000Z'
  });

  const bucket = params.bucket ?? createMockR2Bucket();
  const backupId = '12345678-1234-1234-1234-123456789012';
  await bucket.put(
    `backups/${backupId}/meta.json`,
    JSON.stringify({
      id: backupId,
      dir: '/workspace/project',
      sizeBytes: 4,
      ttl: 3600,
      createdAt: '2026-06-23T12:00:00.000Z'
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

  vi.spyOn(sandbox.client.utils, 'createSession').mockResolvedValue({
    success: true,
    id: 'backup-session',
    message: 'Created',
    timestamp: '2026-06-23T12:00:00.000Z'
  });
  vi.spyOn(sandbox.client.utils, 'deleteSession').mockResolvedValue({
    success: true,
    sessionId: 'backup-session',
    timestamp: '2026-06-23T12:00:00.000Z'
  });
  vi.spyOn(sandbox.client.files, 'writeFile').mockResolvedValue({
    success: true,
    path: `/var/backups/${backupId}.sqsh`,
    timestamp: '2026-06-23T12:00:00.000Z'
  });
  vi.spyOn(sandbox.client.commands, 'execute').mockResolvedValue({
    success: true,
    stdout: '',
    stderr: '',
    exitCode: 0,
    command: '',
    timestamp: '2026-06-23T12:00:00.000Z'
  });

  return { sandbox, storageMap, backupId };
}

describe('local backup restore lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses lifecycle records and verifies local restore completion', async () => {
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
      operationKey: `restore:${backupId}:/workspace/project`,
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

  it('does not mark local archive_ready before writeFile completes', async () => {
    const { sandbox, storageMap, backupId } = await createLocalRestoreSandbox();
    vi.spyOn(sandbox.client.files, 'writeFile').mockImplementationOnce(
      async () => {
        const record = storageMap.get(
          `operations:restore:${backupId}:/workspace/project`
        ) as BackupRestoreOperationRecord;
        expect(record.phase).toBe('runtime_ready');
        return {
          success: true,
          path: `/var/backups/${backupId}.sqsh`,
          timestamp: '2026-06-23T12:00:00.000Z'
        };
      }
    );

    await sandbox.restoreBackup({
      id: backupId,
      dir: '/workspace/project',
      localBucket: true
    });
  });

  it('recovers internally when local archive write loses the RPC transport once', async () => {
    const { sandbox, storageMap, backupId } = await createLocalRestoreSandbox();
    const writeFileSpy = vi
      .spyOn(sandbox.client.files, 'writeFile')
      .mockRejectedValueOnce(createDisposedRPCError())
      .mockResolvedValueOnce({
        success: true,
        path: `/var/backups/${backupId}.sqsh`,
        timestamp: '2026-06-23T12:00:00.000Z'
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
    expect(writeFileSpy).toHaveBeenCalledTimes(2);
    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record.status).toBe('committed');
    expect(record.phase).toBe('verified');
  });
});
