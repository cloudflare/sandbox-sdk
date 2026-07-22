import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupRestoreOperationRecord } from '../src/backup/restore-operation-store';
import type { ContainerControlClient } from '../src/container-control';
import {
  ErrorCode,
  OperationInterruptedError,
  RPCTransportError
} from '../src/errors';
import { Sandbox } from '../src/sandbox';
import type { SandboxLifetimeID } from '../src/sandbox-lifetime';
import {
  asSandboxWithClient,
  createMockControlClient
} from './helpers/mock-control-client';

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

    async startAndWaitForPorts(): Promise<void> {}
  }

  return {
    Container: MockContainer,
    ContainerProxy: MockContainer,
    getContainer: vi.fn(),
    switchPort: vi.fn()
  };
});

type StoredValue = unknown;

function createStorage(
  initial = new Map<string, StoredValue>(),
  hooks?: {
    onPut?: (key: string, value: StoredValue) => void;
  }
) {
  return {
    get: vi.fn(async (key: string) => initial.get(key)),
    put: vi.fn(async (key: string, value: StoredValue) => {
      initial.set(key, value);
      hooks?.onPut?.(key, value);
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
    timestamp: '2026-06-15T12:00:00.000Z'
  });
}

function createNonRetryableInterruptedError(
  backupId: string,
  dir: string
): OperationInterruptedError {
  return new OperationInterruptedError({
    code: ErrorCode.OPERATION_INTERRUPTED,
    message: 'Restore was interrupted after unknown admission',
    httpStatus: 409,
    context: {
      reason: 'sandbox_lifetime_changed',
      operation: 'backup.restore',
      operationId: crypto.randomUUID(),
      operationKey: `restore:${backupId}:${dir}`,
      idempotencyKey: `restore:${backupId}:${dir}`,
      backupId,
      dir,
      phase: 'archive_ready',
      admitted: 'unknown',
      retryable: false
    },
    timestamp: '2026-06-15T12:00:00.000Z'
  });
}

async function createBackupSandbox(params?: {
  storageMap?: Map<string, StoredValue>;
  bucket?: ReturnType<typeof createBackupBucket>;
  storageHooks?: {
    onPut?: (key: string, value: StoredValue) => void;
  };
}) {
  const storageMap = params?.storageMap ?? new Map<string, StoredValue>();
  storageMap.set('currentRuntimeIdentity', {
    schemaVersion: 1,
    id: 'runtime-1',
    runtimeIncarnationID: 'incarnation-1'
  });
  storageMap.set('sandbox:lifetime', {
    id: 'lifetime-1',
    generation: 1,
    createdAt: '2026-06-15T12:00:00.000Z',
    updatedAt: '2026-06-15T12:00:00.000Z'
  });

  const ctx = {
    storage: createStorage(storageMap, params?.storageHooks),
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

  const sandboxWithClient = asSandboxWithClient(sandbox);
  sandboxWithClient.client = createMockControlClient();
  const runWakingSpy = vi
    .spyOn(
      (
        sandbox as unknown as {
          runtimeRunner: {
            runWaking<T>(
              operation: string,
              call: (lease: {
                runtime: { id: string; runtimeIncarnationID: string };
                control: ContainerControlClient;
                retain(): { release(): void };
              }) => Promise<T>
            ): Promise<T>;
          };
        }
      ).runtimeRunner,
      'runWaking'
    )
    .mockImplementation(async (_operation, call) =>
      call({
        runtime: {
          id: 'runtime-1',
          runtimeIncarnationID: 'incarnation-1'
        },
        control: sandboxWithClient.client,
        retain: () => ({ release: () => {} })
      })
    );
  vi.spyOn(sandboxWithClient.client.backup, 'restoreArchive').mockResolvedValue(
    {
      success: true,
      dir: '/workspace/project'
    } as never
  );

  return { sandbox, storageMap, bucket, runWakingSpy };
}

describe('backup restore lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
  });

  it('writes a verified operation record after restore succeeds under the current runtime', async () => {
    const { sandbox, storageMap, runWakingSpy } = await createBackupSandbox();
    const backupId = crypto.randomUUID();

    await sandbox.restoreBackup({ id: backupId, dir: '/workspace/project' });

    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(runWakingSpy).toHaveBeenCalledTimes(1);
    expect(runWakingSpy).toHaveBeenCalledWith(
      'backup.restore',
      expect.any(Function)
    );
    expect(record).toMatchObject({
      operationKey: `restore:${backupId}:/workspace/project`,
      kind: 'backup.restore',
      sandboxLifetimeID: 'lifetime-1',
      runtimeIdentityID: 'runtime-1',
      runtimeIncarnationID: 'incarnation-1',
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

  it('records the supplied restore runtime without marking a new one', async () => {
    const writes: string[] = [];
    const { sandbox } = await createBackupSandbox({
      storageHooks: {
        onPut: (key) => writes.push(key)
      }
    });
    const backupId = crypto.randomUUID();

    await sandbox.restoreBackup({
      id: backupId,
      dir: '/workspace/project'
    });

    expect(writes).not.toContain('currentRuntimeIdentity');
  });

  it('does not retry non-retryable restore interruptions', async () => {
    const { sandbox } = await createBackupSandbox();
    const backupId = crypto.randomUUID();
    const interruption = createNonRetryableInterruptedError(
      backupId,
      '/workspace/project'
    );
    const sandboxWithClient = asSandboxWithClient(sandbox);
    const restoreArchiveSpy = vi
      .spyOn(sandboxWithClient.client.backup, 'restoreArchive')
      .mockRejectedValueOnce(interruption)
      .mockResolvedValueOnce({ success: true, dir: '/workspace/project' });

    const error = await sandbox
      .restoreBackup({ id: backupId, dir: '/workspace/project' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OperationInterruptedError);
    expect((error as OperationInterruptedError).context).toMatchObject({
      operationId: expect.any(String),
      backupId,
      retryable: false
    });
    expect(restoreArchiveSpy).toHaveBeenCalledTimes(1);
  });

  it('records runtime-runner interruption with restore context', async () => {
    const { sandbox, storageMap, runWakingSpy } = await createBackupSandbox();
    const backupId = crypto.randomUUID();
    runWakingSpy.mockRejectedValueOnce(
      new OperationInterruptedError({
        code: ErrorCode.OPERATION_INTERRUPTED,
        message: 'Runtime changed',
        httpStatus: 409,
        context: {
          reason: 'runtime_replaced',
          operation: 'backup.restore',
          admitted: true,
          retryable: false
        },
        timestamp: '2026-06-15T12:00:00.000Z'
      })
    );

    const error = await sandbox
      .restoreBackup({ id: backupId, dir: '/workspace/project' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OperationInterruptedError);
    expect((error as OperationInterruptedError).context).toMatchObject({
      reason: 'runtime_replaced',
      operationId: expect.any(String),
      retryable: true,
      operationKey: `restore:${backupId}:/workspace/project`,
      backupId,
      dir: '/workspace/project',
      phase: 'validating'
    });
    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record.status).toBe('interrupted');
    expect(record.phase).toBe('interrupted');
  });

  it('surfaces transport interruption without replaying restore work', async () => {
    const { sandbox, storageMap } = await createBackupSandbox();
    const backupId = crypto.randomUUID();
    const sandboxWithClient = asSandboxWithClient(sandbox);
    const restoreArchiveSpy = vi
      .spyOn(sandboxWithClient.client.backup, 'restoreArchive')
      .mockRejectedValueOnce(createDisposedRPCError())
      .mockResolvedValueOnce({ success: true, dir: '/workspace/project' });

    await expect(
      sandbox.restoreBackup({ id: backupId, dir: '/workspace/project' })
    ).rejects.toBeInstanceOf(OperationInterruptedError);

    expect(restoreArchiveSpy).toHaveBeenCalledTimes(1);
    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record.status).toBe('interrupted');
    expect(record.phase).toBe('interrupted');
  });

  it('reuses an interrupted operation id when the caller retries restoreBackup with the same backup handle', async () => {
    const { sandbox, storageMap } = await createBackupSandbox();
    const backupId = crypto.randomUUID();

    const sandboxWithClient = asSandboxWithClient(sandbox);
    vi.spyOn(sandboxWithClient.client.backup, 'restoreArchive')
      .mockRejectedValueOnce(createDisposedRPCError())
      .mockResolvedValueOnce({
        success: true,
        dir: '/workspace/project'
      } as never);

    await expect(
      sandbox.restoreBackup({ id: backupId, dir: '/workspace/project' })
    ).rejects.toBeInstanceOf(OperationInterruptedError);

    const interruptedRecord = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(interruptedRecord).toBeDefined();

    await sandbox.restoreBackup({ id: backupId, dir: '/workspace/project' });

    const committedRecord = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(committedRecord.operationId).toBe(interruptedRecord.operationId);
    expect(committedRecord.status).toBe('committed');
  });

  it('surfaces interruption when the supplied restore runtime is no longer active', async () => {
    const { sandbox, storageMap } = await createBackupSandbox();
    const backupId = crypto.randomUUID();
    const sandboxWithClient = asSandboxWithClient(sandbox);
    const restoreArchiveSpy = vi
      .spyOn(sandboxWithClient.client.backup, 'restoreArchive')
      .mockImplementationOnce(async () => {
        storageMap.set('currentRuntimeIdentity', {
          schemaVersion: 1,
          id: 'runtime-1',
          runtimeIncarnationID: 'incarnation-2'
        });
        return { success: true, dir: '/workspace/project' } as never;
      });

    await expect(
      sandbox.restoreBackup({ id: backupId, dir: '/workspace/project' })
    ).rejects.toBeInstanceOf(OperationInterruptedError);

    expect(restoreArchiveSpy).toHaveBeenCalledTimes(1);
    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record.status).toBe('interrupted');
    expect(record.runtimeIncarnationID).toBe('incarnation-1');
  });

  it('surfaces interruption when the sandbox lifetime changes before runtime work starts', async () => {
    const storageMap = new Map<string, StoredValue>();
    const { sandbox } = await createBackupSandbox({
      storageMap,
      storageHooks: {
        onPut: (key) => {
          if (key.startsWith('operations:restore:')) {
            storageMap.set('sandbox:lifetime', {
              id: 'lifetime-2',
              generation: 2,
              createdAt: '2026-06-15T12:01:00.000Z',
              updatedAt: '2026-06-15T12:01:00.000Z'
            });
          }
        }
      }
    });
    const backupId = crypto.randomUUID();
    const sandboxWithClient = asSandboxWithClient(sandbox);
    const restoreArchiveSpy = vi.spyOn(
      sandboxWithClient.client.backup,
      'restoreArchive'
    );

    let thrown: unknown;
    try {
      await sandbox.restoreBackup({ id: backupId, dir: '/workspace/project' });
    } catch (error) {
      thrown = error;
    }

    expect(restoreArchiveSpy).not.toHaveBeenCalled();
    expect(thrown).toBeInstanceOf(OperationInterruptedError);
    const interrupted = thrown as OperationInterruptedError;
    expect(interrupted.context).toMatchObject({
      reason: 'sandbox_lifetime_changed',
      operation: 'backup.restore',
      backupId,
      dir: '/workspace/project',
      phase: 'validating',
      admitted: 'unknown',
      retryable: false
    });

    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record.status).toBe('interrupted');
    expect(record.phase).toBe('interrupted');
    expect(record.error?.retryable).toBe(false);
  });

  it('starts a new restore after a previously committed restore', async () => {
    const backupId = crypto.randomUUID();
    const storageMap = new Map<string, StoredValue>();
    storageMap.set(`operations:restore:${backupId}:/workspace/project`, {
      operationId: 'operation-1',
      operationKey: `restore:${backupId}:/workspace/project`,
      kind: 'backup.restore',
      sandboxLifetimeID: 'lifetime-1' as SandboxLifetimeID,
      phase: 'verified',
      status: 'committed',
      attempt: 1,
      payload: { backupId, dir: '/workspace/project', archiveSize: 42 },
      result: { success: true, id: backupId, dir: '/workspace/project' },
      createdAt: '2026-06-15T12:00:00.000Z',
      updatedAt: '2026-06-15T12:00:00.000Z',
      completedAt: '2026-06-15T12:00:00.000Z'
    } satisfies BackupRestoreOperationRecord);

    const { sandbox } = await createBackupSandbox({ storageMap });
    const sandboxWithClient = asSandboxWithClient(sandbox);
    const restoreArchiveSpy = vi.spyOn(
      sandboxWithClient.client.backup,
      'restoreArchive'
    );

    await expect(
      sandbox.restoreBackup({ id: backupId, dir: '/workspace/project' })
    ).resolves.toEqual({
      success: true,
      id: backupId,
      dir: '/workspace/project'
    });
    expect(restoreArchiveSpy).toHaveBeenCalledTimes(1);
    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record.status).toBe('committed');
    expect(record.operationId).not.toBe('operation-1');
  });

  it('does not retry restore across a sandbox lifetime change', async () => {
    const { sandbox, storageMap } = await createBackupSandbox();
    const backupId = crypto.randomUUID();
    const sandboxWithClient = asSandboxWithClient(sandbox);
    const restoreArchiveSpy = vi
      .spyOn(sandboxWithClient.client.backup, 'restoreArchive')
      .mockImplementationOnce(async () => {
        storageMap.set('sandbox:lifetime', {
          id: 'lifetime-2',
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
      reason: 'sandbox_lifetime_changed',
      operation: 'backup.restore',
      operationId: expect.any(String),
      operationKey: `restore:${backupId}:/workspace/project`,
      idempotencyKey: `restore:${backupId}:/workspace/project`,
      backupId,
      dir: '/workspace/project',
      phase: 'archive_ready',
      admitted: true,
      retryable: false
    });

    const record = storageMap.get(
      `operations:restore:${backupId}:/workspace/project`
    ) as BackupRestoreOperationRecord;
    expect(record.status).toBe('interrupted');
    expect(record.phase).toBe('interrupted');
    expect(record.error?.retryable).toBe(false);
    expect(record.result).toBeUndefined();
  });
});
