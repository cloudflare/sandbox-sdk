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

function createBackupBucket(createdAt = '2026-06-15T12:00:00.000Z') {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        ttl: 259200,
        createdAt,
        dir: '/workspace/project'
      })
    }),
    head: vi.fn().mockResolvedValue({ size: 42 }),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ objects: [], truncated: false })
  };
}

async function createBackupSandbox(params?: {
  storageMap?: Map<string, StoredValue>;
  bucket?: ReturnType<typeof createBackupBucket>;
}) {
  const storageMap = params?.storageMap ?? new Map<string, StoredValue>();
  storageMap.set('currentRuntimeIdentity', { id: 'runtime-1' });
  storageMap.set('sandbox:incarnation', {
    id: 'incarnation-1',
    generation: 1,
    createdAt: '2026-06-15T12:00:00.000Z',
    updatedAt: '2026-06-15T12:00:00.000Z'
  });

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

  const bucket = params?.bucket ?? createBackupBucket();
  const sandbox = new Sandbox(ctx, {
    BACKUP_BUCKET: bucket,
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
    R2_ACCESS_KEY_ID: 'test-key',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    BACKUP_BUCKET_NAME: 'test-backups',
    SANDBOX_ENABLE_TEST_HOOKS: 'true'
  });

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
  const sandboxInternals = sandbox as unknown as {
    execWithSession: () => Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>;
  };
  vi.spyOn(sandboxInternals, 'execWithSession').mockResolvedValue({
    stdout: '42',
    stderr: '',
    exitCode: 0
  });
  vi.spyOn(sandbox.client.backup, 'restoreArchive').mockResolvedValue({
    success: true,
    dir: '/workspace/project'
  } as never);

  return { sandbox, storageMap, bucket };
}

describe('backup restore operation records', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
  });

  it('writes a verified operation record after restore succeeds under the current runtime', async () => {
    const { sandbox, storageMap } = await createBackupSandbox();
    const backupId = crypto.randomUUID();

    await sandbox.restoreBackup({ id: backupId, dir: '/workspace/project' });

    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record).toMatchObject({
      operationKey: `restore:${backupId}:/workspace/project`,
      kind: 'backup.restore',
      incarnationId: 'incarnation-1',
      runtimeIdentityID: 'runtime-1',
      phase: 'verified',
      status: 'committed',
      payload: {
        backupId,
        dir: '/workspace/project',
        archiveSize: 42
      },
      result: {
        success: true,
        id: backupId,
        dir: '/workspace/project'
      },
      completedAt: expect.any(String)
    });
  });

  it('recovers internally when a configured archive-ready fault fires once', async () => {
    const { sandbox, storageMap } = await createBackupSandbox();
    const backupId = crypto.randomUUID();
    await (
      sandbox as unknown as {
        __setBackupRestoreFaultForTesting: (fault: {
          phase: 'after_archive_ready';
          mode: 'transport_disposed';
          times: number;
        }) => Promise<void>;
      }
    ).__setBackupRestoreFaultForTesting({
      phase: 'after_archive_ready',
      mode: 'transport_disposed',
      times: 1
    });
    const restoreArchiveSpy = vi.spyOn(sandbox.client.backup, 'restoreArchive');

    const result = await sandbox.restoreBackup({
      id: backupId,
      dir: '/workspace/project'
    });

    expect(result).toEqual({
      success: true,
      id: backupId,
      dir: '/workspace/project'
    });
    expect(restoreArchiveSpy).toHaveBeenCalledTimes(1);

    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record.status).toBe('committed');
    expect(record.phase).toBe('verified');
    expect(record.result).toEqual(result);
  });

  it('recovers internally when the first restore attempt loses the RPC transport', async () => {
    const { sandbox, storageMap } = await createBackupSandbox();
    const backupId = crypto.randomUUID();
    const restoreArchiveSpy = vi
      .spyOn(sandbox.client.backup, 'restoreArchive')
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
      .mockResolvedValueOnce({ success: true, dir: '/workspace/project' });

    const result = await sandbox.restoreBackup({
      id: backupId,
      dir: '/workspace/project'
    });

    expect(result).toEqual({
      success: true,
      id: backupId,
      dir: '/workspace/project'
    });
    expect(restoreArchiveSpy).toHaveBeenCalledTimes(2);

    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record.status).toBe('committed');
    expect(record.phase).toBe('verified');
    expect(record.result).toEqual(result);
  });

  it('surfaces OPERATION_INTERRUPTED after exhausting restore recovery attempts', async () => {
    const { sandbox, storageMap } = await createBackupSandbox();
    const backupId = crypto.randomUUID();
    const restoreArchiveSpy = vi
      .spyOn(sandbox.client.backup, 'restoreArchive')
      .mockRejectedValue(
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
      await sandbox.restoreBackup({ id: backupId, dir: '/workspace/project' });
    } catch (error) {
      thrown = error;
    }

    expect(restoreArchiveSpy).toHaveBeenCalledTimes(3);
    expect(thrown).toBeInstanceOf(OperationInterruptedError);
    const interrupted = thrown as OperationInterruptedError;
    expect(interrupted.context).toEqual({
      reason: 'recovery_exhausted',
      operation: 'backup.restore',
      operationId: expect.any(String),
      operationKey: `restore:${backupId}:/workspace/project`,
      idempotencyKey: `restore:${backupId}:/workspace/project`,
      backupId,
      dir: '/workspace/project',
      phase: 'interrupted',
      admitted: 'unknown',
      retryable: true,
      recoveryAttempts: 2,
      maxRecoveryAttempts: 2
    });

    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record.status).toBe('interrupted');
    expect(record.phase).toBe('interrupted');
  });

  it('recovers internally when the runtime changes after restoreArchive returns', async () => {
    const { sandbox, storageMap } = await createBackupSandbox();
    const backupId = crypto.randomUUID();
    const restoreArchiveSpy = vi
      .spyOn(sandbox.client.backup, 'restoreArchive')
      .mockImplementationOnce(async () => {
        storageMap.delete('currentRuntimeIdentity');
        return { success: true, dir: '/workspace/project' } as never;
      })
      .mockResolvedValueOnce({ success: true, dir: '/workspace/project' });

    const result = await sandbox.restoreBackup({
      id: backupId,
      dir: '/workspace/project'
    });

    expect(result).toEqual({
      success: true,
      id: backupId,
      dir: '/workspace/project'
    });
    expect(restoreArchiveSpy).toHaveBeenCalledTimes(2);

    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record.status).toBe('committed');
    expect(record.phase).toBe('verified');
    expect(record.runtimeIdentityID).toEqual(expect.any(String));
    expect(record.runtimeIdentityID).not.toBe('runtime-1');
    expect(record.result).toEqual(result);
  });

  it('does not retry restore across a sandbox incarnation change', async () => {
    const { sandbox, storageMap } = await createBackupSandbox();
    const backupId = crypto.randomUUID();
    const restoreArchiveSpy = vi
      .spyOn(sandbox.client.backup, 'restoreArchive')
      .mockImplementationOnce(async () => {
        storageMap.set('sandbox:incarnation', {
          id: 'incarnation-2',
          generation: 2,
          createdAt: '2026-06-15T12:01:00.000Z',
          updatedAt: '2026-06-15T12:01:00.000Z'
        });
        return { success: true, dir: '/workspace/project' } as never;
      })
      .mockResolvedValueOnce({ success: true, dir: '/workspace/project' });

    let thrown: unknown;
    try {
      await sandbox.restoreBackup({ id: backupId, dir: '/workspace/project' });
    } catch (error) {
      thrown = error;
    }

    expect(restoreArchiveSpy).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(OperationInterruptedError);
    const interrupted = thrown as OperationInterruptedError;
    expect(interrupted.context).toEqual({
      reason: 'incarnation_changed',
      operation: 'backup.restore',
      operationId: expect.any(String),
      operationKey: `restore:${backupId}:/workspace/project`,
      idempotencyKey: `restore:${backupId}:/workspace/project`,
      backupId,
      dir: '/workspace/project',
      phase: 'archive_ready',
      admitted: true,
      retryable: true
    });

    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record.status).toBe('interrupted');
    expect(record.phase).toBe('interrupted');
    expect(record.result).toBeUndefined();
  });
});
