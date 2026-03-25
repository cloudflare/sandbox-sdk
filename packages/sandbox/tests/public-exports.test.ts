import { describe, expect, it } from 'vitest';
import * as internalErrors from '../src/errors';
import * as sandboxSdk from '../src/index';

const rootErrorExports = {
  BackupCreateError: [
    sandboxSdk.BackupCreateError,
    internalErrors.BackupCreateError
  ],
  BackupExpiredError: [
    sandboxSdk.BackupExpiredError,
    internalErrors.BackupExpiredError
  ],
  BackupNotFoundError: [
    sandboxSdk.BackupNotFoundError,
    internalErrors.BackupNotFoundError
  ],
  BackupRestoreError: [
    sandboxSdk.BackupRestoreError,
    internalErrors.BackupRestoreError
  ],
  CodeExecutionError: [
    sandboxSdk.CodeExecutionError,
    internalErrors.CodeExecutionError
  ],
  CommandError: [sandboxSdk.CommandError, internalErrors.CommandError],
  CommandNotFoundError: [
    sandboxSdk.CommandNotFoundError,
    internalErrors.CommandNotFoundError
  ],
  ContextNotFoundError: [
    sandboxSdk.ContextNotFoundError,
    internalErrors.ContextNotFoundError
  ],
  CustomDomainRequiredError: [
    sandboxSdk.CustomDomainRequiredError,
    internalErrors.CustomDomainRequiredError
  ],
  DesktopInvalidCoordinatesError: [
    sandboxSdk.DesktopInvalidCoordinatesError,
    internalErrors.DesktopInvalidCoordinatesError
  ],
  DesktopInvalidOptionsError: [
    sandboxSdk.DesktopInvalidOptionsError,
    internalErrors.DesktopInvalidOptionsError
  ],
  DesktopNotStartedError: [
    sandboxSdk.DesktopNotStartedError,
    internalErrors.DesktopNotStartedError
  ],
  DesktopProcessCrashedError: [
    sandboxSdk.DesktopProcessCrashedError,
    internalErrors.DesktopProcessCrashedError
  ],
  DesktopStartFailedError: [
    sandboxSdk.DesktopStartFailedError,
    internalErrors.DesktopStartFailedError
  ],
  DesktopUnavailableError: [
    sandboxSdk.DesktopUnavailableError,
    internalErrors.DesktopUnavailableError
  ],
  FileExistsError: [sandboxSdk.FileExistsError, internalErrors.FileExistsError],
  FileNotFoundError: [
    sandboxSdk.FileNotFoundError,
    internalErrors.FileNotFoundError
  ],
  FileSystemError: [sandboxSdk.FileSystemError, internalErrors.FileSystemError],
  FileTooLargeError: [
    sandboxSdk.FileTooLargeError,
    internalErrors.FileTooLargeError
  ],
  GitAuthenticationError: [
    sandboxSdk.GitAuthenticationError,
    internalErrors.GitAuthenticationError
  ],
  GitBranchNotFoundError: [
    sandboxSdk.GitBranchNotFoundError,
    internalErrors.GitBranchNotFoundError
  ],
  GitCheckoutError: [
    sandboxSdk.GitCheckoutError,
    internalErrors.GitCheckoutError
  ],
  GitCloneError: [sandboxSdk.GitCloneError, internalErrors.GitCloneError],
  GitError: [sandboxSdk.GitError, internalErrors.GitError],
  GitNetworkError: [sandboxSdk.GitNetworkError, internalErrors.GitNetworkError],
  GitRepositoryNotFoundError: [
    sandboxSdk.GitRepositoryNotFoundError,
    internalErrors.GitRepositoryNotFoundError
  ],
  InterpreterNotReadyError: [
    sandboxSdk.InterpreterNotReadyError,
    internalErrors.InterpreterNotReadyError
  ],
  InvalidBackupConfigError: [
    sandboxSdk.InvalidBackupConfigError,
    internalErrors.InvalidBackupConfigError
  ],
  InvalidGitUrlError: [
    sandboxSdk.InvalidGitUrlError,
    internalErrors.InvalidGitUrlError
  ],
  InvalidPortError: [
    sandboxSdk.InvalidPortError,
    internalErrors.InvalidPortError
  ],
  PermissionDeniedError: [
    sandboxSdk.PermissionDeniedError,
    internalErrors.PermissionDeniedError
  ],
  PortAlreadyExposedError: [
    sandboxSdk.PortAlreadyExposedError,
    internalErrors.PortAlreadyExposedError
  ],
  PortError: [sandboxSdk.PortError, internalErrors.PortError],
  PortInUseError: [sandboxSdk.PortInUseError, internalErrors.PortInUseError],
  PortNotExposedError: [
    sandboxSdk.PortNotExposedError,
    internalErrors.PortNotExposedError
  ],
  ProcessError: [sandboxSdk.ProcessError, internalErrors.ProcessError],
  ProcessExitedBeforeReadyError: [
    sandboxSdk.ProcessExitedBeforeReadyError,
    internalErrors.ProcessExitedBeforeReadyError
  ],
  ProcessNotFoundError: [
    sandboxSdk.ProcessNotFoundError,
    internalErrors.ProcessNotFoundError
  ],
  ProcessReadyTimeoutError: [
    sandboxSdk.ProcessReadyTimeoutError,
    internalErrors.ProcessReadyTimeoutError
  ],
  SandboxError: [sandboxSdk.SandboxError, internalErrors.SandboxError],
  ServiceNotRespondingError: [
    sandboxSdk.ServiceNotRespondingError,
    internalErrors.ServiceNotRespondingError
  ],
  SessionAlreadyExistsError: [
    sandboxSdk.SessionAlreadyExistsError,
    internalErrors.SessionAlreadyExistsError
  ],
  SessionDestroyedError: [
    sandboxSdk.SessionDestroyedError,
    internalErrors.SessionDestroyedError
  ],
  ValidationFailedError: [
    sandboxSdk.ValidationFailedError,
    internalErrors.ValidationFailedError
  ]
} as const;

describe('public SDK exports', () => {
  it('re-exports SDK error classes from the root package', () => {
    for (const [exportName, [publicExport, internalExport]] of Object.entries(
      rootErrorExports
    )) {
      expect(publicExport).toBe(internalExport);
      expect(publicExport?.name).toBe(exportName);
    }
  });
});
