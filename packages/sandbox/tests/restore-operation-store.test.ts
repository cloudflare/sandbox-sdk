import { describe, expect, it, vi } from 'vitest';
import {
  type BackupRestoreOperationRecord,
  BackupRestoreOperationStore,
  backupRestoreOperationKey,
  createBackupRestoreOperationRecord,
  nextBackupRestoreAttempt
} from '../src/backup/restore-operation-store';
import type { SandboxLifetimeID } from '../src/sandbox-lifetime';

function createStorage(initial = new Map<string, unknown>()) {
  return {
    get: vi.fn(async (key: string) => initial.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      initial.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      initial.delete(key);
    })
  } as unknown as DurableObjectState['storage'];
}

function makeBackupRestoreRecord(
  overrides: Partial<BackupRestoreOperationRecord> = {}
): BackupRestoreOperationRecord {
  return {
    operationId: 'op-1',
    operationKey: backupRestoreOperationKey('backup-1', '/workspace/project'),
    kind: 'backup.restore',
    sandboxLifetimeID: 'lifetime-1' as SandboxLifetimeID,
    phase: 'validating',
    status: 'running',
    attempt: 1,
    payload: {
      backupId: 'backup-1',
      dir: '/workspace/project'
    },
    createdAt: '2026-06-15T12:00:00.000Z',
    updatedAt: '2026-06-15T12:00:00.000Z',
    ...overrides
  };
}

describe('BackupRestoreOperationStore', () => {
  it('derives a deterministic backup restore operation key from backup id and target directory', () => {
    expect(backupRestoreOperationKey('backup-1', '/workspace/project')).toBe(
      'restore:backup-1:/workspace/project'
    );
  });

  it('creates a backup restore operation record with the backup payload', () => {
    const record = createBackupRestoreOperationRecord({
      operationId: 'op-1',
      sandboxLifetimeID: 'lifetime-1' as SandboxLifetimeID,
      backupId: 'backup-1',
      dir: '/workspace/project',
      now: '2026-06-15T12:00:00.000Z'
    });

    expect(record).toEqual({
      operationId: 'op-1',
      operationKey: 'restore:backup-1:/workspace/project',
      kind: 'backup.restore',
      sandboxLifetimeID: 'lifetime-1',
      phase: 'validating',
      status: 'running',
      attempt: 1,
      payload: {
        backupId: 'backup-1',
        dir: '/workspace/project'
      },
      createdAt: '2026-06-15T12:00:00.000Z',
      updatedAt: '2026-06-15T12:00:00.000Z'
    });
  });

  it('nextBackupRestoreAttempt resets phase/status/error while preserving operationId and incrementing attempt', () => {
    const record = makeBackupRestoreRecord({
      phase: 'interrupted',
      status: 'interrupted',
      attempt: 2,
      error: {
        code: 'OPERATION_INTERRUPTED',
        message: 'Transport disposed',
        retryable: true
      },
      lastInterruptedAt: '2026-06-15T12:00:30.000Z'
    });

    const next = nextBackupRestoreAttempt(record, '2026-06-15T12:01:00.000Z');

    expect(next).toEqual({
      ...record,
      phase: 'validating',
      status: 'running',
      error: undefined,
      completedAt: undefined,
      updatedAt: '2026-06-15T12:01:00.000Z',
      attempt: 3
    });
    // operationId and operationKey must be preserved
    expect(next.operationId).toBe(record.operationId);
    expect(next.operationKey).toBe(record.operationKey);
  });

  it('nextBackupRestoreAttempt handles legacy records written before the attempt field was added', () => {
    // Simulate a durable record from a pre-deploy DO instance that has no `attempt` field.
    const legacy = makeBackupRestoreRecord() as unknown as Omit<
      BackupRestoreOperationRecord,
      'attempt'
    > & { attempt: undefined };
    delete (legacy as Partial<BackupRestoreOperationRecord>).attempt;

    const next = nextBackupRestoreAttempt(
      legacy as unknown as BackupRestoreOperationRecord,
      '2026-06-15T12:01:00.000Z'
    );

    expect(next.attempt).toBe(1);
    expect(next.operationId).toBe(legacy.operationId);
  });

  it('stores operation records under operations-prefixed keys', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const operations = new BackupRestoreOperationStore(storage);
    const record = makeBackupRestoreRecord();

    await operations.put(record);

    expect(map.get('operations:restore:backup-1:/workspace/project')).toEqual(
      record
    );
  });

  it('returns the current-lifetime record for an operation key', async () => {
    const record = makeBackupRestoreRecord();
    const storage = createStorage(
      new Map([['operations:restore:backup-1:/workspace/project', record]])
    );
    const operations = new BackupRestoreOperationStore(storage);

    const current = await operations.getCurrent(
      record.operationKey,
      'lifetime-1' as SandboxLifetimeID
    );

    expect(current).toEqual(record);
  });

  it('ignores operation records from a stale sandbox lifetime', async () => {
    const record = makeBackupRestoreRecord({
      sandboxLifetimeID: 'old-lifetime' as SandboxLifetimeID
    });
    const storage = createStorage(
      new Map([['operations:restore:backup-1:/workspace/project', record]])
    );
    const operations = new BackupRestoreOperationStore(storage);

    const current = await operations.getCurrent(
      record.operationKey,
      'new-lifetime' as SandboxLifetimeID
    );

    expect(current).toBeNull();
  });
});
