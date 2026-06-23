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
  CurrentSandboxLifetime,
  SandboxLifetime
} from '../sandbox-lifetime';
import { SandboxLifetimeChangedError } from '../sandbox-lifetime';
import {
  type BackupRestoreOperationPhase,
  type BackupRestoreOperationRecord,
  type BackupRestoreOperationResult,
  BackupRestoreOperationStore,
  createBackupRestoreOperationRecord
} from './restore-operation-store';

const BACKUP_RESTORE_MAX_RECOVERY_ATTEMPTS = 2;

type RestoreLifecycleDeps = {
  storage: DurableObjectStorage;
  currentRuntime: CurrentRuntimeIdentity;
  currentLifetime: CurrentSandboxLifetime;
};

export type RestoreLifecycleContext = {
  lifetime: SandboxLifetime;
  runtimeReady: () => Promise<{
    runtime: RuntimeIdentity;
    operation: BackupRestoreOperationRecord;
  }>;
  archiveReady: (archiveSize?: number) => Promise<{
    runtime: RuntimeIdentity;
    operation: BackupRestoreOperationRecord;
  }>;
  verify: (
    result: BackupRestoreOperationResult
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
      const { lifetime, operation } = await this.startOperation(
        params.backupId,
        params.dir
      );
      let currentOperation = operation;
      let runtime: RuntimeIdentity | undefined;

      const context: RestoreLifecycleContext = {
        lifetime,
        runtimeReady: async () => {
          try {
            runtime = await this.captureRuntime();
            await this.deps.currentLifetime.assertCurrent(lifetime);
          } catch (error) {
            const interrupted = await this.translateFenceError(
              error,
              currentOperation,
              'validating',
              'unknown'
            );
            throw interrupted ?? error;
          }

          currentOperation = await this.markRuntimeReady(
            currentOperation,
            runtime
          );
          return { runtime, operation: currentOperation };
        },
        archiveReady: async (archiveSize) => {
          if (!runtime) {
            throw new Error(
              'Backup restore archiveReady requires runtimeReady()'
            );
          }

          try {
            await this.assertFences(runtime, lifetime);
          } catch (error) {
            const interrupted = await this.translateFenceError(
              error,
              currentOperation,
              currentOperation.phase,
              true
            );
            throw interrupted ?? error;
          }

          currentOperation = await this.markArchiveReady(
            currentOperation,
            runtime,
            archiveSize
          );
          return { runtime, operation: currentOperation };
        },
        verify: async (result) => {
          if (!runtime) {
            throw new Error(
              'Backup restore verification requires runtimeReady()'
            );
          }

          try {
            await this.assertFences(runtime, lifetime);
          } catch (error) {
            const interrupted = await this.translateFenceError(
              error,
              currentOperation,
              'archive_ready',
              true
            );
            throw interrupted ?? error;
          }

          currentOperation = await this.markVerified(
            currentOperation,
            runtime,
            result
          );
          return currentOperation;
        }
      };

      try {
        return await params.attempt(context);
      } catch (error) {
        const translatedRPC = await this.translateRPCError(
          error,
          currentOperation
        );
        if (translatedRPC) {
          throw translatedRPC;
        }

        const translatedFence = await this.translateFenceError(
          error,
          currentOperation,
          currentOperation.phase,
          'unknown'
        );
        if (translatedFence) {
          throw translatedFence;
        }

        if (!(error instanceof OperationInterruptedError)) {
          await this.markFailed(currentOperation, error);
        }
        throw error;
      }
    });
  }

  private async runWithRecovery<T>(attempt: () => Promise<T>): Promise<T> {
    let recoveryAttempts = 0;

    while (true) {
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof OperationInterruptedError)) {
          throw error;
        }

        if (!error.context.retryable) {
          throw error;
        }

        if (recoveryAttempts >= BACKUP_RESTORE_MAX_RECOVERY_ATTEMPTS) {
          throw this.createRecoveryExhaustedError(error, recoveryAttempts);
        }

        recoveryAttempts++;
      }
    }
  }

  private async startOperation(
    backupId: string,
    dir: string
  ): Promise<{
    lifetime: SandboxLifetime;
    operation: BackupRestoreOperationRecord;
  }> {
    const lifetime = await this.deps.currentLifetime.getOrCreate();
    const operation = createBackupRestoreOperationRecord({
      sandboxLifetimeID: lifetime.id,
      backupId,
      dir,
      now: new Date().toISOString()
    });
    await this.operationRecords.put(operation);
    return { lifetime, operation };
  }

  private async captureRuntime(): Promise<RuntimeIdentity> {
    const runtime =
      (await this.deps.currentRuntime.get()) ??
      (await this.deps.currentRuntime.markStarted());
    await this.deps.currentRuntime.assertActive(runtime);
    return runtime;
  }

  private async assertFences(
    runtime: RuntimeIdentity,
    lifetime: SandboxLifetime
  ): Promise<void> {
    await this.deps.currentRuntime.assertActive(runtime);
    await this.deps.currentLifetime.assertCurrent(lifetime);
  }

  private async markRuntimeReady(
    operation: BackupRestoreOperationRecord,
    runtime: RuntimeIdentity
  ): Promise<BackupRestoreOperationRecord> {
    const next: BackupRestoreOperationRecord = {
      ...operation,
      phase: 'runtime_ready',
      runtimeIdentityID: runtime.id,
      updatedAt: new Date().toISOString()
    };
    await this.operationRecords.put(next);
    return next;
  }

  private async markArchiveReady(
    operation: BackupRestoreOperationRecord,
    runtime: RuntimeIdentity,
    archiveSize?: number
  ): Promise<BackupRestoreOperationRecord> {
    const next: BackupRestoreOperationRecord = {
      ...operation,
      phase: 'archive_ready',
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

  private async markVerified(
    operation: BackupRestoreOperationRecord,
    runtime: RuntimeIdentity,
    result: BackupRestoreOperationResult
  ): Promise<BackupRestoreOperationRecord> {
    const completedAt = new Date().toISOString();
    const next: BackupRestoreOperationRecord = {
      ...operation,
      phase: 'verified',
      status: 'committed',
      runtimeIdentityID: runtime.id,
      result,
      completedAt,
      updatedAt: completedAt
    };
    await this.operationRecords.put(next);
    return next;
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
    const next: BackupRestoreOperationRecord = {
      ...operation,
      phase: 'failed',
      status: 'failed',
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
    message: string,
    retryable: boolean
  ): Promise<BackupRestoreOperationRecord> {
    const next: BackupRestoreOperationRecord = {
      ...operation,
      phase: 'interrupted',
      status: 'interrupted',
      error: {
        code: ErrorCode.OPERATION_INTERRUPTED,
        message,
        retryable
      },
      updatedAt: new Date().toISOString()
    };
    await this.operationRecords.put(next);
    return next;
  }

  private async translateFenceError(
    error: unknown,
    operation: BackupRestoreOperationRecord,
    phase: BackupRestoreOperationPhase,
    admitted: boolean | 'unknown'
  ): Promise<OperationInterruptedError | null> {
    if (
      !(
        error instanceof RuntimeIdentityInactiveError ||
        error instanceof SandboxLifetimeChangedError
      )
    ) {
      return null;
    }

    const reason =
      error instanceof RuntimeIdentityInactiveError
        ? 'runtime_replaced'
        : 'sandbox_lifetime_changed';
    const retryable = reason !== 'sandbox_lifetime_changed';
    const message =
      'Backup restore was interrupted before completion could be verified';
    const interrupted = await this.markInterrupted(
      operation,
      message,
      retryable
    );
    return this.createInterruptedError({
      reason,
      phase,
      admitted,
      retryable,
      message,
      operation: interrupted
    });
  }

  private async translateRPCError(
    error: unknown,
    operation: BackupRestoreOperationRecord
  ): Promise<OperationInterruptedError | null> {
    if (!(error instanceof RPCTransportError)) {
      return null;
    }

    const message =
      'Backup restore was interrupted before completion could be verified';
    const interruptedPhase = operation.phase;
    const interrupted = await this.markInterrupted(operation, message, true);
    return this.createInterruptedError({
      reason: 'transport_disposed',
      phase: interruptedPhase,
      admitted: 'unknown',
      retryable: true,
      message,
      operation: interrupted
    });
  }

  private createInterruptedError(params: {
    reason:
      | 'runtime_replaced'
      | 'transport_disposed'
      | 'sandbox_lifetime_changed';
    phase: BackupRestoreOperationPhase;
    admitted: boolean | 'unknown';
    retryable: boolean;
    message: string;
    operation: BackupRestoreOperationRecord;
  }): OperationInterruptedError {
    return new OperationInterruptedError({
      message: params.message,
      code: ErrorCode.OPERATION_INTERRUPTED,
      httpStatus: 409,
      context: {
        reason: params.reason,
        operation: 'backup.restore',
        phase: params.phase,
        admitted: params.admitted,
        retryable: params.retryable
      },
      timestamp: new Date().toISOString(),
      suggestion: this.suggestionFor(params.retryable)
    });
  }

  private createRecoveryExhaustedError(
    error: OperationInterruptedError,
    recoveryAttempts: number
  ): OperationInterruptedError {
    return new OperationInterruptedError({
      message: 'Backup restore recovery attempts were exhausted',
      code: ErrorCode.OPERATION_INTERRUPTED,
      httpStatus: 409,
      context: {
        reason: 'recovery_exhausted',
        operation: error.context.operation,
        phase: 'interrupted',
        admitted: error.context.admitted,
        retryable: false,
        recoveryAttempts,
        maxRecoveryAttempts: BACKUP_RESTORE_MAX_RECOVERY_ATTEMPTS
      },
      timestamp: new Date().toISOString(),
      suggestion: this.suggestionFor(false)
    });
  }

  private suggestionFor(retryable: boolean): string {
    return retryable
      ? 'Retry restoreBackup() with the same backup handle so the SDK can reconcile the restore operation.'
      : 'Start a new restoreBackup() call only if restoring this backup is still desired for the current sandbox.';
  }
}
