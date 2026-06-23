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

type TestStorage = DurableObjectStorage & {
  backing: Map<string, StoredValue>;
};

type TestBucket = ReturnType<typeof createBackupBucket>;

function createStorage(
  initial = new Map<string, StoredValue>(),
  hooks?: { onPut?: (key: string, value: StoredValue) => void }
): TestStorage {
  const storage = {
    backing: initial,
    get: vi.fn(async (key: string) => initial.get(key) ?? null),
    put: vi.fn(async (key: string, value: StoredValue) => {
      initial.set(key, value);
      hooks?.onPut?.(key, value);
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
  return storage as unknown as TestStorage;
}

function createBackupBucket(createdAt = '2026-06-23T12:00:00.000Z') {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        ttl: 259_200,
        createdAt,
        dir: '/workspace/project'
      })
    }),
    head: vi.fn().mockResolvedValue({ size: 42 }),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ objects: [], truncated: false })
  };
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

async function createBackupSandbox(
  params: {
    storageHooks?: { onPut?: (key: string, value: StoredValue) => void };
    bucket?: TestBucket;
  } = {}
) {
  const storageMap = new Map<string, StoredValue>();
  storageMap.set('currentRuntimeIdentity', { id: 'runtime-1' });
  storageMap.set('sandbox:lifetime', {
    id: 'lifetime-1',
    generation: 1,
    createdAt: '2026-06-23T12:00:00.000Z',
    updatedAt: '2026-06-23T12:00:00.000Z'
  });

  const storage = createStorage(storageMap, params.storageHooks);
  const ctx = {
    storage,
    blockConcurrencyWhile: vi.fn(<T>(callback: () => Promise<T>) => callback()),
    waitUntil: vi.fn(),
    id: {
      toString: () => 'test-sandbox-id',
      equals: vi.fn(),
      name: 'test-sandbox'
    },
    container: { running: true }
  } as unknown as DurableObjectState<{}>;

  const bucket = params.bucket ?? createBackupBucket();
  const sandbox = new Sandbox(ctx, {
    BACKUP_BUCKET: bucket,
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
    R2_ACCESS_KEY_ID: 'test-key',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    BACKUP_BUCKET_NAME: 'test-backups'
  });

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
  vi.spyOn(sandbox.client.backup, 'restoreArchive').mockResolvedValue({
    success: true,
    dir: '/workspace/project'
  });

  const sandboxInternals = sandbox as unknown as {
    downloadBackupParallel: (
      archivePath: string,
      r2Key: string,
      sizeBytes: number,
      backupId: string,
      dir: string,
      sessionId: string
    ) => Promise<void>;
    execWithSession: () => Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>;
  };
  vi.spyOn(sandboxInternals, 'downloadBackupParallel').mockResolvedValue(
    undefined
  );
  vi.spyOn(sandboxInternals, 'execWithSession').mockResolvedValue({
    stdout: '0',
    stderr: '',
    exitCode: 0
  });

  return { sandbox, storageMap, bucket };
}

describe('backup restore lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries and succeeds when runtime replacement is detected after archive readiness', async () => {
    const backupId = crypto.randomUUID();
    let replaced = false;
    const { sandbox, storageMap } = await createBackupSandbox({
      storageHooks: {
        onPut(key, value) {
          const record = value as Partial<BackupRestoreOperationRecord>;
          if (
            !replaced &&
            key === `operations:restore:${backupId}:/workspace/project` &&
            record.phase === 'archive_ready'
          ) {
            replaced = true;
            storageMap.set('currentRuntimeIdentity', { id: 'runtime-2' });
          }
        }
      }
    });

    const result = await sandbox.restoreBackup({
      id: backupId,
      dir: '/workspace/project'
    });

    expect(result).toEqual({
      success: true,
      id: backupId,
      dir: '/workspace/project'
    });
    expect(sandbox.client.backup.restoreArchive).toHaveBeenCalledTimes(2);
    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record.status).toBe('committed');
    expect(record.phase).toBe('verified');
    expect(record.runtimeIdentityID).toBe('runtime-2');
  });

  it('surfaces OPERATION_INTERRUPTED after exhausting runtime recovery attempts', async () => {
    const { sandbox, storageMap } = await createBackupSandbox();
    const backupId = crypto.randomUUID();
    vi.spyOn(sandbox.client.backup, 'restoreArchive').mockRejectedValue(
      createDisposedRPCError()
    );

    await expect(
      sandbox.restoreBackup({ id: backupId, dir: '/workspace/project' })
    ).rejects.toMatchObject({
      name: 'OperationInterruptedError',
      code: ErrorCode.OPERATION_INTERRUPTED,
      context: {
        reason: 'recovery_exhausted',
        operation: 'backup.restore',
        phase: 'interrupted',
        admitted: 'unknown',
        retryable: false,
        recoveryAttempts: 2,
        maxRecoveryAttempts: 2
      }
    });

    expect(sandbox.client.backup.restoreArchive).toHaveBeenCalledTimes(3);
    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record.status).toBe('interrupted');
    expect(record.phase).toBe('interrupted');
  });

  it('does not retry when the sandbox lifetime changes before runtime work starts', async () => {
    const backupId = crypto.randomUUID();
    let lifetimeChanged = false;
    const { sandbox, storageMap } = await createBackupSandbox({
      storageHooks: {
        onPut(key, value) {
          const record = value as Partial<BackupRestoreOperationRecord>;
          if (
            !lifetimeChanged &&
            key === `operations:restore:${backupId}:/workspace/project` &&
            record.phase === 'validating'
          ) {
            lifetimeChanged = true;
            storageMap.set('sandbox:lifetime', {
              id: 'lifetime-2',
              generation: 2,
              createdAt: '2026-06-23T12:00:00.000Z',
              updatedAt: '2026-06-23T12:00:00.000Z'
            });
          }
        }
      }
    });

    await expect(
      sandbox.restoreBackup({ id: backupId, dir: '/workspace/project' })
    ).rejects.toMatchObject({
      name: 'OperationInterruptedError',
      context: {
        reason: 'sandbox_lifetime_changed',
        operation: 'backup.restore',
        phase: 'validating',
        admitted: 'unknown',
        retryable: false
      }
    });

    expect(sandbox.client.backup.restoreArchive).not.toHaveBeenCalled();
  });
});
