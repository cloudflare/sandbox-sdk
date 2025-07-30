/**
 * HTTP API Contract Tests
 * 
 * These tests validate that all container HTTP endpoints match the expected
 * API contracts exactly. They prevent breaking changes to the public API
 * that external SDK consumers depend on.
 */

import type { 
  StartProcessResponse, 
  ExposePortResponse, 
  CreateSessionResponse,
  ListExposedPortsResponse,
  PingResponse,
  CommandsResponse,
  GitCheckoutResponse,
  ListProcessesResponse
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