/**
 * HTTP API Contract Tests
 * 
 * These tests validate that all container HTTP endpoints match the expected
 * API contracts exactly. They prevent breaking changes to the public API
 * that external SDK consumers depend on.
 */

import type { 
  CommandsResponse,
  CreateSessionResponse,
  ExposePortResponse, 
  GitCheckoutResponse,
  ListExposedPortsResponse,
  ListProcessesResponse, 
  PingResponse,
  StartProcessResponse 
} from '@container/core/types';
import type { ExecuteResponse } from '../../clients/command-client';
import type { ReadFileResponse, WriteFileResponse } from '../../clients/file-client';
import type { ApiErrorResponse } from '../../clients/types';


// Mock container endpoint for testing
const HTTP_API_CONTRACT_BASE_URL = 'http://localhost:3000';

// Contract test response types - union of success and error cases
type ApiResponse = ApiErrorResponse;

// Union types for contract testing that include both success and error cases
type ContractCreateSessionResponse = CreateSessionResponse | ApiErrorResponse;
type ContractStartProcessResponse = StartProcessResponse | ApiErrorResponse;

// Common HTTP API contract patterns that ALL endpoints should follow
interface CommonHttpResponseContract {
  timestamp: string;
}

interface CommonSuccessResponseContract extends CommonHttpResponseContract {
  success: true;
}

interface CommonErrorResponseContract extends CommonHttpResponseContract {
  success: false;
  error: string;
}

// Type guards for common contract patterns
function isSuccessResponse(data: unknown): data is CommonSuccessResponseContract {
  return typeof data === 'object' && data !== null && 
         'success' in data && (data as Record<string, unknown>).success === true &&
         'timestamp' in data && typeof (data as Record<string, unknown>).timestamp === 'string';
}

function isErrorResponse(data: unknown): data is CommonErrorResponseContract {
  return typeof data === 'object' && data !== null &&
         'success' in data && (data as Record<string, unknown>).success === false &&
         'error' in data && typeof (data as Record<string, unknown>).error === 'string' &&
         'timestamp' in data && typeof (data as Record<string, unknown>).timestamp === 'string';
}
type ContractListProcessesResponse = ListProcessesResponse | ApiErrorResponse;
type ContractListExposedPortsResponse = ListExposedPortsResponse | ApiErrorResponse;

describe('HTTP API Contract Validation', () => {
  let testSessionId: string;

  beforeAll(async () => {
    // Create a test session for use in other tests
    const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    
    if (response.ok) {
      const data: ContractCreateSessionResponse = await response.json();
      if ('sessionId' in data && data.sessionId) {
        testSessionId = data.sessionId;
      }
    }
    
    // Fallback to default session if creation fails
    testSessionId = testSessionId || 'test-session-contract';
  });

  describe('Command Execution API (/api/execute)', () => {
    it('should return ExecuteResponse contract for successful command', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'echo "contract test"',
          sessionId: testSessionId
        })
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');

      const data: ExecuteResponse = await response.json();
      
      // Validate response structure matches contract exactly
      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('timestamp');
      expect(typeof data.success).toBe('boolean');
      expect(typeof data.timestamp).toBe('string');

      if (data.success) {
        expect(data).toHaveProperty('stdout');
        expect(data).toHaveProperty('exitCode');
        expect(typeof data.stdout).toBe('string');
        expect(typeof data.exitCode).toBe('number');
        expect(data.stdout).toContain('contract test');
        expect(data.exitCode).toBe(0);
      } else {
        expect(data).toHaveProperty('stderr');
        expect(typeof data.stderr).toBe('string');
      }

      // Validate timestamp format (ISO 8601)
      expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(data.timestamp)).toBeInstanceOf(Date);
    });

    it('should return ExecuteResponse contract for failed command', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'nonexistent-command-12345',
          sessionId: testSessionId
        })
      });

      expect(response.status).toBe(200); // Should still be 200 with error in response
      const data: ExecuteResponse = await response.json();

      expect(data.success).toBe(false);
      expect(data).toHaveProperty('stderr');
      expect(data).toHaveProperty('exitCode');
      expect(data).toHaveProperty('timestamp');
      expect(typeof data.stderr).toBe('string');
      expect(typeof data.exitCode).toBe('number');
      expect(data.exitCode).not.toBe(0);
    });

    it('should return 400 for invalid request body', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Missing required 'command' field
          sessionId: testSessionId
        })
      });

      expect(response.status).toBe(400);
      const data: ApiResponse = await response.json();
      
      expect(data.success).toBe(false);
      expect(data).toHaveProperty('error');
      expect(typeof data.error).toBe('string');
      expect(data.error).toContain('validation');
    });
  });

  describe('File Operations API (/api/files)', () => {
    it('should return FileWriteResponse contract for file write', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/files/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/contract-test.txt',
          content: 'test content for contract validation',
          encoding: 'utf-8',
          sessionId: testSessionId
        })
      });

      expect(response.status).toBe(200);
      const data: WriteFileResponse = await response.json();

      // Validate contract structure
      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('timestamp');
      expect(typeof data.success).toBe('boolean');
      expect(typeof data.timestamp).toBe('string');

      if (data.success) {
        expect(data).toHaveProperty('path');
        expect(data).toHaveProperty('exitCode');
        expect(typeof data.path).toBe('string');
        expect(typeof data.exitCode).toBe('number');
        expect(data.exitCode).toBe(0);
      }
    });

    it('should return FileReadResponse contract for file read', async () => {
      // First ensure file exists by writing it
      await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/files/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/contract-read-test.txt',
          content: 'content for read test',
          sessionId: testSessionId
        })
      });

      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/files/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/contract-read-test.txt',
          encoding: 'utf-8',
          sessionId: testSessionId
        })
      });

      expect(response.status).toBe(200);
      const data: ReadFileResponse = await response.json();

      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('timestamp');

      if (data.success) {
        expect(data).toHaveProperty('content');
        expect(data).toHaveProperty('path');
        expect(typeof data.content).toBe('string');
        expect(typeof data.path).toBe('string');
        expect(data.content).toContain('content for read test');
      }
    });

    it('should return 404 for nonexistent file read', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/files/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/nonexistent-file-contract-test.txt',
          sessionId: testSessionId
        })
      });

      expect(response.status).toBe(404);
      const data: ReadFileResponse = await response.json();

      expect(data.success).toBe(false);
      expect(data).toHaveProperty('timestamp');
    });

    it('should return 400 for dangerous file path', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/files/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/etc/passwd',
          sessionId: testSessionId
        })
      });

      expect(response.status).toBe(400);
      const data: ApiResponse = await response.json();

      expect(data.success).toBe(false);
      expect(data).toHaveProperty('error');
      expect(data.error).toContain('Path validation failed');
    });
  });

  describe('Process Management API (/api/processes)', () => {
    it('should return ProcessStartResponse contract for process start', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/processes/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'sleep 1',
          background: true,
          sessionId: testSessionId
        })
      });

      expect(response.status).toBe(200);
      const data: ContractStartProcessResponse = await response.json();

      expect(data).toHaveProperty('timestamp');

      if ('process' in data) {
        // Success case
        expect(data).toHaveProperty('process');
        expect(data).toHaveProperty('message');
        expect(typeof data.process.id).toBe('string');
        expect(typeof data.process.pid).toBe('number');
        expect(data.process.id.length).toBeGreaterThan(0);
        expect(data.process.pid).toBeGreaterThan(0);
      } else {
        // Error case
        expect(data).toHaveProperty('error');
        expect(typeof data.error).toBe('string');
      }
    });

    it('should return ProcessListResponse contract for process list', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/processes?sessionId=${testSessionId}`, {
        method: 'GET'
      });

      expect(response.status).toBe(200);
      const data: ContractListProcessesResponse = await response.json();

      expect(data).toHaveProperty('timestamp');

      if ('processes' in data) {
        // Success case
        expect(data).toHaveProperty('processes');
        expect(Array.isArray(data.processes)).toBe(true);

        // Validate process object structure if any processes exist
        if (data.processes && data.processes.length > 0) {
          const process = data.processes[0];
          expect(process).toHaveProperty('id');
          expect(process).toHaveProperty('command');
          expect(process).toHaveProperty('status');
          expect(process).toHaveProperty('startTime');
          expect(typeof process.id).toBe('string');
          expect(typeof process.command).toBe('string');
          expect(typeof process.status).toBe('string');
        }
      } else {
        // Error case
        expect(data).toHaveProperty('error');
        expect(typeof data.error).toBe('string');
      }
    });
  });

  describe('Port Management API (/api/ports)', () => {
    it('should return PortExposeResponse contract for port expose', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/ports/expose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port: 8080,
          name: 'contract-test-service',
          sessionId: testSessionId
        })
      });

      expect(response.status).toBe(200);
      const data: ExposePortResponse = await response.json();

      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('timestamp');

      if (data.success) {
        expect(data).toHaveProperty('port');
        expect(data).toHaveProperty('exposedAt');
        expect(typeof data.port).toBe('number');
        expect(typeof data.exposedAt).toBe('string');
        expect(data.port).toBe(8080);

        if (data.name) {
          expect(typeof data.name).toBe('string');
          expect(data.name).toBe('contract-test-service');
        }
      }
    });

    it('should return PortListResponse contract for port list', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/ports?sessionId=${testSessionId}`, {
        method: 'GET'
      });

      expect(response.status).toBe(200);
      const data: ContractListExposedPortsResponse = await response.json();

      expect(data).toHaveProperty('timestamp');

      if ('ports' in data) {
        // Success case
        expect(data).toHaveProperty('ports');
        expect(Array.isArray(data.ports)).toBe(true);

        // Validate port object structure if any ports exist
        if (data.ports && data.ports.length > 0) {
          const port = data.ports[0];
          expect(port).toHaveProperty('port');
          expect(port).toHaveProperty('exposedAt');
          expect(typeof port.port).toBe('number');
          expect(typeof port.exposedAt).toBe('string');
          if (port.name) {
            expect(typeof port.name).toBe('string');
          }
        }
      } else {
        // Error case
        expect(data).toHaveProperty('error');
        expect(typeof data.error).toBe('string');
      }
    });

    it('should return 400 for reserved port', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/ports/expose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port: 22, // SSH port - should be blocked
          sessionId: testSessionId
        })
      });

      expect(response.status).toBe(400);
      const data: ApiResponse = await response.json();

      expect(data.success).toBe(false);
      expect(data).toHaveProperty('error');
      expect(data.error).toContain('Port validation failed');
    });
  });

  describe('Git Operations API (/api/git)', () => {
    it('should return GitCheckoutResponse contract for git checkout', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/git/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl: 'https://github.com/octocat/Hello-World.git',
          branch: 'master',
          targetDir: '/tmp/contract-git-test',
          sessionId: testSessionId
        })
      });

      expect(response.status).toBe(200);
      const data: GitCheckoutResponse = await response.json();

      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('timestamp');

      if (data.success) {
        expect(data).toHaveProperty('stdout');
        expect(data).toHaveProperty('exitCode');
        expect(data).toHaveProperty('targetDir');
        expect(typeof data.stdout).toBe('string');
        expect(typeof data.exitCode).toBe('number');
        expect(typeof data.targetDir).toBe('string');
        expect(data.exitCode).toBe(0);
        expect(data.targetDir).toBe('/tmp/contract-git-test');
      }
    });

    it('should return 400 for malicious git URL', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/git/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl: 'https://malicious-site.com/evil-repo.git',
          sessionId: testSessionId
        })
      });

      expect(response.status).toBe(400);
      const data: ApiResponse = await response.json();

      expect(data.success).toBe(false);
      expect(data).toHaveProperty('error');
      expect(data.error).toContain('Git URL validation failed');
    });
  });

  describe('Session Management API (/api/sessions)', () => {
    it('should return SessionCreateResponse contract for session creation', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          env: { CUSTOM_VAR: 'contract-test' }
        })
      });

      expect(response.status).toBe(200);
      const data: ContractCreateSessionResponse = await response.json();

      expect(data).toHaveProperty('timestamp');

      if ('sessionId' in data) {
        // Success case
        expect(data).toHaveProperty('sessionId');
        expect(data).toHaveProperty('message');
        expect(typeof data.sessionId).toBe('string');
        expect(typeof data.message).toBe('string');
        expect(data.sessionId.length).toBeGreaterThan(0);
      } else {
        // Error case
        expect(data).toHaveProperty('error');
        expect(typeof data.error).toBe('string');
      }
    });
  });

  describe('Utility APIs', () => {
    it('should return PingResponse contract for ping endpoint', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/ping`, {
        method: 'GET'
      });

      expect(response.status).toBe(200);
      const data: PingResponse = await response.json();

      expect(data).toHaveProperty('message');
      expect(data).toHaveProperty('timestamp');
      expect(data).toHaveProperty('requestId');
      expect(typeof data.message).toBe('string');
      expect(typeof data.timestamp).toBe('string');
      expect(typeof data.requestId).toBe('string');
      expect(data.message).toBe('pong');
      expect(data.requestId.length).toBeGreaterThan(0);

      // Validate timestamp format
      expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should return CommandsResponse contract for commands endpoint', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/commands`, {
        method: 'GET'
      });

      expect(response.status).toBe(200);
      const data: CommandsResponse = await response.json();

      expect(data).toHaveProperty('availableCommands');
      expect(data).toHaveProperty('timestamp');
      expect(Array.isArray(data.availableCommands)).toBe(true);
      expect(typeof data.timestamp).toBe('string');
      expect(data.availableCommands.length).toBeGreaterThan(0);

      // Validate essential commands are present
      const expectedCommands = ['ls', 'pwd', 'echo', 'cat', 'node', 'npm', 'git'];
      for (const command of expectedCommands) {
        expect(data.availableCommands).toContain(command);
      }
    });

    it('should return consistent text response for root endpoint', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/`, {
        method: 'GET'
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      
      const text = await response.text();
      expect(text).toBe('Hello from Bun server! 🚀');
    });
  });

  describe('Error Response Consistency', () => {
    it('should return consistent error format across all endpoints', async () => {
      const errorEndpoints = [
        {
          url: `${HTTP_API_CONTRACT_BASE_URL}/api/execute`,
          method: 'POST',
          body: JSON.stringify({ /* missing command */ }),
          expectedStatus: 400
        },
        {
          url: `${HTTP_API_CONTRACT_BASE_URL}/api/files/read`,
          method: 'POST',  
          body: JSON.stringify({ path: '/etc/passwd' }),
          expectedStatus: 400
        },
        {
          url: `${HTTP_API_CONTRACT_BASE_URL}/api/ports/expose`,
          method: 'POST',
          body: JSON.stringify({ port: 22 }),
          expectedStatus: 400
        },
        {
          url: `${HTTP_API_CONTRACT_BASE_URL}/api/git/checkout`,
          method: 'POST',
          body: JSON.stringify({ repoUrl: 'https://malicious.com/repo.git' }),
          expectedStatus: 400
        }
      ];

      for (const endpoint of errorEndpoints) {
        const response = await fetch(endpoint.url, {
          method: endpoint.method,
          headers: { 'Content-Type': 'application/json' },
          body: endpoint.body
        });

        expect(response.status).toBe(endpoint.expectedStatus);
        
        const data: ApiResponse = await response.json();
        
        // All error responses should have consistent structure
        expect(data).toHaveProperty('success');
        expect(data).toHaveProperty('error');
        expect(data.success).toBe(false);
        expect(typeof data.error).toBe('string');
        expect(data.error.length).toBeGreaterThan(0);
      }
    });

    it('should return 404 with consistent format for nonexistent endpoints', async () => {
      const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/nonexistent`, {
        method: 'GET'
      });

      expect(response.status).toBe(404);
      const data: ApiResponse = await response.json();

      expect(data.success).toBe(false);
      expect(data).toHaveProperty('error');
      expect(data.error).toBe('Invalid endpoint');
    });
  });

  describe('CORS Headers Consistency', () => {
    it('should include consistent CORS headers across all endpoints', async () => {
      const testEndpoints = [
        `${HTTP_API_CONTRACT_BASE_URL}/`,
        `${HTTP_API_CONTRACT_BASE_URL}/api/ping`,
        `${HTTP_API_CONTRACT_BASE_URL}/api/commands`,
        `${HTTP_API_CONTRACT_BASE_URL}/api/execute`,
        `${HTTP_API_CONTRACT_BASE_URL}/api/files/read`,
        `${HTTP_API_CONTRACT_BASE_URL}/api/ports/expose`
      ];

      for (const url of testEndpoints) {
        const response = await fetch(url, {
          method: url.includes('/api/execute') || url.includes('/files/') || url.includes('/ports/') ? 'POST' : 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: url.includes('/api/execute') ? JSON.stringify({ command: 'echo test', sessionId: testSessionId }) :
                url.includes('/files/') ? JSON.stringify({ path: '/tmp/test.txt', sessionId: testSessionId }) :
                url.includes('/ports/') ? JSON.stringify({ port: 9999, sessionId: testSessionId }) :
                undefined
        });

        // All responses should include CORS headers
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
        expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
        expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
      }
    });
  });

  describe('Comprehensive Response Format Validation', () => {
    describe('Success Response Format Consistency', () => {
      it('should return consistent success response format across all endpoints', async () => {
        const successEndpoints = [
          {
            name: 'Execute API',
            url: `${HTTP_API_CONTRACT_BASE_URL}/api/execute`,
            method: 'POST' as const,
            body: { command: 'echo "success test"', sessionId: testSessionId }
          },
          {
            name: 'File Write API',
            url: `${HTTP_API_CONTRACT_BASE_URL}/api/files/write`, 
            method: 'POST' as const,
            body: { path: '/tmp/success-test.txt', content: 'test', sessionId: testSessionId }
          },
          {
            name: 'Ping API',
            url: `${HTTP_API_CONTRACT_BASE_URL}/api/ping`,
            method: 'GET' as const,
            body: null
          },
          {
            name: 'Commands API',
            url: `${HTTP_API_CONTRACT_BASE_URL}/api/commands`,
            method: 'GET' as const,
            body: null
          }
        ];

        for (const endpoint of successEndpoints) {
          const response = await fetch(endpoint.url, {
            method: endpoint.method,
            headers: { 'Content-Type': 'application/json' },
            body: endpoint.body ? JSON.stringify(endpoint.body) : undefined
          });

          expect(response.status).toBe(200);
          expect(response.headers.get('content-type')).toContain('application/json');

          const data = await response.json();

          // Validate common success response contract
          expect(isSuccessResponse(data)).toBe(true);
          
          if (isSuccessResponse(data)) {
            // All success responses must have ISO 8601 timestamp
            expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
            expect(new Date(data.timestamp)).toBeInstanceOf(Date);
            expect(Number.isNaN(new Date(data.timestamp).getTime())).toBe(false);
            
            // All success responses must have success: true
            expect(data.success).toBe(true);
          }
        }
      });

      it('should maintain consistent common field types across all success responses', async () => {
        const endpoints = [
          {
            url: `${HTTP_API_CONTRACT_BASE_URL}/api/execute`,
            method: 'POST' as const,
            body: { command: 'echo "type test"', sessionId: testSessionId }
          },
          {
            url: `${HTTP_API_CONTRACT_BASE_URL}/api/ping`,
            method: 'GET' as const,
            body: null
          },
          {
            url: `${HTTP_API_CONTRACT_BASE_URL}/api/commands`,
            method: 'GET' as const,
            body: null
          }
        ];

        for (const endpoint of endpoints) {
          const response = await fetch(endpoint.url, {
            method: endpoint.method,
            headers: { 'Content-Type': 'application/json' },
            body: endpoint.body ? JSON.stringify(endpoint.body) : undefined
          });

          expect(response.status).toBe(200);
          const data = await response.json();

          // Validate common field types that ALL success responses should have
          expect(isSuccessResponse(data)).toBe(true);
          
          if (isSuccessResponse(data)) {
            // All success responses must have timestamp as string
            expect(typeof data.timestamp).toBe('string');
            // All success responses must have success as boolean
            expect(typeof data.success).toBe('boolean');
            expect(data.success).toBe(true);
          }
        }
      });
    });

    describe('Error Response Format Consistency', () => {
      it('should return consistent error response format across all endpoints', async () => {
        const errorEndpoints = [
          {
            name: 'Execute API - Validation Error',
            url: `${HTTP_API_CONTRACT_BASE_URL}/api/execute`,
            method: 'POST' as const,
            body: { /* missing command */ sessionId: testSessionId },
            expectedStatus: 400,
            expectedErrorType: 'validation'
          },
          {
            name: 'File API - Security Error',
            url: `${HTTP_API_CONTRACT_BASE_URL}/api/files/read`,
            method: 'POST' as const,
            body: { path: '/etc/passwd', sessionId: testSessionId },
            expectedStatus: 400,
            expectedErrorType: 'security'
          },
          {
            name: 'Port API - Validation Error',
            url: `${HTTP_API_CONTRACT_BASE_URL}/api/ports/expose`,
            method: 'POST' as const,
            body: { port: 'invalid', sessionId: testSessionId },
            expectedStatus: 400,
            expectedErrorType: 'validation'
          },
          {
            name: 'Git API - Security Error',
            url: `${HTTP_API_CONTRACT_BASE_URL}/api/git/checkout`,
            method: 'POST' as const,
            body: { repoUrl: 'invalid-url', sessionId: testSessionId },
            expectedStatus: 400,
            expectedErrorType: 'validation'
          }
        ];

        for (const endpoint of errorEndpoints) {
          const response = await fetch(endpoint.url, {
            method: endpoint.method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(endpoint.body)
          });

          expect(response.status).toBe(endpoint.expectedStatus);
          expect(response.headers.get('content-type')).toContain('application/json');

          const data = await response.json();
          
          // Validate common error response contract
          expect(isErrorResponse(data)).toBe(true);
          
          if (isErrorResponse(data)) {
            // All error responses must have success: false
            expect(data.success).toBe(false);
            
            // All error responses must have non-empty error message
            expect(data.error.length).toBeGreaterThan(0);
            
            // All error responses must have ISO 8601 timestamp
            expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
            expect(new Date(data.timestamp)).toBeInstanceOf(Date);
            expect(Number.isNaN(new Date(data.timestamp).getTime())).toBe(false);
          }

          // Validate error message contains relevant context
          if (isErrorResponse(data)) {
            if (endpoint.expectedErrorType === 'validation') {
              expect(data.error.toLowerCase()).toMatch(/validation|invalid|missing|required/);
            } else if (endpoint.expectedErrorType === 'security') {
              expect(data.error.toLowerCase()).toMatch(/security|validation|path|blocked/);
            }
          }
        }
      });

      it('should include error codes and details in structured error responses', async () => {
        const structuredErrorTests = [
          {
            url: `${HTTP_API_CONTRACT_BASE_URL}/api/files/read`,
            method: 'POST' as const,
            body: { path: '/nonexistent/file.txt', sessionId: testSessionId },
            expectedStatus: 404,
            expectedErrorCode: 'FILE_NOT_FOUND'
          },
          {
            url: `${HTTP_API_CONTRACT_BASE_URL}/api/execute`,
            method: 'POST' as const,
            body: { command: 'nonexistent-command-xyz', sessionId: testSessionId },
            expectedStatus: 200, // Command errors return 200 with error in response
            expectedInResponse: true
          }
        ];

        for (const test of structuredErrorTests) {
          const response = await fetch(test.url, {
            method: test.method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(test.body)
          });

          expect(response.status).toBe(test.expectedStatus);
          const data = await response.json();

          if (test.expectedInResponse) {
            // Command execution errors: HTTP 200 but operation failed
            // Should still follow common timestamp contract
            expect(data).toHaveProperty('timestamp');
            if (typeof data === 'object' && data !== null && 'timestamp' in data) {
              expect(typeof (data as Record<string, unknown>).timestamp).toBe('string');
              expect((data as Record<string, unknown>).timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
            }
            
            // These responses may have success: false to indicate operation failure
            if (typeof data === 'object' && data !== null && 'success' in data) {
              expect((data as Record<string, unknown>).success).toBe(false);
            }
          } else {
            // HTTP-level errors should follow error response contract
            expect(isErrorResponse(data)).toBe(true);
            
            if (isErrorResponse(data)) {
              expect(data.success).toBe(false);
              expect(data.error.length).toBeGreaterThan(0);
              expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
            }
          }
        }
      });
    });

    describe('Streaming Response Format Consistency', () => {
      it('should handle streaming response format correctly', async () => {
        const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/execute/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command: 'echo "stream test"',
            sessionId: testSessionId
          })
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/plain');
        expect(response.headers.get('transfer-encoding')).toBe('chunked');

        // Validate streaming response can be read
        const reader = response.body?.getReader();
        expect(reader).toBeDefined();

        if (reader) {
          const { value, done } = await reader.read();
          expect(done).toBe(false);
          expect(value).toBeInstanceOf(Uint8Array);

          // Clean up
          reader.releaseLock();
        }
      });

      it('should maintain consistent headers for streaming endpoints', async () => {
        const streamingEndpoints = [
          {
            url: `${HTTP_API_CONTRACT_BASE_URL}/api/execute/stream`,
            method: 'POST' as const,
            body: { command: 'echo "header test"', sessionId: testSessionId }
          }
        ];

        for (const endpoint of streamingEndpoints) {
          const response = await fetch(endpoint.url, {
            method: endpoint.method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(endpoint.body)
          });

          // Streaming responses should have consistent headers
          expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
          expect(response.headers.get('transfer-encoding')).toBe('chunked');
          expect(response.headers.get('content-type')).toContain('text/plain');
        }
      });
    });

    describe('Response Size and Performance Validation', () => {
      it('should handle large response payloads consistently', async () => {
        // Test with command that produces large output
        const response = await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command: 'for i in {1..100}; do echo "Line $i of large output test"; done',
            sessionId: testSessionId
          })
        });

        expect(response.status).toBe(200);
        const data = await response.json();
        
        // Validate cross-cutting HTTP API contract
        expect(isSuccessResponse(data)).toBe(true);
        
        if (isSuccessResponse(data)) {
          expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        }
        
        // Validate endpoint-specific response structure for large payloads
        expect(data).toHaveProperty('stdout');
        if (typeof data === 'object' && data !== null && 'stdout' in data && typeof data.stdout === 'string') {
          expect(data.stdout.length).toBeGreaterThan(1000); // Should be substantial output
          expect(data.stdout).toContain('Line 1');
          expect(data.stdout).toContain('Line 100');
        }
      });

      it('should maintain response format under concurrent load', async () => {
        const concurrentRequests = Array.from({ length: 5 }, (_, i) => 
          fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              command: `echo "concurrent test ${i}"`,
              sessionId: testSessionId
            })
          })
        );

        const responses = await Promise.all(concurrentRequests);
        
        for (let i = 0; i < responses.length; i++) {
          const response = responses[i];
          expect(response.status).toBe(200);
          expect(response.headers.get('content-type')).toContain('application/json');
          
          const data = await response.json();
          
          // Validate cross-cutting HTTP API contract
          expect(isSuccessResponse(data)).toBe(true);
          
          if (isSuccessResponse(data)) {
            expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
          }
          
          // Validate endpoint-specific response structure
          expect(data).toHaveProperty('stdout');
          if (typeof data === 'object' && data !== null && 'stdout' in data && typeof (data as Record<string, unknown>).stdout === 'string') {
            expect((data as Record<string, unknown>).stdout).toContain(`concurrent test ${i}`);
          }
        }
      });
    });

    describe('Content Encoding and Character Set Validation', () => {
      it('should handle UTF-8 content correctly in all responses', async () => {
        const unicodeTests = [
          {
            name: 'Command with Unicode Output',
            url: `${HTTP_API_CONTRACT_BASE_URL}/api/execute`,
            method: 'POST' as const,
            body: { command: 'echo "Hello 世界 🌍 émojis and spëcial chars"', sessionId: testSessionId },
            expectedInOutput: '世界 🌍 émojis and spëcial chars'
          },
          {
            name: 'File with Unicode Content',
            url: `${HTTP_API_CONTRACT_BASE_URL}/api/files/write`,
            method: 'POST' as const,
            body: { 
              path: '/tmp/unicode-test.txt', 
              content: 'Unicode content: 中文 🚀 café naïve résumé', 
              sessionId: testSessionId 
            },
            followUp: {
              url: `${HTTP_API_CONTRACT_BASE_URL}/api/files/read`,
              body: { path: '/tmp/unicode-test.txt', sessionId: testSessionId },
              expectedInContent: 'Unicode content: 中文 🚀 café naïve résumé'
            }
          }
        ];

        for (const test of unicodeTests) {
          const response = await fetch(test.url, {
            method: test.method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(test.body)
          });

          expect(response.status).toBe(200);
          expect(response.headers.get('content-type')).toContain('application/json');
          expect(response.headers.get('content-type')).toContain('charset=utf-8');
          
          const data = await response.json();
          
          // Validate cross-cutting HTTP API contract for UTF-8 content
          expect(isSuccessResponse(data)).toBe(true);
          
          if (isSuccessResponse(data)) {
            expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
          }
          
          // Validate UTF-8 content in endpoint-specific response  
          if (test.expectedInOutput && typeof data === 'object' && data !== null && 'stdout' in data && typeof (data as Record<string, unknown>).stdout === 'string') {
            expect((data as Record<string, unknown>).stdout).toContain(test.expectedInOutput);
          }

          // Test follow-up request for file operations
          if (test.followUp) {
            const followUpResponse = await fetch(test.followUp.url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(test.followUp.body)
            });

            expect(followUpResponse.status).toBe(200);
            const followUpData = await followUpResponse.json();
            
            // Validate cross-cutting contract for follow-up response
            expect(isSuccessResponse(followUpData)).toBe(true);
            
            if (test.followUp.expectedInContent && typeof followUpData === 'object' && followUpData !== null && 'content' in followUpData && typeof (followUpData as Record<string, unknown>).content === 'string') {
              expect((followUpData as Record<string, unknown>).content).toContain(test.followUp.expectedInContent);
            }
          }
        }
      });
    });
  });

  afterAll(async () => {
    // Clean up test session if it was created
    if (testSessionId && testSessionId !== 'test-session-contract') {
      await fetch(`${HTTP_API_CONTRACT_BASE_URL}/api/sessions/${testSessionId}`, {
        method: 'DELETE'
      }).catch(() => {
        // Ignore cleanup errors
      });
    }
  });
});

/**
 * These HTTP API contract tests are CRITICAL for preventing breaking changes
 * to the public API that external SDK consumers depend on. They validate:
 * 
 * 1. **Response Structure Consistency**: All endpoints return data in the expected format
 * 2. **Type Safety Validation**: Response data matches TypeScript interface contracts
 * 3. **Error Format Consistency**: Error responses follow the same structure across all endpoints
 * 4. **HTTP Status Code Contracts**: Correct status codes for success, validation errors, and not found
 * 5. **CORS Header Consistency**: All endpoints include proper CORS headers for browser compatibility
 * 6. **Content Type Contracts**: Proper content-type headers for JSON and text responses
 * 7. **Field Presence Validation**: Required fields are always present, optional fields properly typed
 * 8. **Data Type Contracts**: String, number, boolean, array types match expectations exactly
 * 9. **Timestamp Format Consistency**: All timestamps follow ISO 8601 format
 * 10. **Security Response Contracts**: Security violations return consistent error messages
 * 
 * If these tests fail, it indicates a breaking change has been introduced that will
 * affect SDK consumers. The change should either be reverted or the SDK interfaces
 * should be updated with proper versioning and migration paths.
 * 
 * These tests should be run against the actual container implementation in CI/CD
 * to catch contract breaks before they reach production.
 */