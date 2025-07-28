import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { SandboxClient } from '../../clients/sandbox-client';
import { Sandbox } from '../../sandbox';
import {
  FileNotFoundError,
  PermissionDeniedError,
  CommandNotFoundError,
  ProcessNotFoundError,
  PortAlreadyExposedError,
  PortNotExposedError,
  InvalidPortError,
  GitRepositoryNotFoundError,
  GitAuthenticationError,
  SandboxError
} from '../../errors';
import type { DurableObjectStub } from '@cloudflare/workers-types';

/**
 * Integration tests for error propagation from container through client layers
 * Validates that container errors are properly mapped to specific client error classes
 */
describe('Error Propagation Integration', () => {
  let sandbox: DurableObjectStub;
  let client: SandboxClient;

  beforeEach(async () => {
    // Get a Durable Object stub for the Sandbox
    sandbox = await runInDurableObject(Sandbox, async (instance, state) => {
      await instance.getSandbox();
      return instance;
    });

    // Create client with stub pointing to the Durable Object
    client = new SandboxClient({
      baseUrl: 'http://localhost',
      port: 3000,
      stub: {
        containerFetch: async (url: string, options: RequestInit) => {
          const request = new Request(url, options);
          return await sandbox.fetch(request);
        }
      }
    });
  });

  describe('File Operation Error Propagation', () => {
    it('should propagate FileNotFoundError for missing files', async () => {
      await expect(
        client.files.readFile('/nonexistent/file.txt')
      ).rejects.toThrow(FileNotFoundError);
    });

    it('should propagate PermissionDeniedError for restricted access', async () => {
      // Try to write to a typically restricted location
      await expect(
        client.files.writeFile('/root/.bashrc', 'malicious content')
      ).rejects.toThrow(); // May be PermissionDeniedError or other security error
    });

    it('should handle file operation with detailed error information', async () => {
      try {
        await client.files.readFile('/definitely/does/not/exist.txt');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('file');
        
        // If it's a FileNotFoundError, verify path information
        if (error instanceof FileNotFoundError) {
          expect(error.path).toBeDefined();
        }
      }
    });

    it('should propagate directory creation errors appropriately', async () => {
      // Try to create directory with invalid characters or in restricted location
      await expect(
        client.files.mkdir('/proc/invalid-dir') // proc is typically read-only
      ).rejects.toThrow();
    });
  });

  describe('Command Execution Error Propagation', () => {
    it('should propagate CommandNotFoundError for invalid commands', async () => {
      await expect(
        client.commands.execute('definitely-not-a-real-command-12345')
      ).rejects.toThrow(CommandNotFoundError);
    });

    it('should preserve command execution exit codes in errors', async () => {
      try {
        // Command that exists but will fail (non-zero exit code)
        await client.commands.execute('grep "nonexistent-pattern" /dev/null');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        // Verify error contains information about the failure
        expect(error.message.toLowerCase()).toMatch(/command|execution|failed|exit/);
      }
    });

    it('should handle command timeout errors appropriately', async () => {
      try {
        // Command that would run for a very long time
        await client.commands.execute('sleep 300', { timeoutMs: 1000 });
        expect.fail('Should have thrown a timeout error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error.message.toLowerCase()).toMatch(/timeout|time.*out|exceeded/);
      }
    });
  });

  describe('Process Management Error Propagation', () => {
    it('should propagate ProcessNotFoundError for invalid process IDs', async () => {
      await expect(
        client.processes.getProcess('nonexistent-process-id-12345')
      ).rejects.toThrow(ProcessNotFoundError);
    });

    it('should propagate ProcessNotFoundError for kill operations', async () => {
      await expect(
        client.processes.killProcess('invalid-process-id')
      ).rejects.toThrow(ProcessNotFoundError);
    });

    it('should handle process creation errors with detailed information', async () => {
      try {
        // Try to start a process with invalid command
        await client.processes.startProcess({
          command: 'nonexistent-command-for-process-test',
          background: true
        });
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        // Error should contain information about the failed process creation
        expect(error.message).toBeDefined();
      }
    });

    it('should handle process log retrieval errors', async () => {
      await expect(
        client.processes.getProcessLogs('fake-process-id-12345')
      ).rejects.toThrow(ProcessNotFoundError);
    });
  });

  describe('Port Management Error Propagation', () => {
    it('should propagate InvalidPortError for invalid port numbers', async () => {
      // Test reserved/invalid ports
      await expect(
        client.ports.exposePort({ port: 22 }) // SSH port - likely reserved
      ).rejects.toThrow(InvalidPortError);

      await expect(
        client.ports.exposePort({ port: 99999 }) // Out of valid range
      ).rejects.toThrow(InvalidPortError);
    });

    it('should propagate PortNotExposedError for unexposing non-exposed ports', async () => {
      await expect(
        client.ports.unexposePort(9999) // Definitely not exposed
      ).rejects.toThrow(PortNotExposedError);
    });

    it('should propagate PortAlreadyExposedError for duplicate exposures', async () => {
      // First exposure should succeed
      const exposeResult = await client.ports.exposePort({ port: 8888 });
      expect(exposeResult.success).toBe(true);

      try {
        // Second exposure should fail
        await expect(
          client.ports.exposePort({ port: 8888 })
        ).rejects.toThrow(PortAlreadyExposedError);
      } finally {
        // Clean up
        await client.ports.unexposePort(8888);
      }
    });

    it('should handle port validation errors with proper details', async () => {
      try {
        await client.ports.exposePort({ port: -1 }); // Invalid negative port
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidPortError);
        if (error instanceof InvalidPortError) {
          expect(error.port).toBe(-1);
          expect(error.details).toBeDefined();
        }
      }
    });
  });

  describe('Git Operation Error Propagation', () => {
    it('should propagate GitRepositoryNotFoundError for invalid repositories', async () => {
      await expect(
        client.git.checkout({
          repository: 'https://github.com/definitely/does-not-exist-repo-12345.git',
          directory: '/tmp/fake-repo'
        })
      ).rejects.toThrow(GitRepositoryNotFoundError);
    });

    it('should propagate GitAuthenticationError for private repositories', async () => {
      // Try to clone a private repository without credentials
      await expect(
        client.git.checkout({
          repository: 'https://github.com/private/some-private-repo.git',
          directory: '/tmp/private-test'
        })
      ).rejects.toThrow(); // May be GitAuthenticationError or GitRepositoryNotFoundError
    });

    it('should handle invalid Git URL errors', async () => {
      await expect(
        client.git.checkout({
          repository: 'not-a-valid-git-url',
          directory: '/tmp/invalid-url-test'
        })
      ).rejects.toThrow(); // Should throw some form of Git error
    });

    it('should handle directory conflicts in git operations', async () => {
      // Create a file where we want to clone
      await client.files.writeFile('/tmp/conflict-test', 'existing file');

      try {
        await expect(
          client.git.checkout({
            repository: 'https://github.com/octocat/Hello-World.git',
            directory: '/tmp/conflict-test' // This is a file, not a directory
          })
        ).rejects.toThrow();
      } finally {
        // Clean up
        await client.files.deleteFile('/tmp/conflict-test').catch(() => {});
      }
    });
  });

  describe('Utility Operation Error Propagation', () => {
    it('should handle service unavailable errors gracefully', async () => {
      // This test depends on the container implementation
      // The ping should normally succeed, but we test error handling structure
      try {
        const result = await client.utils.ping();
        expect(typeof result).toBe('string');
      } catch (error) {
        // If ping fails, ensure error is properly structured
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBeDefined();
      }
    });

    it('should handle command discovery errors appropriately', async () => {
      try {
        const commands = await client.utils.getCommands();
        expect(Array.isArray(commands)).toBe(true);
      } catch (error) {
        // If command discovery fails, ensure error is properly structured
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBeDefined();
      }
    });
  });

  describe('Error Callback Functionality', () => {
    it('should trigger error callbacks for failed operations', async () => {
      const errorCallback = vi.fn();
      
      const clientWithCallback = new SandboxClient({
        baseUrl: 'http://localhost',
        port: 3000,
        onError: errorCallback,
        stub: {
          containerFetch: async (url: string, options: RequestInit) => {
            const request = new Request(url, options);
            return await sandbox.fetch(request);
          }
        }
      });

      try {
        await clientWithCallback.files.readFile('/nonexistent/callback-test.txt');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(FileNotFoundError);
        
        // Verify error callback was triggered
        expect(errorCallback).toHaveBeenCalled();
        const callArgs = errorCallback.mock.calls[0];
        expect(callArgs[0]).toContain('file'); // Error message should mention file
      }
    });

    it('should trigger command completion callbacks for successful operations', async () => {
      const commandCompleteCallback = vi.fn();
      
      const clientWithCallback = new SandboxClient({
        baseUrl: 'http://localhost',
        port: 3000,
        onCommandComplete: commandCompleteCallback,
        stub: {
          containerFetch: async (url: string, options: RequestInit) => {
            const request = new Request(url, options);
            return await sandbox.fetch(request);
          }
        }
      });

      await clientWithCallback.commands.execute('echo "callback test"');

      // Verify callback was triggered with success
      expect(commandCompleteCallback).toHaveBeenCalled();
      const callArgs = commandCompleteCallback.mock.calls[0];
      expect(callArgs[0]).toBe(true); // success flag
      expect(callArgs[1]).toBe(0); // exit code
      expect(callArgs[2]).toContain('callback test'); // stdout
      expect(callArgs[4]).toContain('echo'); // command
    });
  });

  describe('HTTP Status Code Preservation', () => {
    it('should preserve error context through HTTP status codes', async () => {
      try {
        await client.files.readFile('/absolutely/nonexistent/path.txt');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        
        // Error should contain meaningful information
        expect(error.message).toBeDefined();
        expect(error.message.length).toBeGreaterThan(0);
        
        // If it's a structured error, verify it has proper context
        if (error instanceof FileNotFoundError) {
          expect(error.path).toBeDefined();
          expect(error.operation).toBeDefined();
        }
      }
    });

    it('should maintain error structure across different error types', async () => {
      const errorTests = [
        {
          operation: () => client.files.readFile('/fake/file.txt'),
          expectedType: FileNotFoundError
        },
        {
          operation: () => client.commands.execute('fake-command-12345'),
          expectedType: CommandNotFoundError
        },
        {
          operation: () => client.processes.getProcess('fake-process'),
          expectedType: ProcessNotFoundError
        },
        {
          operation: () => client.ports.unexposePort(99999),
          expectedType: PortNotExposedError
        }
      ];

      for (const test of errorTests) {
        try {
          await test.operation();
          expect.fail(`${test.expectedType.name} should have been thrown`);
        } catch (error) {
          expect(error).toBeInstanceOf(test.expectedType);
          expect(error.message).toBeDefined();
          expect(error.message.length).toBeGreaterThan(0);
        }
      }
    });
  });
});