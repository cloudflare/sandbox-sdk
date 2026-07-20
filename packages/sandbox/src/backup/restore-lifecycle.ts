import { RuntimeIdentityInactiveError } from '../current-runtime-identity';
import {
  ErrorCode,
  OperationInterruptedError,
  RPCTransportError
} from '../errors';
import type { RuntimeIdentity, RuntimeIdentityReader } from '../runtime';
import type {
  CurrentSandboxLifetime,
  SandboxLifetime
} from '../sandbox-lifetime';
import { SandboxLifetimeChangedError } from '../sandbox-lifetime';
import type { BackupRestoreFaultInjector } from './restore-fault-injection';
import {
  type BackupRestoreOperationPhase,
  type BackupRestoreOperationRecord,
  type BackupRestoreOperationResult,
  BackupRestoreOperationStore,
  backupRestoreOperationKey,
  createBackupRestoreOperationRecord,
  nextBackupRestoreAttempt
} from './restore-operation-store';

type RestoreLifecycleDeps = {
  storage: DurableObjectStorage;
  runtimeReader: RuntimeIdentityReader;
  currentLifetime: CurrentSandboxLifetime;
  faultInjector: BackupRestoreFaultInjector;
};

export type RestoreLifecycleContext = {
  lifetime: SandboxLifetime;
  runtimeReady: (
    runtime: RuntimeIdentity,
    archiveSize?: number
  ) => Promise<{
    runtime: RuntimeIdentity;
    operation: BackupRestoreOperationRecord;
  }>;
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
    const lifetime = await this.deps.currentLifetime.getOrCreate();
    const operationKey = backupRestoreOperationKey(params.backupId, params.dir);
    const existing = await this.operationRecords.getCurrent(
      operationKey,
      lifetime.id
    );

    // Short-circuit: return the stored result without restoring again.
    if (existing?.status === 'committed' && existing.result) {
      return existing.result;
    }

    const now = new Date().toISOString();
    let operation: BackupRestoreOperationRecord;

    const isRetryable =
      existing !== null &&
      (existing.status === 'interrupted' || existing.status === 'running') &&
      existing.error?.retryable !== false;

    if (isRetryable) {
      // Resume with the same operationId so callers can reconcile the record.
      operation = nextBackupRestoreAttempt(existing, now);
    } else {
      operation = createBackupRestoreOperationRecord({
        operationId: crypto.randomUUID(),
        sandboxLifetimeID: lifetime.id,
        backupId: params.backupId,
        dir: params.dir,
        now
      });
    }
    await this.operationRecords.put(operation);

    return await this.runAttempt(operation, lifetime, params.attempt);
  }

  private async runAttempt(
    operation: BackupRestoreOperationRecord,
    lifetime: SandboxLifetime,
    attempt: (
      context: RestoreLifecycleContext
    ) => Promise<BackupRestoreOperationResult>
  ): Promise<BackupRestoreOperationResult> {
    let currentOperation = operation;
    let runtime: RuntimeIdentity | undefined;

    const context: RestoreLifecycleContext = {
      lifetime,
      runtimeReady: async (admittedRuntime, archiveSize) => {
        try {
          runtime = admittedRuntime;
          await this.assertFences(runtime, lifetime);
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
          runtime,
          archiveSize
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
        const fault = await this.deps.faultInjector.maybeFault(
          'after_archive_ready',
          currentOperation
        );
        if (fault) {
          const message =
            'Backup restore was interrupted before completion could be verified';
          const interrupted = await this.markInterrupted(
            currentOperation,
            message
          );
          throw this.createInterruptedError({
            operation: interrupted,
            reason: fault.reason,
            phase: currentOperation.phase,
            admitted: fault.admitted,
            message
          });
        }
        return { runtime, operation: currentOperation };
      },
      verify: async (result, archiveSize) => {
        if (!runtime) {
          throw new Error(
            'Backup restore verification requires archiveReady()'
          );
        }
        try {
          await this.assertFences(runtime, lifetime);
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
      return await attempt(context);
    } catch (error) {
      if (error instanceof OperationInterruptedError) {
        throw await this.translateOperationInterrupted(error, currentOperation);
      }
      const translated = await this.translateRPCError(error, currentOperation);
      if (translated) {
        throw translated;
      }
      await this.markFailed(currentOperation, error);
      throw error;
    }
  }

  async markRuntimeReady(
    operation: BackupRestoreOperationRecord,
    runtime: RuntimeIdentity,
    archiveSize?: number
  ): Promise<BackupRestoreOperationRecord> {
    const next = {
      ...operation,
      phase: 'runtime_ready' as const,
      runtimeIdentityID: runtime.id,
      runtimeIncarnationID: runtime.runtimeIncarnationID,
      payload: {
        ...operation.payload,
        ...(archiveSize !== undefined && { archiveSize })
      },
      updatedAt: new Date().toISOString()
    };
    await this.operationRecords.put(next);
    return next;
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
      runtimeIncarnationID: runtime.runtimeIncarnationID,
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
    lifetime: SandboxLifetime
  ): Promise<void> {
    await this.deps.runtimeReader.assertActive(runtime);
    await this.deps.currentLifetime.assertCurrent(lifetime);
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
      runtimeIncarnationID: runtime.runtimeIncarnationID,
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
    phase: BackupRestoreOperationPhase,
    admitted: true | 'unknown' = true
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
    const message =
      'Backup restore was interrupted before completion could be verified';
    const interrupted = await this.markInterrupted(
      operation,
      message,
      reason !== 'sandbox_lifetime_changed'
    );
    return this.createInterruptedError({
      operation: interrupted,
      reason,
      phase,
      admitted,
      message
    });
  }

  private async translateOperationInterrupted(
    error: OperationInterruptedError,
    operation: BackupRestoreOperationRecord
  ): Promise<OperationInterruptedError> {
    if (error.context.operationId === operation.operationId) {
      return error;
    }

    const phase = operation.phase;
    const message =
      'Backup restore was interrupted before completion could be verified';
    const retryable = this.isRestoreRetryable(error.context.reason);
    const interrupted = await this.markInterrupted(
      operation,
      message,
      retryable
    );
    return this.createInterruptedError({
      operation: interrupted,
      reason: error.context.reason,
      phase,
      admitted: error.context.admitted,
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
    message: string,
    retryable = true
  ): Promise<BackupRestoreOperationRecord> {
    const now = new Date().toISOString();
    const next = {
      ...operation,
      phase: 'interrupted' as const,
      status: 'interrupted' as const,
      error: {
        code: ErrorCode.OPERATION_INTERRUPTED,
        message,
        retryable
      },
      lastInterruptedAt: now,
      updatedAt: now
    };
    await this.operationRecords.put(next);
    return next;
  }

  private isRestoreRetryable(
    reason: OperationInterruptedError['context']['reason']
  ): boolean {
    return ![
      'sandbox_destroyed',
      'sandbox_lifetime_changed',
      'recovery_exhausted'
    ].includes(reason);
  }

  private createInterruptedError(params: {
    operation: BackupRestoreOperationRecord;
    reason: OperationInterruptedError['context']['reason'];
    phase: BackupRestoreOperationPhase;
    admitted: true | 'unknown';
    message: string;
  }): OperationInterruptedError {
    const retryable = this.isRestoreRetryable(params.reason);
    const suggestion = retryable
      ? 'Retry restoreBackup() with the same backup handle so the SDK can reconcile the restore operation.'
      : 'Start a new restoreBackup() call only if restoring this backup is still desired for the current sandbox.';

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
        retryable
      },
      timestamp: new Date().toISOString(),
      suggestion
    });
  }
}
