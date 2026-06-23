import type { OperationInterruptedContext } from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import { describe, expect, it } from 'vitest';
import { OperationInterruptedError } from '../src/errors';

function makeOperationInterruptedResponse(
  overrides: Partial<OperationInterruptedContext> = {}
) {
  const context: OperationInterruptedContext = {
    reason: 'runtime_replaced',
    operation: 'backup.restore',
    phase: 'archive_ready',
    admitted: true,
    retryable: true,
    ...overrides
  };
  return {
    code: ErrorCode.OPERATION_INTERRUPTED,
    message: 'Operation was interrupted',
    context,
    httpStatus: 409,
    timestamp: new Date().toISOString()
  };
}

describe('OperationInterruptedError', () => {
  it('has the correct name', () => {
    const err = new OperationInterruptedError(
      makeOperationInterruptedResponse()
    );
    expect(err.name).toBe('OperationInterruptedError');
  });

  it('is an instance of SandboxError', async () => {
    const { SandboxError } = await import('../src/errors/classes');
    const err = new OperationInterruptedError(
      makeOperationInterruptedResponse()
    );
    expect(err).toBeInstanceOf(SandboxError);
  });

  it('exposes reason, operation, phase, admitted, retryable from context', () => {
    const err = new OperationInterruptedError(
      makeOperationInterruptedResponse({
        reason: 'sandbox_lifetime_changed',
        operation: 'backup.restore',
        phase: 'validating',
        admitted: 'unknown',
        retryable: false
      })
    );
    expect(err.context.reason).toBe('sandbox_lifetime_changed');
    expect(err.context.operation).toBe('backup.restore');
    expect(err.context.phase).toBe('validating');
    expect(err.context.admitted).toBe('unknown');
    expect(err.context.retryable).toBe(false);
  });

  it('exposes recoveryAttempts and maxRecoveryAttempts when present', () => {
    const err = new OperationInterruptedError(
      makeOperationInterruptedResponse({
        reason: 'recovery_exhausted',
        retryable: false,
        recoveryAttempts: 2,
        maxRecoveryAttempts: 2
      })
    );
    expect(err.context.recoveryAttempts).toBe(2);
    expect(err.context.maxRecoveryAttempts).toBe(2);
  });

  it('ErrorCode.OPERATION_INTERRUPTED exists', () => {
    expect(ErrorCode.OPERATION_INTERRUPTED).toBe('OPERATION_INTERRUPTED');
  });

  it('OperationInterruptedError is exported from @cloudflare/sandbox public barrel', async () => {
    const sdkExports = await import('../src/index');
    expect(sdkExports.OperationInterruptedError).toBeDefined();
    // Context type export is type-only; verify the error class is constructable
    expect(
      new sdkExports.OperationInterruptedError(
        makeOperationInterruptedResponse()
      )
    ).toBeInstanceOf(sdkExports.OperationInterruptedError);
  });
});
