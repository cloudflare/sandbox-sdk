import { describe, expect, it, vi } from 'vitest';
import {
  type BackupRestoreOperationRecord,
  BackupRestoreOperationStore,
  backupRestoreOperationKey,
  createBackupRestoreOperationRecord
} from '../src/backup/restore-operation-store';
import type { SandboxIncarnationID } from '../src/sandbox-incarnation';

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
    incarnationId: 'incarnation-1' as SandboxIncarnationID,
    phase: 'validating',
    status: 'running',
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
      incarnationId: 'incarnation-1' as SandboxIncarnationID,
      backupId: 'backup-1',
      dir: '/workspace/project',
      now: '2026-06-15T12:00:00.000Z'
    });

    expect(record).toEqual({
      operationId: 'op-1',
      operationKey: 'restore:backup-1:/workspace/project',
      kind: 'backup.restore',
      incarnationId: 'incarnation-1',
      phase: 'validating',
      status: 'running',
      payload: {
        backupId: 'backup-1',
        dir: '/workspace/project'
      },
      createdAt: '2026-06-15T12:00:00.000Z',
      updatedAt: '2026-06-15T12:00:00.000Z'
    });
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

  it('returns the current-incarnation record for an operation key', async () => {
    const record = makeBackupRestoreRecord();
    const storage = createStorage(
      new Map([['operations:restore:backup-1:/workspace/project', record]])
    );
    const operations = new BackupRestoreOperationStore(storage);

    const current = await operations.getCurrent(
      record.operationKey,
      'incarnation-1' as SandboxIncarnationID
    );

    expect(current).toEqual(record);
  });

  it('ignores operation records from a stale sandbox incarnation', async () => {
    const record = makeBackupRestoreRecord({
      incarnationId: 'old-incarnation' as SandboxIncarnationID
    });
    const storage = createStorage(
      new Map([['operations:restore:backup-1:/workspace/project', record]])
    );
    const operations = new BackupRestoreOperationStore(storage);

    const current = await operations.getCurrent(
      record.operationKey,
      'new-incarnation' as SandboxIncarnationID
    );

    expect(current).toBeNull();
  });

  it('overwrites a stale-incarnation record with the current-incarnation record', async () => {
    const map = new Map<string, unknown>([
      [
        'operations:restore:backup-1:/workspace/project',
        makeBackupRestoreRecord({
          operationId: 'old-op',
          incarnationId: 'old-incarnation' as SandboxIncarnationID
        })
      ]
    ]);
    const storage = createStorage(map);
    const operations = new BackupRestoreOperationStore(storage);
    const replacement = makeBackupRestoreRecord({
      operationId: 'new-op',
      incarnationId: 'new-incarnation' as SandboxIncarnationID
    });

    await operations.put(replacement);

    expect(map.get('operations:restore:backup-1:/workspace/project')).toEqual(
      replacement
    );
  });
});
