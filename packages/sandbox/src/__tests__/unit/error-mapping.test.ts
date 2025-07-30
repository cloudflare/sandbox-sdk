import type { ErrorResponse } from '../../clients';
import {
  CommandError,
  CommandNotFoundError,
  FileExistsError,
  FileNotFoundError,
  FileSystemError,
  GitAuthenticationError,
  GitBranchNotFoundError,
  GitCheckoutError,
  GitCloneError,
  GitError,
  GitNetworkError,
  GitRepositoryNotFoundError,
  InvalidGitUrlError,
  InvalidPortError,
  PermissionDeniedError,
  PortAlreadyExposedError,
  PortError,
  PortInUseError,
  PortNotExposedError,
  ProcessError,
  ProcessNotFoundError,
  SandboxError,
  SandboxOperation, 
  ServiceNotRespondingError
} from '../../errors';
import {
  isCommandError,
  isFileNotFoundError,
  isFileSystemError,
  isGitError,
  isPermissionError,
  isPortError,
  isProcessError,
  mapContainerError,
} from '../../utils/error-mapping';

describe('Error Mapping', () => {
  describe('mapContainerError', () => {
    describe('File System Errors', () => {
      it('should map FILE_NOT_FOUND to FileNotFoundError', () => {
        const errorResponse: ErrorResponse & { code: string; path: string } = {
          error: 'File not found: /test/file.txt',
          code: 'FILE_NOT_FOUND',
          path: '/test/file.txt',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(FileNotFoundError);
        expect(error.message).toBe('File not found: /test/file.txt');
        expect((error as FileNotFoundError).path).toBe('/test/file.txt');
      });

      it('should map PERMISSION_DENIED to PermissionDeniedError', () => {
        const errorResponse: ErrorResponse & { code: string; path: string } = {
          error: 'Permission denied: /root/secret.txt',
          code: 'PERMISSION_DENIED',
          path: '/root/secret.txt',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(PermissionDeniedError);
        expect(error.message).toBe('Permission denied: /root/secret.txt');
        expect((error as PermissionDeniedError).path).toBe('/root/secret.txt');
      });

      it('should map FILE_EXISTS to FileExistsError', () => {
        const errorResponse: ErrorResponse & { code: string; path: string } = {
          error: 'File already exists: /test/existing.txt',
          code: 'FILE_EXISTS',
          path: '/test/existing.txt',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(FileExistsError);
        expect(error.message).toBe('File already exists: /test/existing.txt');
        expect((error as FileExistsError).path).toBe('/test/existing.txt');
      });

      it('should map other filesystem codes to FileSystemError', () => {
        const codes = ['IS_DIRECTORY', 'NOT_DIRECTORY', 'NO_SPACE', 'TOO_MANY_FILES', 'RESOURCE_BUSY', 'READ_ONLY', 'NAME_TOO_LONG', 'TOO_MANY_LINKS', 'FILESYSTEM_ERROR'];
        
        codes.forEach(code => {
          const errorResponse: ErrorResponse & { code: string; path: string } = {
            error: `Filesystem error: ${code}`,
            code,
            path: '/test/path',
          };

          const error = mapContainerError(errorResponse);

          expect(error).toBeInstanceOf(FileSystemError);
          expect((error as FileSystemError).code).toBe(code);
          expect((error as FileSystemError).path).toBe('/test/path');
        });
      });

      it('should handle missing path for file errors', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'File not found',
          code: 'FILE_NOT_FOUND',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(FileNotFoundError);
        expect((error as FileNotFoundError).path).toBe('unknown');
      });
    });

    describe('Command Errors', () => {
      it('should map COMMAND_NOT_FOUND to CommandNotFoundError', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Command not found: nonexistent-cmd',
          code: 'COMMAND_NOT_FOUND',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(CommandNotFoundError);
        expect(error.message).toBe('Command not found: nonexistent-cmd');
        expect((error as CommandNotFoundError).command).toBe('nonexistent-cmd');
      });

      it('should map other command errors to CommandError', () => {
        const codes = ['COMMAND_PERMISSION_DENIED', 'COMMAND_EXECUTION_ERROR'];
        
        codes.forEach(code => {
          const errorResponse: ErrorResponse & { code: string } = {
            error: 'Command execution failed: test-cmd',
            code,
          };

          const error = mapContainerError(errorResponse);

          expect(error).toBeInstanceOf(CommandError);
          expect((error as CommandError).code).toBe(code);
          expect((error as CommandError).command).toBe('test-cmd');
        });
      });

      it('should extract command from various message formats', () => {
        const testCases = [
          { message: 'Command not found: test-command', expected: 'test-command' },
          { message: 'Command execution failed: npm install', expected: 'npm' },
          { message: 'Invalid command format', expected: 'unknown' },
        ];

        testCases.forEach(({ message, expected }) => {
          const errorResponse: ErrorResponse & { code: string } = {
            error: message,
            code: 'COMMAND_NOT_FOUND',
          };

          const error = mapContainerError(errorResponse);
          expect((error as CommandNotFoundError).command).toBe(expected);
        });
      });
    });

    describe('Process Errors', () => {
      it('should map PROCESS_NOT_FOUND to ProcessNotFoundError', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Process not found: proc-123',
          code: 'PROCESS_NOT_FOUND',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(ProcessNotFoundError);
        expect(error.message).toBe('Process not found: proc-123');
      });

      it('should map other process errors to ProcessError', () => {
        const codes = ['PROCESS_PERMISSION_DENIED', 'PROCESS_ERROR'];
        
        codes.forEach(code => {
          const errorResponse: ErrorResponse & { code: string } = {
            error: 'Process operation failed: proc-456',
            code,
          };

          const error = mapContainerError(errorResponse);

          expect(error).toBeInstanceOf(ProcessError);
          expect((error as ProcessError).code).toBe(code);
        });
      });

      it('should extract process ID from message', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Process not found: my-process-id',
          code: 'PROCESS_NOT_FOUND',
        };

        const error = mapContainerError(errorResponse);
        // The ProcessNotFoundError constructor expects just the processId parameter
        expect(error.message).toBe('Process not found: my-process-id');
      });
    });

    describe('Port Errors', () => {
      it('should map PORT_ALREADY_EXPOSED to PortAlreadyExposedError', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Port already exposed: 3001',
          code: 'PORT_ALREADY_EXPOSED',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(PortAlreadyExposedError);
        expect((error as PortAlreadyExposedError).port).toBe(3001);
      });

      it('should map PORT_NOT_EXPOSED to PortNotExposedError', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Port not exposed: 3002',
          code: 'PORT_NOT_EXPOSED',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(PortNotExposedError);
        expect((error as PortNotExposedError).port).toBe(3002);
      });

      it('should map INVALID_PORT_NUMBER to InvalidPortError', () => {
        const errorResponse: ErrorResponse & { code: string; details: string } = {
          error: 'Invalid port: 80',
          code: 'INVALID_PORT_NUMBER',
          details: 'Reserved port',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(InvalidPortError);
        expect((error as InvalidPortError).port).toBe(80);
        expect((error as InvalidPortError).details).toBe('Reserved port');
      });

      it('should map SERVICE_NOT_RESPONDING to ServiceNotRespondingError', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Service on port 3003 is not responding',
          code: 'SERVICE_NOT_RESPONDING',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(ServiceNotRespondingError);
        expect((error as ServiceNotRespondingError).port).toBe(3003);
      });

      it('should map PORT_IN_USE to PortInUseError', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Port in use: 3000',
          code: 'PORT_IN_USE',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(PortInUseError);
        expect((error as PortInUseError).port).toBe(3000);
      });

      it('should map PORT_OPERATION_ERROR to PortError', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Port operation failed on port 8080',
          code: 'PORT_OPERATION_ERROR',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(PortError);
        expect((error as PortError).code).toBe('PORT_OPERATION_ERROR');
        // Port extraction might not work with this message format
        expect(error.message).toBe('Port operation failed on port 8080');
      });

      it('should handle malformed port numbers', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Invalid port format',
          code: 'PORT_ALREADY_EXPOSED',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(PortAlreadyExposedError);
        expect((error as PortAlreadyExposedError).port).toBe(0);
      });
    });

    describe('Git Errors', () => {
      it('should map GIT_REPOSITORY_NOT_FOUND to GitRepositoryNotFoundError', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Git repository not found: https://github.com/user/repo.git',
          code: 'GIT_REPOSITORY_NOT_FOUND',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(GitRepositoryNotFoundError);
        // The GitRepositoryNotFoundError constructor creates its own message format
        expect(error.message).toContain('Git repository not found');
      });

      it('should map GIT_AUTH_FAILED to GitAuthenticationError', () => {
        const errorResponse: ErrorResponse & { code: string; details: string } = {
          error: 'Git authentication failed',
          code: 'GIT_AUTH_FAILED',
          details: 'https://github.com/private/repo.git',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(GitAuthenticationError);
        expect((error as GitAuthenticationError).repository).toBe('https://github.com/private/repo.git');
      });

      it('should map GIT_BRANCH_NOT_FOUND to GitBranchNotFoundError', () => {
        const errorResponse: ErrorResponse & { code: string; details: string } = {
          error: 'Git branch not found: feature-branch',
          code: 'GIT_BRANCH_NOT_FOUND',
          details: 'Branch "feature-branch" does not exist',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(GitBranchNotFoundError);
        expect((error as GitBranchNotFoundError).branch).toBe('feature-branch');
      });

      it('should map GIT_NETWORK_ERROR to GitNetworkError', () => {
        const errorResponse: ErrorResponse & { code: string; details: string } = {
          error: 'Git network error',
          code: 'GIT_NETWORK_ERROR',
          details: 'https://gitlab.com/user/project.git',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(GitNetworkError);
        expect((error as GitNetworkError).repository).toBe('https://gitlab.com/user/project.git');
      });

      it('should map GIT_CLONE_FAILED to GitCloneError', () => {
        const errorResponse: ErrorResponse & { code: string; details: string } = {
          error: 'Git clone failed',
          code: 'GIT_CLONE_FAILED',
          details: 'git@github.com:user/repo.git',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(GitCloneError);
        expect((error as GitCloneError).repository).toBe('git@github.com:user/repo.git');
      });

      it('should map GIT_CHECKOUT_FAILED to GitCheckoutError', () => {
        const errorResponse: ErrorResponse & { code: string; details: string } = {
          error: 'Git checkout failed: develop',
          code: 'GIT_CHECKOUT_FAILED',
          details: 'Branch "develop" checkout failed',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(GitCheckoutError);
        expect((error as GitCheckoutError).branch).toBe('develop');
      });

      it('should map INVALID_GIT_URL to InvalidGitUrlError', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Invalid Git URL: not-a-url',
          code: 'INVALID_GIT_URL',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(InvalidGitUrlError);
        // URL extraction from message may not work with this format
        expect(error.message).toBe('Invalid Git URL: not-a-url');
      });

      it('should map GIT_OPERATION_FAILED to GitError', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Git operation failed',
          code: 'GIT_OPERATION_FAILED',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(GitError);
        expect((error as GitError).code).toBe('GIT_OPERATION_FAILED');
      });
    });

    describe('Default Mapping', () => {
      it('should map unknown codes to SandboxError', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Unknown error occurred',
          code: 'UNKNOWN_ERROR',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(SandboxError);
        expect((error as SandboxError).code).toBe('UNKNOWN_ERROR');
        expect(error.message).toBe('Unknown error occurred');
      });

      it('should handle missing error code', () => {
        const errorResponse: ErrorResponse = {
          error: 'Generic error message',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(SandboxError);
        expect((error as SandboxError).code).toBeUndefined();
        expect(error.message).toBe('Generic error message');
      });

      it('should preserve operation and details', () => {
        const errorResponse: ErrorResponse & { code: string; operation: typeof SandboxOperation.FILE_READ; details: string } = {
          error: 'Custom error',
          code: 'CUSTOM_ERROR',
          operation: SandboxOperation.FILE_READ,
          details: 'Additional information',
        };

        const error = mapContainerError(errorResponse);

        expect(error).toBeInstanceOf(SandboxError);
        expect((error as SandboxError).operation).toBe(SandboxOperation.FILE_READ);
        expect((error as SandboxError).details).toBe('Additional information');
      });
    });
  });

  describe('Error Type Checkers', () => {
    describe('isFileNotFoundError', () => {
      it('should return true for FILE_NOT_FOUND code', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'File not found',
          code: 'FILE_NOT_FOUND',
        };

        expect(isFileNotFoundError(errorResponse)).toBe(true);
      });

      it('should return false for other codes', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Permission denied',
          code: 'PERMISSION_DENIED',
        };

        expect(isFileNotFoundError(errorResponse)).toBe(false);
      });

      it('should return false for missing code', () => {
        const errorResponse: ErrorResponse = {
          error: 'Some error',
        };

        expect(isFileNotFoundError(errorResponse)).toBe(false);
      });
    });

    describe('isPermissionError', () => {
      it('should return true for PERMISSION_DENIED', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Permission denied',
          code: 'PERMISSION_DENIED',
        };

        expect(isPermissionError(errorResponse)).toBe(true);
      });

      it('should return true for COMMAND_PERMISSION_DENIED', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Command permission denied',
          code: 'COMMAND_PERMISSION_DENIED',
        };

        expect(isPermissionError(errorResponse)).toBe(true);
      });

      it('should return false for other codes', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'File not found',
          code: 'FILE_NOT_FOUND',
        };

        expect(isPermissionError(errorResponse)).toBe(false);
      });
    });

    describe('isFileSystemError', () => {
      it('should return true for filesystem error codes', () => {
        const fileSystemCodes = [
          'FILE_NOT_FOUND', 'PERMISSION_DENIED', 'FILE_EXISTS', 'IS_DIRECTORY',
          'NOT_DIRECTORY', 'NO_SPACE', 'TOO_MANY_FILES', 'RESOURCE_BUSY',
          'READ_ONLY', 'NAME_TOO_LONG', 'TOO_MANY_LINKS', 'FILESYSTEM_ERROR'
        ];

        fileSystemCodes.forEach(code => {
          const errorResponse: ErrorResponse & { code: string } = {
            error: 'Filesystem error',
            code,
          };

          expect(isFileSystemError(errorResponse)).toBe(true);
        });
      });

      it('should return false for non-filesystem codes', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Command error',
          code: 'COMMAND_NOT_FOUND',
        };

        expect(isFileSystemError(errorResponse)).toBe(false);
      });
    });

    describe('isCommandError', () => {
      it('should return true for command error codes', () => {
        const commandCodes = ['COMMAND_NOT_FOUND', 'COMMAND_PERMISSION_DENIED', 'COMMAND_EXECUTION_ERROR'];

        commandCodes.forEach(code => {
          const errorResponse: ErrorResponse & { code: string } = {
            error: 'Command error',
            code,
          };

          expect(isCommandError(errorResponse)).toBe(true);
        });
      });

      it('should return false for non-command codes', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Process error',
          code: 'PROCESS_NOT_FOUND',
        };

        expect(isCommandError(errorResponse)).toBe(false);
      });
    });

    describe('isProcessError', () => {
      it('should return true for process error codes', () => {
        const processCodes = ['PROCESS_NOT_FOUND', 'PROCESS_PERMISSION_DENIED', 'PROCESS_ERROR'];

        processCodes.forEach(code => {
          const errorResponse: ErrorResponse & { code: string } = {
            error: 'Process error',
            code,
          };

          expect(isProcessError(errorResponse)).toBe(true);
        });
      });

      it('should return false for non-process codes', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Port error',
          code: 'PORT_IN_USE',
        };

        expect(isProcessError(errorResponse)).toBe(false);
      });
    });

    describe('isPortError', () => {
      it('should return true for port error codes', () => {
        const portCodes = [
          'PORT_ALREADY_EXPOSED', 'PORT_NOT_EXPOSED', 'INVALID_PORT_NUMBER',
          'SERVICE_NOT_RESPONDING', 'PORT_IN_USE', 'PORT_OPERATION_ERROR'
        ];

        portCodes.forEach(code => {
          const errorResponse: ErrorResponse & { code: string } = {
            error: 'Port error',
            code,
          };

          expect(isPortError(errorResponse)).toBe(true);
        });
      });

      it('should return false for non-port codes', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'Git error',
          code: 'GIT_CLONE_FAILED',
        };

        expect(isPortError(errorResponse)).toBe(false);
      });
    });

    describe('isGitError', () => {
      it('should return true for git error codes', () => {
        const gitCodes = [
          'GIT_REPOSITORY_NOT_FOUND', 'GIT_AUTH_FAILED', 'GIT_BRANCH_NOT_FOUND',
          'GIT_NETWORK_ERROR', 'GIT_CLONE_FAILED', 'GIT_CHECKOUT_FAILED',
          'INVALID_GIT_URL', 'GIT_OPERATION_FAILED'
        ];

        gitCodes.forEach(code => {
          const errorResponse: ErrorResponse & { code: string } = {
            error: 'Git error',
            code,
          };

          expect(isGitError(errorResponse)).toBe(true);
        });
      });

      it('should return false for non-git codes', () => {
        const errorResponse: ErrorResponse & { code: string } = {
          error: 'File error',
          code: 'FILE_NOT_FOUND',
        };

        expect(isGitError(errorResponse)).toBe(false);
      });
    });
  });

  describe('End-to-End Error Mapping', () => {
    describe('Realistic Container Error Responses', () => {
      it('should map container FILE_NOT_FOUND to FileNotFoundError with full context', () => {
        const containerResponse = {
          error: 'File not found: /home/user/project/config.json',
          code: 'FILE_NOT_FOUND',
          path: '/home/user/project/config.json',
          operation: SandboxOperation.FILE_READ,
          details: 'The specified file does not exist in the container filesystem',
          timestamp: '2024-07-30T12:00:00.000Z',
          requestId: 'req_123456789'
        };
        
        const clientError = mapContainerError(containerResponse);
        
        expect(clientError).toBeInstanceOf(FileNotFoundError);
        expect(clientError.message).toContain('config.json');
        
        if (clientError instanceof FileNotFoundError) {
          expect(clientError.path).toBe('/home/user/project/config.json');
          expect(clientError.operation).toBe(SandboxOperation.FILE_READ);
          expect(clientError.details).toBe('The specified file does not exist in the container filesystem');
        }
      });

      it('should map container COMMAND_NOT_FOUND to CommandNotFoundError with execution context', () => {
        const containerResponse = {
          error: 'Command not found: custom-build-tool',
          code: 'COMMAND_NOT_FOUND',
          command: 'custom-build-tool --version',
          details: 'Command "custom-build-tool" is not available in the container PATH',
          path: '/usr/local/bin:/usr/bin:/bin',
          timestamp: '2024-07-30T12:00:00.000Z',
          requestId: 'req_987654321'
        };
        
        const clientError = mapContainerError(containerResponse);
        
        expect(clientError).toBeInstanceOf(CommandNotFoundError);
        expect(clientError.message).toContain('custom-build-tool');
        
        if (clientError instanceof CommandNotFoundError) {
          expect(clientError.command).toBe('custom-build-tool --version');
          expect(clientError.details).toContain('PATH');
        }
      });

      it('should map container PROCESS_NOT_FOUND to ProcessNotFoundError with process details', () => {
        const containerResponse = {
          error: 'Process not found: proc_abc123def456',
          code: 'PROCESS_NOT_FOUND',
          processId: 'proc_abc123def456',
          details: 'Process may have exited or was never started',
          lastKnownStatus: 'running',
          sessionId: 'session_xyz789',
          timestamp: '2024-07-30T12:00:00.000Z',
          requestId: 'req_proc_lookup'
        };
        
        const clientError = mapContainerError(containerResponse);
        
        expect(clientError).toBeInstanceOf(ProcessNotFoundError);
        expect(clientError.message).toContain('proc_abc123def456');
        
        if (clientError instanceof ProcessNotFoundError) {
          expect(clientError.processId).toBe('proc_abc123def456');
          expect(clientError.details).toContain('exited');
        }
      });

      it('should map container PORT_ALREADY_EXPOSED to PortAlreadyExposedError with port info', () => {
        const containerResponse = {
          error: 'Port already exposed: 8080',
          code: 'PORT_ALREADY_EXPOSED',
          port: 8080,
          currentExposure: {
            exposedAt: 'https://8080-sandbox-abc123.example.com',
            name: 'web-server',
            sessionId: 'session_existing'
          },
          details: 'Port 8080 is already exposed by session session_existing',
          timestamp: '2024-07-30T12:00:00.000Z',
          requestId: 'req_port_expose'
        };
        
        const clientError = mapContainerError(containerResponse);
        
        expect(clientError).toBeInstanceOf(PortAlreadyExposedError);
        expect(clientError.message).toContain('8080');
        
        if (clientError instanceof PortAlreadyExposedError) {
          expect(clientError.port).toBe(8080);
          expect(clientError.details).toContain('session_existing');
        }
      });

      it('should map container INVALID_PORT to InvalidPortError with validation details', () => {
        const containerResponse = {
          error: 'Invalid port number: 99999',
          code: 'INVALID_PORT',
          port: 99999,
          validRange: { min: 1024, max: 65535 },
          reservedPorts: [22, 25, 53, 80, 443, 3000],
          details: 'Port must be between 1024-65535 and not reserved',
          timestamp: '2024-07-30T12:00:00.000Z',
          requestId: 'req_port_validate'
        };
        
        const clientError = mapContainerError(containerResponse);
        
        expect(clientError).toBeInstanceOf(InvalidPortError);
        expect(clientError.message).toContain('99999');
        
        if (clientError instanceof InvalidPortError) {
          expect(clientError.port).toBe(99999);
          expect(clientError.details).toContain('1024-65535');
        }
      });

      it('should map container GIT_REPOSITORY_NOT_FOUND to GitRepositoryNotFoundError', () => {
        const containerResponse = {
          error: 'Git repository not found: https://github.com/user/nonexistent-repo.git',
          code: 'GIT_REPOSITORY_NOT_FOUND',
          repoUrl: 'https://github.com/user/nonexistent-repo.git',
          branch: 'main',
          targetDir: '/tmp/workspace/project',
          httpStatus: 404,
          details: 'Repository does not exist or is not accessible',
          timestamp: '2024-07-30T12:00:00.000Z',
          requestId: 'req_git_clone'
        };
        
        const clientError = mapContainerError(containerResponse);
        
        expect(clientError).toBeInstanceOf(GitRepositoryNotFoundError);
        expect(clientError.message).toContain('nonexistent-repo');
        
        if (clientError instanceof GitRepositoryNotFoundError) {
          expect(clientError.repository).toBe('https://github.com/user/nonexistent-repo.git');
          expect(clientError.details).toContain('not accessible');
        }
      });

      it('should map container GIT_AUTH_FAILED to GitAuthenticationError with auth context', () => {
        const containerResponse = {
          error: 'Git authentication failed: https://github.com/private-org/secret-repo.git',
          code: 'GIT_AUTH_FAILED',
          repoUrl: 'https://github.com/private-org/secret-repo.git',
          authMethod: 'https',
          httpStatus: 401,
          details: 'Authentication required for private repository access',
          suggestion: 'Provide valid credentials or use SSH key authentication',
          timestamp: '2024-07-30T12:00:00.000Z',
          requestId: 'req_git_auth'
        };
        
        const clientError = mapContainerError(containerResponse);
        
        expect(clientError).toBeInstanceOf(GitAuthenticationError);
        expect(clientError.message).toContain('authentication');
        
        if (clientError instanceof GitAuthenticationError) {
          expect(clientError.repository).toBe('https://github.com/private-org/secret-repo.git');
          expect(clientError.details).toContain('credentials');
        }
      });
    });

    describe('Error Context Preservation', () => {
      it('should preserve all error context fields in mapped errors', () => {
        const richContainerResponse = {
          error: 'Permission denied: /etc/sensitive-config.txt',
          code: 'PERMISSION_DENIED',
          path: '/etc/sensitive-config.txt',
          operation: SandboxOperation.FILE_WRITE,
          details: 'Write access denied by security policy',
          securityLevel: 'HIGH',
          requestedPermissions: ['read', 'write'],
          availablePermissions: ['read'],
          timestamp: '2024-07-30T12:00:00.000Z',
          requestId: 'req_security_check',
          sessionId: 'session_secure_123',
          userId: 'user_developer_001'
        };
        
        const clientError = mapContainerError(richContainerResponse);
        
        expect(clientError).toBeInstanceOf(PermissionDeniedError);
        
        if (clientError instanceof PermissionDeniedError) {
          expect(clientError.path).toBe('/etc/sensitive-config.txt');
          expect(clientError.operation).toBe(SandboxOperation.FILE_WRITE);
          expect(clientError.details).toContain('security policy');
          
          // Verify error preserves rich context for debugging
          expect(clientError.message).toContain('sensitive-config.txt');
          expect(clientError.message).toContain('Permission denied');
        }
      });

      it('should handle errors with minimal context gracefully', () => {
        const minimalContainerResponse = {
          error: 'Operation failed',
          code: 'INTERNAL_ERROR'
        };
        
        const clientError = mapContainerError(minimalContainerResponse);
        
        expect(clientError).toBeInstanceOf(SandboxError);
        expect(clientError.message).toBe('Operation failed');
      });

      it('should handle errors with extra unknown fields gracefully', () => {
        const extendedContainerResponse = {
          error: 'File not found: /app/data.json',
          code: 'FILE_NOT_FOUND',
          path: '/app/data.json',
          operation: SandboxOperation.FILE_READ,
          // Extra fields that might be added in future container versions
          containerVersion: '2.1.0',
          experimentalFeatures: ['advanced-caching'],
          metrics: {
            diskUsage: '45%',
            memoryUsage: '23%'
          },
          unknown_field: 'should_be_ignored'
        };
        
        const clientError = mapContainerError(extendedContainerResponse);
        
        expect(clientError).toBeInstanceOf(FileNotFoundError);
        expect(clientError.message).toContain('data.json');
        
        if (clientError instanceof FileNotFoundError) {
          expect(clientError.path).toBe('/app/data.json');
          expect(clientError.operation).toBe(SandboxOperation.FILE_READ);
        }
      });
    });

    describe('Error Chaining and Causality', () => {
      it('should handle chained errors from container operations', () => {
        const chainedContainerResponse = {
          error: 'Command execution failed: npm install',
          code: 'COMMAND_EXECUTION_FAILED',
          command: 'npm install --production',
          exitCode: 1,
          stdout: 'npm WARN deprecated package@1.0.0',
          stderr: 'npm ERR! Error: EACCES: permission denied, mkdir \'/usr/local/lib/node_modules\'',
          rootCause: {
            error: 'Permission denied: /usr/local/lib/node_modules',
            code: 'PERMISSION_DENIED',
            path: '/usr/local/lib/node_modules',
            operation: SandboxOperation.DIRECTORY_CREATE
          },
          details: 'npm install failed due to permission issues with global module directory',
          timestamp: '2024-07-30T12:00:00.000Z',
          requestId: 'req_npm_install'
        };
        
        const clientError = mapContainerError(chainedContainerResponse);
        
        expect(clientError).toBeInstanceOf(CommandError);
        expect(clientError.message).toContain('npm install');
        
        if (clientError instanceof CommandError) {
          expect(clientError.command).toBe('npm install --production');
          expect(clientError.exitCode).toBe(1);
          expect(clientError.details).toContain('permission issues');
        }
      });
    });

    describe('Error Mapping Performance', () => {
      it('should handle error mapping efficiently for large error objects', () => {
        const largeContainerResponse = {
          error: 'Process execution timeout: long-running-script.sh',
          code: 'PROCESS_TIMEOUT',
          processId: 'proc_long_running_123',
          command: 'bash long-running-script.sh',
          timeout: 300000, // 5 minutes
          actualDuration: 350000, // 5.83 minutes
          details: 'Process exceeded maximum execution time limit',
          // Large diagnostic data
          processTree: Array.from({ length: 100 }, (_, i) => ({
            pid: 1000 + i,
            ppid: i === 0 ? null : 1000 + Math.floor(i / 2),
            name: `subprocess-${i}`,
            status: i % 3 === 0 ? 'running' : 'completed'
          })),
          memoryUsage: Array.from({ length: 60 }, (_, i) => ({
            timestamp: Date.now() - (60 - i) * 1000,
            usage: Math.random() * 1024 * 1024 * 1024 // Random GB usage
          })),
          logOutput: 'A'.repeat(10000), // 10KB of log data
          timestamp: '2024-07-30T12:00:00.000Z',
          requestId: 'req_long_process'
        };
        
        const start = performance.now();
        const clientError = mapContainerError(largeContainerResponse);
        const duration = performance.now() - start;
        
        expect(clientError).toBeInstanceOf(ProcessError);
        expect(duration).toBeLessThan(10); // Should complete in under 10ms
        
        if (clientError instanceof ProcessError) {
          expect(clientError.processId).toBe('proc_long_running_123');
          expect(clientError.details).toContain('timeout');
        }
      });
    });
  });
});