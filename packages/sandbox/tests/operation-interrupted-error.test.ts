import { describe, expect, it } from 'vitest';
import {
  createErrorFromResponse,
  ErrorCode,
  OperationInterruptedError
} from '../src/errors';

describe('OperationInterruptedError', () => {
  it('translates OPERATION_INTERRUPTED into a typed public-safe SDK error', () => {
    const error = createErrorFromResponse({
      code: ErrorCode.OPERATION_INTERRUPTED,
      message:
        'Backup restore was interrupted before completion could be verified',
      httpStatus: 409,
      context: {
        reason: 'recovery_exhausted',
        operation: 'backup.restore',
        operationId: 'restore-op-1',
        operationKey: 'restore:backup-1:/workspace/project',
        idempotencyKey: 'restore:backup-1:/workspace/project',
        backupId: 'backup-1',
        dir: '/workspace/project',
        phase: 'restore_prepared',
        admitted: true,
        retryable: true,
        recoveryAttempts: 2,
        maxRecoveryAttempts: 2
      },
      timestamp: '2026-06-15T00:00:00.000Z',
      suggestion:
        'Retry restoreBackup() with the same backup handle so the SDK can reconcile the restore operation.'
    });

    expect(error).toBeInstanceOf(OperationInterruptedError);
    const interrupted = error as OperationInterruptedError;

    expect(interrupted.code).toBe(ErrorCode.OPERATION_INTERRUPTED);
    expect(interrupted.httpStatus).toBe(409);
    expect(interrupted.reason).toBe('recovery_exhausted');
    expect(interrupted.operationName).toBe('backup.restore');
    expect(interrupted.retryable).toBe(true);
    expect(interrupted.context).toEqual({
      reason: 'recovery_exhausted',
      operation: 'backup.restore',
      operationId: 'restore-op-1',
      operationKey: 'restore:backup-1:/workspace/project',
      idempotencyKey: 'restore:backup-1:/workspace/project',
      backupId: 'backup-1',
      dir: '/workspace/project',
      phase: 'restore_prepared',
      admitted: true,
      retryable: true,
      recoveryAttempts: 2,
      maxRecoveryAttempts: 2
    });

    expect(interrupted.toJSON()).toMatchObject({
      name: 'OperationInterruptedError',
      code: ErrorCode.OPERATION_INTERRUPTED,
      context: interrupted.context
    });
    expect(JSON.stringify(interrupted)).not.toContain('runtimeIdentityID');
    expect(JSON.stringify(interrupted)).not.toContain('sandboxLifetimeID');
    expect(JSON.stringify(interrupted)).not.toContain('placementId');
  });
});
