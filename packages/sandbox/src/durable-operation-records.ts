import type { SandboxIncarnationID } from './sandbox-incarnation';

export type OperationStatus =
  | 'running'
  | 'committed'
  | 'failed'
  | 'interrupted'
  | 'cleaning_up';

export type OperationErrorRecord = {
  code: string;
  message: string;
  retryable: boolean;
};

export type OperationRecord<
  TKind extends string = string,
  TPhase extends string = string,
  TPayload extends object = Record<string, unknown>,
  TResult extends object = Record<string, unknown>
> = {
  operationId: string;
  operationKey: string;
  kind: TKind;
  incarnationId: SandboxIncarnationID;
  phase: TPhase;
  status: OperationStatus;
  runtimeIdentityID?: string;
  placementId?: string | null;
  payload: TPayload;
  result?: TResult;
  error?: OperationErrorRecord;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  expiresAt?: string;
};

export type BackupRestoreOperationPhase =
  | 'validating'
  | 'archive_ready'
  | 'preparing_restore'
  | 'restore_prepared'
  | 'commit_started'
  | 'committed'
  | 'verified'
  | 'cleaning_up'
  | 'failed'
  | 'interrupted';

export type BackupRestoreOperationPayload = {
  backupId: string;
  dir: string;
  archiveSize?: number;
  restoreToken?: string;
};

export type BackupRestoreOperationResult = {
  success: true;
  id: string;
  dir: string;
};

export type BackupRestoreOperationRecord = OperationRecord<
  'backup.restore',
  BackupRestoreOperationPhase,
  BackupRestoreOperationPayload,
  BackupRestoreOperationResult
>;

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
  incarnationId: SandboxIncarnationID;
  backupId: string;
  dir: string;
  phase: BackupRestoreOperationPhase;
  status: OperationStatus;
  now: string;
  archiveSize?: number;
  restoreToken?: string;
}): BackupRestoreOperationRecord {
  const payload: BackupRestoreOperationPayload = {
    backupId: params.backupId,
    dir: params.dir,
    ...(params.archiveSize !== undefined && {
      archiveSize: params.archiveSize
    }),
    ...(params.restoreToken !== undefined && {
      restoreToken: params.restoreToken
    })
  };

  return {
    operationId: params.operationId,
    operationKey: backupRestoreOperationKey(params.backupId, params.dir),
    kind: 'backup.restore',
    incarnationId: params.incarnationId,
    phase: params.phase,
    status: params.status,
    payload,
    createdAt: params.now,
    updatedAt: params.now
  };
}

export class DurableOperationRecords {
  constructor(private readonly storage: OperationRecordStorage) {}

  async get<
    TKind extends string,
    TPhase extends string,
    TPayload extends object,
    TResult extends object
  >(
    operationKey: string
  ): Promise<OperationRecord<TKind, TPhase, TPayload, TResult> | null> {
    return (
      (await this.storage.get<
        OperationRecord<TKind, TPhase, TPayload, TResult>
      >(this.storageKey(operationKey))) ?? null
    );
  }

  async getCurrent<
    TKind extends string,
    TPhase extends string,
    TPayload extends object,
    TResult extends object
  >(
    operationKey: string,
    incarnationId: SandboxIncarnationID
  ): Promise<OperationRecord<TKind, TPhase, TPayload, TResult> | null> {
    const record = await this.get<TKind, TPhase, TPayload, TResult>(
      operationKey
    );
    if (!record || record.incarnationId !== incarnationId) {
      return null;
    }
    return record;
  }

  async put(record: OperationRecord): Promise<void> {
    await this.storage.put(this.storageKey(record.operationKey), record);
  }

  storageKey(operationKey: string): string {
    return `${OPERATION_STORAGE_PREFIX}${operationKey}`;
  }
}
