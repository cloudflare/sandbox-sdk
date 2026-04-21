import { describe, expect, it, vi } from 'vitest';
import {
  buildMessage,
  logCanonicalEvent,
  resolveLogLevel
} from '../../src/logger/canonical';
import type { Logger } from '../../src/logger/types';

function createMockLogger(): Logger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger)
  };
  return logger;
}

describe('buildMessage', () => {
  it('formats command success', () => {
    const msg = buildMessage({
      event: 'sandbox.exec',
      outcome: 'success',
      durationMs: 12,
      command: 'cat /workspace/file.txt'
    });
    expect(msg).toBe('sandbox.exec success cat /workspace/file.txt (12ms)');
  });

  it('formats command error with reason', () => {
    const msg = buildMessage({
      event: 'command.exec',
      outcome: 'error',
      durationMs: 1001,
      command: 'sleep 30',
      errorMessage: 'timeout after 1000ms'
    });
    expect(msg).toBe(
      'command.exec error sleep 30 \u2014 timeout after 1000ms (1001ms)'
    );
  });

  it('formats command error with exit code', () => {
    const msg = buildMessage({
      event: 'command.exec',
      outcome: 'error',
      durationMs: 5,
      command: 'exit 1',
      exitCode: 1
    });
    expect(msg).toBe('command.exec error exit 1 \u2014 exitCode=1 (5ms)');
  });

  it('formats file write with size', () => {
    const msg = buildMessage({
      event: 'file.write',
      outcome: 'success',
      durationMs: 0,
      path: '/workspace/test/file.txt',
      sizeBytes: 6
    });
    expect(msg).toBe('file.write success /workspace/test/file.txt (0ms, 6B)');
  });

  it('formats session create with sessionId', () => {
    const msg = buildMessage({
      event: 'session.create',
      outcome: 'success',
      durationMs: 0,
      sessionId: 'session-1c8a'
    });
    expect(msg).toBe('session.create success session-1c8a (0ms)');
  });

  it('formats port expose', () => {
    const msg = buildMessage({
      event: 'port.expose',
      outcome: 'success',
      durationMs: 5,
      port: 8080
    });
    expect(msg).toBe('port.expose success 8080 (5ms)');
  });

  it('formats version check without outcome or duration', () => {
    const msg = buildMessage({
      event: 'version.check',
      outcome: 'success',
      durationMs: 0,
      sdkVersion: '0.7.20',
      containerVersion: '0.7.20'
    });
    expect(msg).toBe('version.check sdk=0.7.20 container=0.7.20');
  });

  it('truncates long commands', () => {
    const longCmd = `echo ${'a'.repeat(200)}`;
    const msg = buildMessage({
      event: 'sandbox.exec',
      outcome: 'success',
      durationMs: 10,
      command: longCmd
    });
    expect(msg).toContain('...');
    expect(msg.length).toBeLessThan(longCmd.length + 50);
  });

  it('redacts presigned URLs in commands', () => {
    const cmd =
      'curl "https://bucket.r2.example.com/file?X-Amz-Credential=AKID&X-Amz-Signature=SIG"';
    const msg = buildMessage({
      event: 'sandbox.exec',
      outcome: 'success',
      durationMs: 5,
      command: cmd
    });
    expect(msg).toContain('X-Amz-Credential=REDACTED');
    expect(msg).toContain('X-Amz-Signature=REDACTED');
    expect(msg).not.toContain('AKID');
    expect(msg).not.toContain('SIG');
  });

  it('formats backup event with backupId', () => {
    const msg = buildMessage({
      event: 'backup.create',
      outcome: 'success',
      durationMs: 250,
      backupId: 'bkp-abc123'
    });
    expect(msg).toBe('backup.create success bkp-abc123 (250ms)');
  });

  it('formats git checkout with repoPath', () => {
    const msg = buildMessage({
      event: 'git.checkout',
      outcome: 'success',
      durationMs: 80,
      repoPath: '/workspace/my-repo'
    });
    expect(msg).toBe('git.checkout success /workspace/my-repo (80ms)');
  });

  it('formats bucket mount with mountPath', () => {
    const msg = buildMessage({
      event: 'bucket.mount',
      outcome: 'success',
      durationMs: 15,
      mountPath: '/mnt/data'
    });
    expect(msg).toBe('bucket.mount success /mnt/data (15ms)');
  });
});

describe('logCanonicalEvent', () => {
  it('calls logger.info for success outcome', () => {
    const logger = createMockLogger();
    logCanonicalEvent(logger, {
      event: 'sandbox.exec',
      outcome: 'success',
      durationMs: 12,
      command: 'ls'
    });
    expect(logger.info).toHaveBeenCalledOnce();
    const [message, context] = logger.info.mock.calls[0];
    expect(message).toContain('sandbox.exec success');
    expect(context.event).toBe('sandbox.exec');
    expect(context.outcome).toBe('success');
    expect(context.durationMs).toBe(12);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('calls logger.error for error outcome and passes sanitized Error object', () => {
    const logger = createMockLogger();
    const err = new Error('something broke');
    logCanonicalEvent(logger, {
      event: 'sandbox.exec',
      outcome: 'error',
      durationMs: 100,
      command: 'bad-cmd',
      errorMessage: 'something broke',
      error: err
    });
    expect(logger.error).toHaveBeenCalledOnce();
    const [message, errorArg, context] = logger.error.mock.calls[0];
    expect(message).toContain('sandbox.exec error');
    // Error is now a sanitized copy, not the original object
    expect(errorArg).toBeInstanceOf(Error);
    expect(errorArg.message).toBe('something broke');
    expect(errorArg.name).toBe('Error');
    expect(context.event).toBe('sandbox.exec');
    expect(context.outcome).toBe('error');
    expect(context.errorMessage).toBe('something broke');
    expect(context).not.toHaveProperty('error');
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('sets commandTruncated when command is long', () => {
    const logger = createMockLogger();
    const longCmd = `echo ${'x'.repeat(200)}`;
    logCanonicalEvent(logger, {
      event: 'sandbox.exec',
      outcome: 'success',
      durationMs: 1,
      command: longCmd
    });
    const [, context] = logger.info.mock.calls[0];
    expect(context.commandTruncated).toBe(true);
    expect(context.command).toContain('...');
    expect(context.command.length).toBeLessThan(longCmd.length);
  });

  it('auto-derives errorMessage from error.message when not explicitly set', () => {
    const logger = createMockLogger();
    const err = new Error('connection refused');
    logCanonicalEvent(logger, {
      event: 'sandbox.exec',
      outcome: 'error',
      durationMs: 50,
      command: 'curl localhost',
      error: err
    });
    expect(logger.error).toHaveBeenCalledOnce();
    const [message, , context] = logger.error.mock.calls[0];
    expect(message).toContain('\u2014 connection refused');
    expect(context.errorMessage).toBe('connection refused');
  });

  it('preserves explicit errorMessage over error.message', () => {
    const logger = createMockLogger();
    const err = new Error('raw error detail');
    logCanonicalEvent(logger, {
      event: 'sandbox.exec',
      outcome: 'error',
      durationMs: 50,
      command: 'curl localhost',
      errorMessage: 'domain-specific reason',
      error: err
    });
    expect(logger.error).toHaveBeenCalledOnce();
    const [message, , context] = logger.error.mock.calls[0];
    expect(message).toContain('\u2014 domain-specific reason');
    expect(context.errorMessage).toBe('domain-specific reason');
  });

  it('redacts command field in emitted context', () => {
    const logger = createMockLogger();
    logCanonicalEvent(logger, {
      event: 'sandbox.exec',
      outcome: 'success',
      durationMs: 1,
      command: 'curl https://user:pass@example.com/file?token=secret123'
    });
    const [, context] = logger.info.mock.calls[0];
    expect(context.command).toContain('******@');
    expect(context.command).toContain('token=REDACTED');
    expect(context.command).not.toContain('user:pass');
    expect(context.command).not.toContain('secret123');
  });

  it('redacts presigned URL credentials in errorMessage', () => {
    const logger = createMockLogger();
    const presignedUrl =
      'https://bucket.r2.example.com/file?X-Amz-Credential=AKIAIOSFODNN&X-Amz-Signature=abcdef123456';
    logCanonicalEvent(logger, {
      event: 'backup.create',
      outcome: 'error',
      durationMs: 500,
      errorMessage: `Upload failed: ${presignedUrl}`,
      error: new Error(`Upload failed: ${presignedUrl}`)
    });
    expect(logger.error).toHaveBeenCalledOnce();
    const [message, , context] = logger.error.mock.calls[0];
    // errorMessage in context should be sanitized
    expect(context.errorMessage).toContain('X-Amz-Credential=REDACTED');
    expect(context.errorMessage).toContain('X-Amz-Signature=REDACTED');
    expect(context.errorMessage).not.toContain('AKIAIOSFODNN');
    expect(context.errorMessage).not.toContain('abcdef123456');
    // Message should also contain redacted version
    expect(message).toContain('X-Amz-Credential=REDACTED');
    expect(message).not.toContain('AKIAIOSFODNN');
  });

  it('redacts errorMessage auto-derived from error.message', () => {
    const logger = createMockLogger();
    const err = new Error(
      'Failed: https://r2.example.com/data?X-Amz-Signature=SECRET_SIG&X-Amz-Credential=SECRET_KEY'
    );
    logCanonicalEvent(logger, {
      event: 'sandbox.exec',
      outcome: 'error',
      durationMs: 100,
      error: err
    });
    expect(logger.error).toHaveBeenCalledOnce();
    const [message, , context] = logger.error.mock.calls[0];
    expect(context.errorMessage).toContain('X-Amz-Signature=REDACTED');
    expect(context.errorMessage).not.toContain('SECRET_SIG');
    expect(context.errorMessage).not.toContain('SECRET_KEY');
    expect(message).not.toContain('SECRET_SIG');
  });

  it('sanitizes Error object (message + stack) before passing to logger', () => {
    const logger = createMockLogger();
    const presignedUrl =
      'https://bucket.r2.example.com/file?X-Amz-Credential=AKIAIOSFODNN&X-Amz-Signature=abcdef123456';
    const err = new Error(`Upload failed: ${presignedUrl}`);
    logCanonicalEvent(logger, {
      event: 'backup.create',
      outcome: 'error',
      durationMs: 200,
      error: err
    });
    expect(logger.error).toHaveBeenCalledOnce();
    const [, errorArg] = logger.error.mock.calls[0];
    // The Error passed to logger should be sanitized
    expect(errorArg).toBeInstanceOf(Error);
    expect(errorArg.message).toContain('X-Amz-Credential=REDACTED');
    expect(errorArg.message).toContain('X-Amz-Signature=REDACTED');
    expect(errorArg.message).not.toContain('AKIAIOSFODNN');
    expect(errorArg.message).not.toContain('abcdef123456');
    // Stack should also be sanitized (it contains the message)
    if (errorArg.stack) {
      expect(errorArg.stack).not.toContain('AKIAIOSFODNN');
      expect(errorArg.stack).not.toContain('abcdef123456');
    }
    // Original error should NOT be mutated
    expect(err.message).toContain('AKIAIOSFODNN');
  });

  it('sanitizes URL credentials in Error object', () => {
    const logger = createMockLogger();
    const err = new Error(
      'Failed to fetch https://user:secret_password@example.com/api/data'
    );
    logCanonicalEvent(logger, {
      event: 'sandbox.exec',
      outcome: 'error',
      durationMs: 50,
      error: err
    });
    expect(logger.error).toHaveBeenCalledOnce();
    const [, errorArg] = logger.error.mock.calls[0];
    expect(errorArg.message).toContain('******@');
    expect(errorArg.message).not.toContain('user:secret_password');
  });

  it('includes branch in git.checkout buildMessage with repoPath', () => {
    const msg = buildMessage({
      event: 'git.checkout',
      outcome: 'success',
      durationMs: 80,
      repoPath: '/workspace/my-repo',
      branch: 'feature/test'
    });
    expect(msg).toBe(
      'git.checkout success /workspace/my-repo branch=feature/test (80ms)'
    );
  });
});

describe('resolveLogLevel', () => {
  it('always returns error for error outcome regardless of origin or options', () => {
    expect(
      resolveLogLevel({
        event: 'command.exec',
        outcome: 'error',
        durationMs: 0,
        origin: 'internal'
      })
    ).toBe('error');
    expect(
      resolveLogLevel(
        { event: 'file.read', outcome: 'error', durationMs: 0 },
        { successLevel: 'debug' }
      )
    ).toBe('error');
  });

  it('uses explicit successLevel when provided', () => {
    expect(
      resolveLogLevel(
        { event: 'version.check', outcome: 'success', durationMs: 0 },
        { successLevel: 'warn' }
      )
    ).toBe('warn');
    expect(
      resolveLogLevel(
        { event: 'version.check', outcome: 'success', durationMs: 0 },
        { successLevel: 'debug' }
      )
    ).toBe('debug');
  });

  it('demotes internal origin to debug', () => {
    expect(
      resolveLogLevel({
        event: 'command.exec',
        outcome: 'success',
        durationMs: 0,
        origin: 'internal'
      })
    ).toBe('debug');
  });

  it('demotes DEBUG_ON_SUCCESS events to debug', () => {
    for (const event of [
      'session.create',
      'session.destroy',
      'file.read',
      'file.write',
      'file.delete',
      'file.mkdir'
    ]) {
      expect(
        resolveLogLevel({ event, outcome: 'success', durationMs: 0 })
      ).toBe('debug');
    }
  });

  it('defaults to info for user commands', () => {
    expect(
      resolveLogLevel({
        event: 'sandbox.exec',
        outcome: 'success',
        durationMs: 0
      })
    ).toBe('info');
  });

  it('successLevel takes precedence over origin: internal', () => {
    expect(
      resolveLogLevel(
        {
          event: 'command.exec',
          outcome: 'success',
          durationMs: 0,
          origin: 'internal'
        },
        { successLevel: 'warn' }
      )
    ).toBe('warn');
  });
});

describe('logCanonicalEvent level dispatch', () => {
  it('calls logger.debug for internal origin commands', () => {
    const logger = createMockLogger();
    logCanonicalEvent(logger, {
      event: 'command.exec',
      outcome: 'success',
      durationMs: 5,
      command: 'mkdir -p /var/backups',
      origin: 'internal'
    });
    expect(logger.debug).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('calls logger.warn for version.check with successLevel: warn', () => {
    const logger = createMockLogger();
    logCanonicalEvent(
      logger,
      {
        event: 'version.check',
        outcome: 'success',
        durationMs: 0,
        sdkVersion: '0.7.20',
        containerVersion: '0.7.19',
        versionOutcome: 'version_mismatch'
      },
      { successLevel: 'warn' }
    );
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
    const [message] = logger.warn.mock.calls[0];
    expect(message).toContain('version_mismatch');
  });

  it('calls logger.debug for DEBUG_ON_SUCCESS events', () => {
    const logger = createMockLogger();
    logCanonicalEvent(logger, {
      event: 'file.write',
      outcome: 'success',
      durationMs: 1,
      path: '/workspace/test.txt',
      sizeBytes: 42
    });
    expect(logger.debug).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('still calls logger.error for errors on DEBUG_ON_SUCCESS events', () => {
    const logger = createMockLogger();
    logCanonicalEvent(logger, {
      event: 'file.write',
      outcome: 'error',
      durationMs: 1,
      path: '/read-only/test.txt',
      error: new Error('permission denied')
    });
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
