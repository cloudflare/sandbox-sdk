import type { createLogger } from '@repo/shared';
import type {
  CurrentRuntimeIdentity,
  RuntimeIdentity
} from '../current-runtime-identity';
import { RuntimeIdentityInactiveError } from '../current-runtime-identity';
import {
  ErrorCode,
  OperationInterruptedError,
  RPCTransportError
} from '../errors';
import type {
  CurrentSandboxIncarnation,
  SandboxIncarnation
} from '../sandbox-incarnation';
import { SandboxIncarnationChangedError } from '../sandbox-incarnation';
import {
  BACKUP_RESTORE_MAX_RECOVERY_ATTEMPTS,
  BACKUP_RESTORE_TEST_FAULT_STORAGE_KEY
} from './constants';
import {
  type BackupRestoreOperationPhase,
  type BackupRestoreOperationRecord,
  type BackupRestoreOperationResult,
  BackupRestoreOperationStore,
  createBackupRestoreOperationRecord
} from './restore-operation-store';

export type BackupRestoreTestFault = {
  phase: 'after_archive_ready';
  mode: 'transport_disposed';
  times: number;
};

type RestoreLifecycleDeps = {
  storage: DurableObjectStorage;
  getEnv: () => unknown;
  logger: ReturnType<typeof createLogger>;
  currentRuntime: CurrentRuntimeIdentity;
  currentIncarnation: CurrentSandboxIncarnation;
};

export type RestoreLifecycleContext = {
  incarnation: SandboxIncarnation;
  archiveReady: (archiveSize?: number) => Promise<{
    runtime: RuntimeIdentity;
    operation: BackupRestoreOperationRecord;
  }>;
  verify: (
    result: BackupRestoreOperationResult,
    archiveSize?: number
  ) => Promise<BackupRestoreOperationRecord>;
};

export class RestoreLifecycleRunner {
  private readonly operationRecords: BackupRestoreOperationStore;

  constructor(private readonly deps: RestoreLifecycleDeps) {
    this.operationRecords = new BackupRestoreOperationStore(deps.storage);
  }

  async execute(params: {
    backupId: string;
    dir: string;
    attempt: (
      context: RestoreLifecycleContext
    ) => Promise<BackupRestoreOperationResult>;
  }): Promise<BackupRestoreOperationResult> {
    return await this.runWithRecovery(async () => {
      const { incarnation, operation } = await this.startOperation(
        params.backupId,
        params.dir
      );
      let currentOperation = operation;
      let runtime: RuntimeIdentity | undefined;

      const context: RestoreLifecycleContext = {
        incarnation,
        archiveReady: async (archiveSize) => {
          runtime = await this.captureRuntime();
          await this.deps.currentIncarnation.assertCurrent(incarnation);
          currentOperation = await this.markArchiveReady(
            currentOperation,
            runtime,
            archiveSize
          );
          await this.maybeInjectFaultForTesting(
            'after_archive_ready',
            currentOperation
          );
          return { runtime, operation: currentOperation };
        },
        verify: async (result, archiveSize) => {
          if (!runtime) {
            throw new Error(
              'Backup restore verification requires archiveReady()'
            );
          }
          try {
            await this.assertFences(runtime, incarnation);
          } catch (error) {
            const interrupted = await this.translateFenceError(
              error,
              currentOperation,
              'archive_ready'
            );
            throw interrupted ?? error;
          }
          currentOperation = await this.markVerified(
            currentOperation,
            runtime,
            result,
            archiveSize
          );
          return currentOperation;
        }
      };

      try {
        return await params.attempt(context);
      } catch (error) {
        const translated = await this.translateRPCError(
          error,
          currentOperation
        );
        if (translated) {
          throw translated;
        }
        if (!(error instanceof OperationInterruptedError)) {
          await this.markFailed(currentOperation, error);
        }
        throw error;
      }
    });
  }

  private async runWithRecovery<T>(
    restoreAttempt: () => Promise<T>
  ): Promise<T> {
    let recoveryAttempts = 0;

    while (true) {
      try {
        return await restoreAttempt();
      } catch (error) {
        if (!(error instanceof OperationInterruptedError)) {
          throw error;
        }

        if (error.context.reason === 'incarnation_changed') {
          throw error;
        }

        if (recoveryAttempts >= BACKUP_RESTORE_MAX_RECOVERY_ATTEMPTS) {
          throw this.createRecoveryExhaustedError(error, recoveryAttempts);
        }

        recoveryAttempts++;
      }
    }
  }

  async startOperation(
    backupId: string,
    dir: string
  ): Promise<{
    incarnation: SandboxIncarnation;
    operation: BackupRestoreOperationRecord;
  }> {
    const incarnation = await this.deps.currentIncarnation.getOrCreate();
    const operation = createBackupRestoreOperationRecord({
      operationId: crypto.randomUUID(),
      incarnationId: incarnation.id,
      backupId,
      dir,
      now: new Date().toISOString()
    });
    await this.operationRecords.put(operation);
    return { incarnation, operation };
  }

  async captureRuntime(): Promise<RuntimeIdentity> {
    let runtime = await this.deps.currentRuntime.get();
    runtime = runtime ?? (await this.deps.currentRuntime.markStarted());
    await this.deps.currentRuntime.assertActive(runtime);
    return runtime;
  }

  async markArchiveReady(
    operation: BackupRestoreOperationRecord,
    runtime: RuntimeIdentity,
    archiveSize?: number
  ): Promise<BackupRestoreOperationRecord> {
    const next = {
      ...operation,
      phase: 'archive_ready' as const,
      runtimeIdentityID: runtime.id,
      payload: {
        ...operation.payload,
        ...(archiveSize !== undefined && { archiveSize })
      },
      updatedAt: new Date().toISOString()
    };
    await this.operationRecords.put(next);
    return next;
  }

  async assertFences(
    runtime: RuntimeIdentity,
    incarnation: SandboxIncarnation
  ): Promise<void> {
    await this.deps.currentRuntime.assertActive(runtime);
    await this.deps.currentIncarnation.assertCurrent(incarnation);
  }

  async markVerified(
    operation: BackupRestoreOperationRecord,
    runtime: RuntimeIdentity,
    result: BackupRestoreOperationResult,
    archiveSize?: number
  ): Promise<BackupRestoreOperationRecord> {
    const completedAt = new Date().toISOString();
    const next = {
      ...operation,
      phase: 'verified' as const,
      status: 'committed' as const,
      runtimeIdentityID: runtime.id,
      payload: {
        ...operation.payload,
        ...(archiveSize !== undefined && { archiveSize })
      },
      result,
      completedAt,
      updatedAt: completedAt
    };
    await this.operationRecords.put(next);
    return next;
  }

  async translateFenceError(
    error: unknown,
    operation: BackupRestoreOperationRecord,
    phase: BackupRestoreOperationPhase
  ): Promise<OperationInterruptedError | null> {
    if (
      !(
        error instanceof RuntimeIdentityInactiveError ||
        error instanceof SandboxIncarnationChangedError
      )
    ) {
      return null;
    }

    const reason =
      error instanceof RuntimeIdentityInactiveError
        ? 'runtime_replaced'
        : 'incarnation_changed';
    const message =
      'Backup restore was interrupted before completion could be verified';
    const interrupted = await this.markInterrupted(operation, message);
    return this.createInterruptedError({
      operation: interrupted,
      reason,
      phase,
      admitted: true,
      message
    });
  }

  async translateRPCError(
    error: unknown,
    operation: BackupRestoreOperationRecord
  ): Promise<OperationInterruptedError | null> {
    if (!(error instanceof RPCTransportError)) {
      return null;
    }

    const message =
      'Backup restore was interrupted before completion could be verified';
    const interruptedPhase = operation.phase;
    const interrupted = await this.markInterrupted(operation, message);
    return this.createInterruptedError({
      operation: interrupted,
      reason: 'transport_disposed',
      phase: interruptedPhase,
      admitted: 'unknown',
      message
    });
  }

  async setFaultForTesting(
    fault: BackupRestoreTestFault | null
  ): Promise<void> {
    const envObj = this.deps.getEnv() as Record<string, unknown>;
    if (envObj.SANDBOX_ENABLE_TEST_HOOKS !== 'true') {
      throw new Error('Sandbox test hooks are not enabled');
    }

    if (fault === null || fault.times <= 0) {
      await this.deps.storage.delete(BACKUP_RESTORE_TEST_FAULT_STORAGE_KEY);
      return;
    }

    await this.deps.storage.put(BACKUP_RESTORE_TEST_FAULT_STORAGE_KEY, fault);
  }

  async maybeInjectFaultForTesting(
    phase: BackupRestoreTestFault['phase'],
    operation: BackupRestoreOperationRecord
  ): Promise<void> {
    const envObj = this.deps.getEnv() as Record<string, unknown>;
    if (envObj.SANDBOX_ENABLE_TEST_HOOKS !== 'true') {
      return;
    }

    const fault =
      (await this.deps.storage.get<BackupRestoreTestFault>(
        BACKUP_RESTORE_TEST_FAULT_STORAGE_KEY
      )) ?? null;
    if (!fault || fault.phase !== phase || fault.times <= 0) {
      return;
    }

    const nextTimes = fault.times - 1;
    if (nextTimes > 0) {
      await this.deps.storage.put(BACKUP_RESTORE_TEST_FAULT_STORAGE_KEY, {
        ...fault,
        times: nextTimes
      });
    } else {
      await this.deps.storage.delete(BACKUP_RESTORE_TEST_FAULT_STORAGE_KEY);
    }

    if (fault.mode === 'transport_disposed') {
      const message =
        'Backup restore was interrupted before completion could be verified';
      const interrupted = await this.markInterrupted(operation, message);
      throw this.createInterruptedError({
        operation: interrupted,
        reason: 'transport_disposed',
        phase: operation.phase,
        admitted: 'unknown',
        message
      });
    }
  }

  private async markFailed(
    operation: BackupRestoreOperationRecord,
    error: unknown
  ): Promise<BackupRestoreOperationRecord> {
    const completedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'UNKNOWN';
    const next = {
      ...operation,
      phase: 'failed' as const,
      status: 'failed' as const,
      error: {
        code,
        message,
        retryable: false
      },
      completedAt,
      updatedAt: completedAt
    };
    await this.operationRecords.put(next);
    return next;
  }

  private async markInterrupted(
    operation: BackupRestoreOperationRecord,
    message: string
  ): Promise<BackupRestoreOperationRecord> {
    const next = {
      ...operation,
      phase: 'interrupted' as const,
      status: 'interrupted' as const,
      error: {
        code: ErrorCode.OPERATION_INTERRUPTED,
        message,
        retryable: true
      },
      updatedAt: new Date().toISOString()
    };
    await this.operationRecords.put(next);
    return next;
  }

  private createInterruptedError(params: {
    operation: BackupRestoreOperationRecord;
    reason: 'runtime_replaced' | 'incarnation_changed' | 'transport_disposed';
    phase: BackupRestoreOperationPhase;
    admitted: true | 'unknown';
    message: string;
  }): OperationInterruptedError {
    return new OperationInterruptedError({
      message: params.message,
      code: ErrorCode.OPERATION_INTERRUPTED,
      httpStatus: 409,
      context: {
        reason: params.reason,
        operation: 'backup.restore',
        operationId: params.operation.operationId,
        operationKey: params.operation.operationKey,
        idempotencyKey: params.operation.operationKey,
        backupId: params.operation.payload.backupId,
        dir: params.operation.payload.dir,
        phase: params.phase,
        admitted: params.admitted,
        retryable: true
      },
      timestamp: new Date().toISOString(),
      suggestion:
        'Retry restoreBackup() with the same backup handle so the SDK can reconcile the restore operation.'
    });
  }

  private createRecoveryExhaustedError(
    error: OperationInterruptedError,
    recoveryAttempts: number
  ): OperationInterruptedError {
    const context = error.context;
    return new OperationInterruptedError({
      message: 'Backup restore recovery attempts were exhausted',
      code: ErrorCode.OPERATION_INTERRUPTED,
      httpStatus: 409,
      context: {
        reason: 'recovery_exhausted',
        operation: context.operation,
        operationId: context.operationId,
        operationKey: context.operationKey,
        idempotencyKey: context.idempotencyKey,
        backupId: context.backupId,
        dir: context.dir,
        phase: 'interrupted',
        admitted: context.admitted,
        retryable: true,
        recoveryAttempts,
        maxRecoveryAttempts: BACKUP_RESTORE_MAX_RECOVERY_ATTEMPTS
      },
      timestamp: new Date().toISOString(),
      suggestion:
        'Retry restoreBackup() with the same backup handle so the SDK can reconcile the restore operation.'
    });
  }
}
