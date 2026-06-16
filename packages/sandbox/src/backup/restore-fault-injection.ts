import type { BackupRestoreOperationRecord } from './restore-operation-store';

export type BackupRestoreFaultPhase = 'after_archive_ready';

export type BackupRestoreTestFault = {
  phase: BackupRestoreFaultPhase;
  mode: 'transport_disposed';
  times: number;
};

export type BackupRestoreFaultDecision = {
  reason: 'transport_disposed';
  admitted: 'unknown';
};

export interface BackupRestoreFaultInjector {
  maybeFault(
    phase: BackupRestoreFaultPhase,
    operation: BackupRestoreOperationRecord
  ): Promise<BackupRestoreFaultDecision | null>;
}

const BACKUP_RESTORE_TEST_FAULT_STORAGE_KEY = 'test:backupRestoreFault';

export class StorageBackedBackupRestoreFaultInjector implements BackupRestoreFaultInjector {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly getEnv: () => unknown
  ) {}

  async setFaultForTesting(
    fault: BackupRestoreTestFault | null
  ): Promise<void> {
    const envObj = this.getEnv() as Record<string, unknown>;
    if (envObj.SANDBOX_ENABLE_TEST_HOOKS !== 'true') {
      throw new Error('Sandbox test hooks are not enabled');
    }

    if (fault === null || fault.times <= 0) {
      await this.storage.delete(BACKUP_RESTORE_TEST_FAULT_STORAGE_KEY);
      return;
    }

    await this.storage.put(BACKUP_RESTORE_TEST_FAULT_STORAGE_KEY, fault);
  }

  async maybeFault(
    phase: BackupRestoreFaultPhase,
    _operation: BackupRestoreOperationRecord
  ): Promise<BackupRestoreFaultDecision | null> {
    const envObj = this.getEnv() as Record<string, unknown>;
    if (envObj.SANDBOX_ENABLE_TEST_HOOKS !== 'true') {
      return null;
    }

    const fault =
      (await this.storage.get<BackupRestoreTestFault>(
        BACKUP_RESTORE_TEST_FAULT_STORAGE_KEY
      )) ?? null;
    if (!fault || fault.phase !== phase || fault.times <= 0) {
      return null;
    }

    const nextTimes = fault.times - 1;
    if (nextTimes > 0) {
      await this.storage.put(BACKUP_RESTORE_TEST_FAULT_STORAGE_KEY, {
        ...fault,
        times: nextTimes
      });
    } else {
      await this.storage.delete(BACKUP_RESTORE_TEST_FAULT_STORAGE_KEY);
    }

    return {
      reason: fault.mode,
      admitted: 'unknown'
    };
  }
}
