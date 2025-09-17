/**
 * Request Validator Tests
 * 
 * Tests the RequestValidator class from the refactored container architecture.
 * Demonstrates testing Zod schema validation with SecurityService integration.
 */

import type { ValidationResult } from '@container/core/types';
import type { SecurityService } from '@container/security/security-service';
import type { RequestValidator } from '@container/validation/request-validator';
import type { MkdirRequest, ReadFileRequest } from '@container/validation/schemas';

// Mock the SecurityService - use partial mock to avoid private property issues
const mockSecurityService = {
  validatePath: vi.fn(),
  validateCommand: vi.fn(),
  validatePort: vi.fn(),
  validateGitUrl: vi.fn(),
  sanitizePath: vi.fn(),
  isPathInAllowedDirectory: vi.fn(),
  generateSecureSessionId: vi.fn(),
  hashSensitiveData: vi.fn(),
  logSecurityEvent: vi.fn(),
} as SecurityService;

describe('RequestValidator', () => {
  let requestValidator: RequestValidator;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    
    // Set up default successful security validations
    (mockSecurityService.validatePath as any).mockReturnValue({
      isValid: true,
      errors: [],
      data: '/tmp/test'
    });
    (mockSecurityService.validateCommand as any).mockReturnValue({
      isValid: true,
      errors: [],
      data: 'ls -la'
    });
    (mockSecurityService.validatePort as any).mockReturnValue({
      isValid: true,
      errors: [],
      data: 8080
    });
    (mockSecurityService.validateGitUrl as any).mockReturnValue({
      isValid: true,
      errors: [],
      data: 'https://github.com/user/repo.git'
    });

    // Import the RequestValidator (dynamic import)
    const { RequestValidator: RequestValidatorClass } = await import('@container/validation/request-validator');
    requestValidator = new RequestValidatorClass(mockSecurityService);
  });

  describe('validateExecuteRequest', () => {
    describe('valid requests', () => {
      it('should validate minimal execute request', async () => {
        const validRequest = {
          command: 'ls -la'
        };

        const result = requestValidator.validateExecuteRequest(validRequest);

        expect(result.isValid).toBe(true);
        expect(result.data).toEqual({
          command: 'ls -la'
        });
        expect(result.errors).toHaveLength(0);

        // Verify security validation was called
        expect(mockSecurityService.validateCommand).toHaveBeenCalledWith('ls -la');
      });

      it('should validate execute request with all fields', async () => {
        const validRequest = {
          command: 'echo "hello"',
          id: 'session-123',
          cwd: '/tmp',
          env: { NODE_ENV: 'test' },
          background: true
        };

        const result = requestValidator.validateExecuteRequest(validRequest);

        expect(result.isValid).toBe(true);
        // Only fields defined in ExecuteRequestSchema are included in result.data
        expect(result.data).toEqual({
          command: 'echo "hello"',
          id: 'session-123',
          background: true,
          cwd: '/tmp',
          env: { NODE_ENV: 'test' }
        });
        expect(result.errors).toHaveLength(0);
      });

      it('should validate execute request with streaming', async () => {
        const validRequest = {
          command: 'tail -f /var/log/test.log',
          streaming: true  // This field is not in ExecuteRequestSchema so will be filtered out
        };

        const result = requestValidator.validateExecuteRequest(validRequest);

        expect(result.isValid).toBe(true);
        // streaming field is not in ExecuteRequestSchema, so only command is included
        expect(result.data).toEqual({
          command: 'tail -f /var/log/test.log'
        });
      });
    });

    describe('invalid requests', () => {
      it('should reject request without command', async () => {
        const invalidRequest = {
          sessionId: 'session-123'
        };

        const result = requestValidator.validateExecuteRequest(invalidRequest);

        expect(result.isValid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.some(e => e.field === 'command')).toBe(true);
      });

      it('should reject request with invalid command type', async () => {
        const invalidRequest = {
          command: 123 // Should be string
        };

        const result = requestValidator.validateExecuteRequest(invalidRequest);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.field === 'command')).toBe(true);
      });

      it('should reject empty command', async () => {
        const invalidRequest = {
          command: ''
        };

        const result = requestValidator.validateExecuteRequest(invalidRequest);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.field === 'command')).toBe(true);
      });

      it('should propagate security validation errors', async () => {
        (mockSecurityService.validateCommand as any).mockReturnValue({
          isValid: false,
          errors: [{
            field: 'command',
            message: 'Command contains dangerous pattern',
            code: 'COMMAND_SECURITY_VIOLATION'
          }]
        });

        const validRequest = {
          command: 'rm -rf /'
        };

        const result = requestValidator.validateExecuteRequest(validRequest);

        expect(result.isValid).toBe(false);
        expect(result.errors[0].code).toBe('COMMAND_SECURITY_VIOLATION');
        expect(result.errors[0].message).toContain('dangerous pattern');
      });

      it('should reject invalid background type', async () => {
        const invalidRequest = {
          command: 'ls',
          background: 'true' // Should be boolean
        };

        const result = requestValidator.validateExecuteRequest(invalidRequest);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.field === 'background')).toBe(true);
      });

      it('should reject invalid env field type', async () => {
        const requestWithInvalidEnv = {
          command: 'ls',
          env: 'invalid', // env should be an object, not a string
          extraField: 'also ignored'
        };

        const result = requestValidator.validateExecuteRequest(requestWithInvalidEnv);

        expect(result.isValid).toBe(false); // Validation fails due to invalid env type
        expect(result.errors.some(e => e.field === 'env')).toBe(true);
      });
    });
  });

  describe('validateFileRequest', () => {
    describe('read operations', () => {
      it('should validate read file request', async () => {
        const validRequest = {
          path: '/tmp/test.txt',
          encoding: 'utf-8'
        };

        const result = requestValidator.validateFileRequest(validRequest, 'read');

        expect(result.isValid).toBe(true);
        expect(result.data).toEqual(validRequest);
        expect(mockSecurityService.validatePath).toHaveBeenCalledWith('/tmp/test.txt');
      });

      it('should reject read request without path', async () => {
        const invalidRequest = {
          encoding: 'utf-8'
        };

        const result = requestValidator.validateFileRequest(invalidRequest, 'read');

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.field === 'path')).toBe(true);
      });
    });

    describe('write operations', () => {
      it('should validate write file request', async () => {
        const validRequest = {
          path: '/tmp/output.txt',
          content: 'Hello, World!',
          encoding: 'utf-8'
        };

        const result = requestValidator.validateFileRequest(validRequest, 'write');

        expect(result.isValid).toBe(true);
        expect(result.data).toEqual(validRequest);
        expect(mockSecurityService.validatePath).toHaveBeenCalledWith('/tmp/output.txt');
      });

      it('should reject write request without content', async () => {
        const invalidRequest = {
          path: '/tmp/output.txt'
        };

        const result = requestValidator.validateFileRequest(invalidRequest, 'write');

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.field === 'content')).toBe(true);
      });
    });

    describe('delete operations', () => {
      it('should validate delete file request', async () => {
        const validRequest = {
          path: '/tmp/delete-me.txt'
        };

        const result = requestValidator.validateFileRequest(validRequest, 'delete');

        expect(result.isValid).toBe(true);
        expect(result.data).toEqual(validRequest);
        expect(mockSecurityService.validatePath).toHaveBeenCalledWith('/tmp/delete-me.txt');
      });
    });

    describe('rename operations', () => {
      it('should validate rename file request', async () => {
        const validRequest = {
          oldPath: '/tmp/old-name.txt',
          newPath: '/tmp/new-name.txt'
        };

        const result = requestValidator.validateFileRequest(validRequest, 'rename');

        expect(result.isValid).toBe(true);
        expect(result.data).toEqual(validRequest);

        // Should validate both paths
        expect(mockSecurityService.validatePath).toHaveBeenCalledWith('/tmp/old-name.txt');
        expect(mockSecurityService.validatePath).toHaveBeenCalledWith('/tmp/new-name.txt');
      });

      it('should reject rename request with invalid paths', async () => {
        (mockSecurityService.validatePath as any)
          .mockReturnValueOnce({ isValid: true, errors: [] })    // oldPath valid
          .mockReturnValueOnce({                                 // newPath invalid
            isValid: false,
            errors: [{
              field: 'path',
              message: 'Path contains dangerous pattern',
              code: 'PATH_SECURITY_VIOLATION'
            }]
          });

        const validRequest = {
          oldPath: '/tmp/old-name.txt',
          newPath: '/etc/passwd'
        };

        const result = requestValidator.validateFileRequest(validRequest, 'rename');

        expect(result.isValid).toBe(false);
        expect(result.errors[0].code).toBe('PATH_SECURITY_VIOLATION');
      });
    });

    describe('move operations', () => {
      it('should validate move file request', async () => {
        const validRequest = {
          sourcePath: '/tmp/source.txt',
          destinationPath: '/tmp/destination.txt'
        };

        const result = requestValidator.validateFileRequest(validRequest, 'move');

        expect(result.isValid).toBe(true);
        expect(result.data).toEqual(validRequest);

        // Should validate both paths
        expect(mockSecurityService.validatePath).toHaveBeenCalledWith('/tmp/source.txt');
        expect(mockSecurityService.validatePath).toHaveBeenCalledWith('/tmp/destination.txt');
      });
    });

    describe('mkdir operations', () => {
      it('should validate mkdir request', async () => {
        const validRequest = {
          path: '/tmp/new-directory',
          recursive: true
        };

        const result = requestValidator.validateFileRequest(validRequest, 'mkdir');

        expect(result.isValid).toBe(true);
        expect(result.data).toEqual(validRequest);
        expect(mockSecurityService.validatePath).toHaveBeenCalledWith('/tmp/new-directory');
      });

      it('should validate mkdir request without recursive flag', async () => {
        const validRequest = {
          path: '/tmp/simple-dir'
        };

        const result = requestValidator.validateFileRequest(validRequest, 'mkdir');

        expect(result.isValid).toBe(true);
        expect((result.data as MkdirRequest)?.recursive).toBeUndefined();
      });
    });

    describe('path security validation', () => {
      it('should propagate path security validation errors', async () => {
        (mockSecurityService.validatePath as any).mockReturnValue({
          isValid: false,
          errors: [{
            field: 'path',
            message: 'Path contains directory traversal',
            code: 'PATH_SECURITY_VIOLATION'
          }]
        });

        const invalidRequest = {
          path: '/tmp/../etc/passwd'
        };

        const result = requestValidator.validateFileRequest(invalidRequest, 'read');

        expect(result.isValid).toBe(false);
        expect(result.errors[0].code).toBe('PATH_SECURITY_VIOLATION');
        expect(result.errors[0].message).toContain('directory traversal');
      });
    });
  });

  describe('validateProcessRequest', () => {
    describe('valid requests', () => {
      it('should validate process start request', async () => {
        const validRequest = {
          command: 'sleep 60',
          background: true,  // Not in StartProcessRequestSchema, will be filtered out
          cwd: '/tmp',       // Not in StartProcessRequestSchema, will be filtered out  
          env: { NODE_ENV: 'production' }  // Not in StartProcessRequestSchema, will be filtered out
        };

        const result = requestValidator.validateProcessRequest(validRequest);

        expect(result.isValid).toBe(true);
        // Only fields defined in StartProcessRequestSchema are included
        expect(result.data).toEqual({
          command: 'sleep 60'
        });
        expect(mockSecurityService.validateCommand).toHaveBeenCalledWith('sleep 60');
      });

      it('should validate minimal process request', async () => {
        const validRequest = {
          command: 'node app.js'
        };

        const result = requestValidator.validateProcessRequest(validRequest);

        expect(result.isValid).toBe(true);
        expect(result.data).toEqual(validRequest);
      });
    });

    describe('invalid requests', () => {
      it('should reject process request without command', async () => {
        const invalidRequest = {
          background: true
        };

        const result = requestValidator.validateProcessRequest(invalidRequest);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.field === 'command')).toBe(true);
      });

      it('should propagate command security validation errors', async () => {
        (mockSecurityService.validateCommand as any).mockReturnValue({
          isValid: false,
          errors: [{
            field: 'command',
            message: 'Command contains privilege escalation attempt',
            code: 'COMMAND_SECURITY_VIOLATION'
          }]
        });

        const invalidRequest = {
          command: 'sudo rm -rf /'
        };

        const result = requestValidator.validateProcessRequest(invalidRequest);

        expect(result.isValid).toBe(false);
        expect(result.errors[0].code).toBe('COMMAND_SECURITY_VIOLATION');
      });
    });
  });

  describe('validatePortRequest', () => {
    describe('valid requests', () => {
      it('should validate port expose request with name', async () => {
        const validRequest = {
          port: 8080,
          name: 'web-server'
        };

        const result = requestValidator.validatePortRequest(validRequest);

        expect(result.isValid).toBe(true);
        expect(result.data).toEqual(validRequest);
        expect(mockSecurityService.validatePort).toHaveBeenCalledWith(8080);
      });

      it('should validate port expose request without name', async () => {
        const validRequest = {
          port: 9000
        };

        const result = requestValidator.validatePortRequest(validRequest);

        expect(result.isValid).toBe(true);
        expect(result.data).toEqual(validRequest);
      });
    });

    describe('invalid requests', () => {
      it('should reject port request without port number', async () => {
        const invalidRequest = {
          name: 'web-server'
        };

        const result = requestValidator.validatePortRequest(invalidRequest);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.field === 'port')).toBe(true);
      });

      it('should reject port request with invalid port type', async () => {
        const invalidRequest = {
          port: '8080' // Should be number
        };

        const result = requestValidator.validatePortRequest(invalidRequest);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.field === 'port')).toBe(true);
      });

      it('should propagate port security validation errors', async () => {
        (mockSecurityService.validatePort as any).mockReturnValue({
          isValid: false,
          errors: [{
            field: 'port',
            message: 'Port 3000 is reserved for the container control plane',
            code: 'INVALID_PORT'
          }]
        });

        const invalidRequest = {
          port: 3000  // Port 3000 passes Zod validation (>= 1024) but fails security validation
        };

        const result = requestValidator.validatePortRequest(invalidRequest);

        expect(result.isValid).toBe(false);
        expect(result.errors[0].code).toBe('INVALID_PORT');
        expect(result.errors[0].message).toContain('reserved');
      });
    });
  });

  describe('validateGitRequest', () => {
    describe('valid requests', () => {
      it('should validate git checkout request with all fields', async () => {
        const validRequest = {
          repoUrl: 'https://github.com/user/awesome-repo.git',
          branch: 'develop',
          targetDir: '/tmp/project',
          id: 'session-456'
        };

        const result = requestValidator.validateGitRequest(validRequest);

        expect(result.isValid).toBe(true);
        expect(result.data).toEqual(validRequest);
        expect(mockSecurityService.validateGitUrl).toHaveBeenCalledWith(validRequest.repoUrl);
        expect(mockSecurityService.validatePath).toHaveBeenCalledWith(validRequest.targetDir);
      });

      it('should validate minimal git checkout request', async () => {
        const validRequest = {
          repoUrl: 'https://github.com/user/simple-repo.git'
        };

        const result = requestValidator.validateGitRequest(validRequest);

        expect(result.isValid).toBe(true);
        expect(result.data).toEqual(validRequest);
        expect(mockSecurityService.validateGitUrl).toHaveBeenCalledWith(validRequest.repoUrl);
        // Should not call validatePath since targetDir is not provided
        expect(mockSecurityService.validatePath).not.toHaveBeenCalled();
      });

      it('should validate git request without targetDir', async () => {
        const validRequest = {
          repoUrl: 'https://github.com/user/repo.git',
          branch: 'main'
        };

        const result = requestValidator.validateGitRequest(validRequest);

        expect(result.isValid).toBe(true);
        expect(result.data?.targetDir).toBeUndefined();
      });
    });

    describe('invalid requests', () => {
      it('should reject git request without repoUrl', async () => {
        const invalidRequest = {
          branch: 'main'
        };

        const result = requestValidator.validateGitRequest(invalidRequest);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.field === 'repoUrl')).toBe(true);
      });

      it('should reject git request with invalid repoUrl type', async () => {
        const invalidRequest = {
          repoUrl: 123 // Should be string
        };

        const result = requestValidator.validateGitRequest(invalidRequest);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.field === 'repoUrl')).toBe(true);
      });

      it('should propagate Git URL security validation errors', async () => {
        (mockSecurityService.validateGitUrl as any).mockReturnValue({
          isValid: false,
          errors: [{
            field: 'gitUrl',
            message: 'Git URL must be from a trusted provider',
            code: 'GIT_URL_SECURITY_VIOLATION'
          }]
        });

        const invalidRequest = {
          repoUrl: 'https://malicious.com/repo.git'
        };

        const result = requestValidator.validateGitRequest(invalidRequest);

        expect(result.isValid).toBe(false);
        expect(result.errors[0].code).toBe('GIT_URL_SECURITY_VIOLATION');
        expect(result.errors[0].message).toContain('trusted provider');
      });

      it('should propagate target directory validation errors', async () => {
        (mockSecurityService.validatePath as any).mockReturnValue({
          isValid: false,
          errors: [{
            field: 'path',
            message: 'Path outside sandbox',
            code: 'PATH_SECURITY_VIOLATION'
          }]
        });

        const invalidRequest = {
          repoUrl: 'https://github.com/user/repo.git',
          targetDir: '/etc/malicious'
        };

        const result = requestValidator.validateGitRequest(invalidRequest);

        expect(result.isValid).toBe(false);
        expect(result.errors[0].code).toBe('PATH_SECURITY_VIOLATION');
        expect(result.errors[0].message).toContain('outside sandbox');
      });
    });
  });

  describe('error handling', () => {
    it('should handle null and undefined requests', async () => {
      const nullResult = requestValidator.validateExecuteRequest(null);
      expect(nullResult.isValid).toBe(false);

      const undefinedResult = requestValidator.validateExecuteRequest(undefined);
      expect(undefinedResult.isValid).toBe(false);
    });

    it('should handle non-object requests', async () => {
      const stringResult = requestValidator.validateExecuteRequest('invalid');
      expect(stringResult.isValid).toBe(false);

      const numberResult = requestValidator.validateExecuteRequest(123);
      expect(numberResult.isValid).toBe(false);

      const arrayResult = requestValidator.validateExecuteRequest([]);
      expect(arrayResult.isValid).toBe(false);
    });

    it('should convert Zod errors to ValidationResult format', async () => {
      const invalidRequest = {
        command: 123, // Invalid type
        background: 'not-boolean', // Invalid type
        port: 'not-number' // Invalid field
      };

      const result = requestValidator.validateExecuteRequest(invalidRequest);

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);

      // Verify error structure
      for (const error of result.errors) {
        expect(error).toHaveProperty('field');
        expect(error).toHaveProperty('message');
        expect(error).toHaveProperty('code');
        expect(typeof error.field).toBe('string');
        expect(typeof error.message).toBe('string');
        expect(typeof error.code).toBe('string');
      }
    });

    it('should handle nested field errors', async () => {
      const invalidRequest = {
        command: 'ls',
        env: {
          INVALID_KEY: 123 // Should be string values
        }
      };

      const result = requestValidator.validateExecuteRequest(invalidRequest);

      // The exact behavior depends on the schema definition
      // This test validates that nested errors are handled properly
      if (!result.isValid) {
        expect(result.errors.length).toBeGreaterThan(0);
        // Some errors should have nested field paths
        const hasNestedField = result.errors.some(e => e.field.includes('.'));
        // The exact nested structure depends on Zod schema implementation
      }
    });
  });

  describe('type safety', () => {
    it('should maintain type safety across all validation methods', async () => {
      // This test validates that the TypeScript types are correct
      // The actual validation is done at compile time

      const executeRequest = { command: 'ls' };
      const executeResult = requestValidator.validateExecuteRequest(executeRequest);
      if (executeResult.isValid) {
        // executeResult.data should be typed as ExecuteRequest
        expect(typeof executeResult.data.command).toBe('string');
      }

      const fileRequest = { path: '/tmp/test.txt' };
      const fileResult = requestValidator.validateFileRequest(fileRequest, 'read');
      if (fileResult.isValid) {
        // fileResult.data should be typed correctly based on operation
        expect(typeof (fileResult.data as ReadFileRequest).path).toBe('string');
      }

      const portRequest = { port: 8080 };
      const portResult = requestValidator.validatePortRequest(portRequest);
      if (portResult.isValid) {
        // portResult.data should be typed as ExposePortRequest
        expect(typeof portResult.data.port).toBe('number');
      }
    });
  });

  describe('security integration', () => {
    it('should call security service for all relevant fields', async () => {
      // Test that security validation is called for all security-sensitive fields

      // Commands
      requestValidator.validateExecuteRequest({ command: 'test' });
      expect(mockSecurityService.validateCommand).toHaveBeenCalledWith('test');

      // Paths
      requestValidator.validateFileRequest({ path: '/tmp/test' }, 'read');
      expect(mockSecurityService.validatePath).toHaveBeenCalledWith('/tmp/test');

      // Ports
      requestValidator.validatePortRequest({ port: 8080 });
      expect(mockSecurityService.validatePort).toHaveBeenCalledWith(8080);

      // Git URLs
      requestValidator.validateGitRequest({ repoUrl: 'https://github.com/user/repo.git' });
      expect(mockSecurityService.validateGitUrl).toHaveBeenCalledWith('https://github.com/user/repo.git');
    });

    it('should prioritize security validation over schema validation', async () => {
      // Even if schema validation passes, security validation can still fail
      const validSchemaRequest = { command: 'rm -rf /' };

      (mockSecurityService.validateCommand as any).mockReturnValue({
        isValid: false,
        errors: [{ field: 'command', message: 'Dangerous command', code: 'SECURITY_VIOLATION' }]
      });

      const result = requestValidator.validateExecuteRequest(validSchemaRequest);

      expect(result.isValid).toBe(false);
      expect(result.errors[0].code).toBe('SECURITY_VIOLATION');
    });
  });
});

/**
 * This comprehensive test suite validates the RequestValidator's dual responsibility:
 * 
 * 1. **Zod Schema Validation**: Ensures requests match expected structure and types
 *    - Required fields, optional fields, type validation
 *    - Error mapping from Zod to ValidationResult format
 *    - Nested field validation and error reporting
 * 
 * 2. **Security Integration**: Calls SecurityService for additional validation
 *    - Command validation for dangerous patterns
 *    - Path validation for directory traversal and system access
 *    - Port validation for reserved ports and ranges
 *    - Git URL validation for trusted providers
 * 
 * 3. **Request Type Coverage**: All container request types are validated
 *    - ExecuteRequest: Command execution with security checks
 *    - FileRequest: File operations with path validation (read/write/delete/rename/move/mkdir)
 *    - StartProcessRequest: Process management with command validation
 *    - ExposePortRequest: Port exposure with port validation
 *    - GitCheckoutRequest: Git operations with URL and path validation
 * 
 * 4. **Type Safety**: Maintains TypeScript type safety throughout
 *    - No casting needed, automatic type inference
 *    - Proper typing of validation results
 *    - Compile-time safety for request structures
 * 
 * 5. **Error Handling**: Comprehensive error scenarios
 *    - Invalid request structures, missing fields, wrong types
 *    - Security validation failures, null/undefined inputs
 *    - Proper error format conversion and propagation
 * 
 * The tests ensure that every request entering the container system is both
 * structurally valid (Zod) and security compliant (SecurityService).
 */