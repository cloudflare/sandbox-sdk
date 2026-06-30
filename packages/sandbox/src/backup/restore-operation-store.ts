import type { RuntimeIdentityID } from '../current-runtime-identity';
import type { SandboxLifetimeID } from '../sandbox-lifetime';

export type BackupRestoreOperationStatus =
  | 'running'
  | 'committed'
  | 'failed'
  | 'interrupted';

export type BackupRestoreOperationPhase =
  | 'validating'
  | 'runtime_ready'
  | 'archive_ready'
  | 'verified'
  | 'failed'
  | 'interrupted';

export type BackupRestoreOperationError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type BackupRestoreOperationPayload = {
  backupId: string;
  dir: string;
  archiveSize?: number;
};

export type BackupRestoreOperationResult = {
  success: true;
  id: string;
  dir: string;
};

export type BackupRestoreOperationRecord = {
  operationId: string;
  operationKey: string;
  kind: 'backup.restore';
  sandboxLifetimeID: SandboxLifetimeID;
  phase: BackupRestoreOperationPhase;
  status: BackupRestoreOperationStatus;
  runtimeIdentityID?: RuntimeIdentityID;
  payload: BackupRestoreOperationPayload;
  result?: BackupRestoreOperationResult;
  error?: BackupRestoreOperationError;
  /** The 1-based attempt number for this operation record. */
  attempt: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** ISO timestamp of the most recent interruption, if any. */
  lastInterruptedAt?: string;
};

type OperationRecordStorage = Pick<DurableObjectStorage, 'get' | 'put'>;

const OPERATION_STORAGE_PREFIX = 'operations:';

export function backupRestoreOperationKey(
  backupId: string,
  dir: string
): string {
  return `restore:${backupId}:${dir}`;
}

export function createBackupRestoreOperationRecord(params: {
  operationId: string;
  sandboxLifetimeID: SandboxLifetimeID;
  backupId: string;
  dir: string;
  now: string;
}): BackupRestoreOperationRecord {
  return {
    operationId: params.operationId,
    operationKey: backupRestoreOperationKey(params.backupId, params.dir),
    kind: 'backup.restore',
    sandboxLifetimeID: params.sandboxLifetimeID,
    phase: 'validating',
    status: 'running',
    attempt: 1,
    payload: {
      backupId: params.backupId,
      dir: params.dir
    },
    createdAt: params.now,
    updatedAt: params.now
  };
}

/**
 * Produce a next-attempt record that resets phase and status while
 * preserving the operationId so callers can reconcile restore history.
 */
export function nextBackupRestoreAttempt(
  record: BackupRestoreOperationRecord,
  now: string
): BackupRestoreOperationRecord {
  return {
    ...record,
    phase: 'validating',
    status: 'running',
    error: undefined,
    completedAt: undefined,
    updatedAt: now,
    attempt: (record.attempt ?? 0) + 1
  };
}

export class BackupRestoreOperationStore {
  constructor(private readonly storage: OperationRecordStorage) {}

  async get(
    operationKey: string
  ): Promise<BackupRestoreOperationRecord | null> {
    return (
      (await this.storage.get<BackupRestoreOperationRecord>(
        this.storageKey(operationKey)
      )) ?? null
    );
  }

  async getCurrent(
    operationKey: string,
    sandboxLifetimeID: SandboxLifetimeID
  ): Promise<BackupRestoreOperationRecord | null> {
    const record = await this.get(operationKey);
    if (!record || record.sandboxLifetimeID !== sandboxLifetimeID) {
      return null;
    }
    return record;
  }

  async put(record: BackupRestoreOperationRecord): Promise<void> {
    await this.storage.put(this.storageKey(record.operationKey), record);
  }

  storageKey(operationKey: string): string {
    return `${OPERATION_STORAGE_PREFIX}${operationKey}`;
  }
}
