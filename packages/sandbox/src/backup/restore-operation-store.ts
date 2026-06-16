import type { RuntimeIdentityID } from '../current-runtime-identity';
import type { SandboxLifetimeID } from '../sandbox-lifetime';

export type BackupRestoreOperationStatus =
  | 'running'
  | 'committed'
  | 'failed'
  | 'interrupted';

export type BackupRestoreOperationPhase =
  | 'validating'
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
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
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
    payload: {
      backupId: params.backupId,
      dir: params.dir
    },
    createdAt: params.now,
    updatedAt: params.now
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
