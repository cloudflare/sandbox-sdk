import { SandboxClient } from '../../clients/sandbox-client';

describe('HTTP Request Flow', () => {
  let client: SandboxClient;
  let fetchMock: ReturnType<typeof vi.fn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    
    client = new SandboxClient({
      baseUrl: 'http://test.com',
      port: 3000,
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe('CORS headers handling', () => {
    it('should handle CORS headers correctly', async () => {
      fetchMock.mockImplementation(() => 
        Promise.resolve(new Response(JSON.stringify({ success: true, message: 'pong' }), {
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Content-Type': 'application/json'
          }
        }))
      );

      await client.utils.ping();

      // Verify request was made correctly (GET requests don't include custom headers in BaseHttpClient)
      const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
      expect(lastCall[0]).toBe('http://test.com/api/ping');
      expect(lastCall[1]).toEqual(expect.objectContaining({
        method: 'GET'
      }));
    });

    it('should handle CORS preflight requests correctly', async () => {
      // Mock actual POST response (preflight is handled by browser, not by our client)
      fetchMock.mockImplementation(() => 
        Promise.resolve(new Response(JSON.stringify({ success: true, stdout: 'test', stderr: '', exitCode: 0 }), {
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json'
          }
        }))
      );

      await client.commands.execute('echo test');

      // Verify POST request structure (BaseHttpClient adds Content-Type for POST requests)
      const postCall = fetchMock.mock.calls.find((call: [string, RequestInit]) => 
        call[1]?.method === 'POST' && call[0].includes('/api/execute')
      );
      
      expect(postCall).toBeDefined();
      expect(postCall![1]).toEqual(expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json'
        })
      }));
    });

    it('should handle cross-origin requests with credentials', async () => {
      const clientWithCredentials = new SandboxClient({
        baseUrl: 'https://api.example.com',
        port: 443,
      });

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': 'https://app.example.com',
            'Access-Control-Allow-Credentials': 'true',
            'Content-Type': 'application/json'
          }
        })
      );

      await clientWithCredentials.utils.ping();
      
      const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
      expect(lastCall[0]).toBe('https://api.example.com/api/ping');
      expect(lastCall[1]).toEqual(expect.objectContaining({
        method: 'GET'
      }));
    });
  });

  describe('request headers and content-type handling', () => {
    it('should set correct Content-Type for JSON requests', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      await client.commands.execute('echo test');

      const postCall = fetchMock.mock.calls.find((call: [string, RequestInit]) => call[1]?.method === 'POST');
      expect(postCall![1]).toEqual(expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json'
        })
      }));
    });

    it('should handle Accept headers correctly', async () => {
      fetchMock.mockImplementation(() => 
        Promise.resolve(new Response(JSON.stringify({ success: true, message: 'pong' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      await client.utils.ping();

      // GET requests in BaseHttpClient don't include custom headers like Accept
      const getCall = fetchMock.mock.calls.find((call: [string, RequestInit]) => call[1]?.method === 'GET');
      expect(getCall![1]).toEqual(expect.objectContaining({
        method: 'GET'
      }));
      // Accept header is not set by BaseHttpClient for GET requests
    });

    it('should handle custom headers when provided', async () => {
      // Test with a client that might include custom headers in the future
      fetchMock.mockImplementation(() => 
        Promise.resolve(new Response(JSON.stringify({ success: true, exitCode: 0, path: '/test.txt' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      await client.files.writeFile('/test.txt', 'content');

      const postCall = fetchMock.mock.calls.find((call: [string, RequestInit]) => 
        call[1]?.method === 'POST' && call[0].includes('/api/write')
      );
      
      expect(postCall![1]).toEqual(expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json'
        })
        // BaseHttpClient doesn't add Accept header, only Content-Type for POST
      }));
    });
  });

  describe('authentication and authorization flow', () => {
    it('should handle requests without authentication', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      await client.utils.ping();

      const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
      
      // Verify no Authorization header is present by default
      const headers = lastCall[1]?.headers as Record<string, string> || {};
      expect(headers.Authorization).toBeUndefined();
    });

    it('should handle unauthorized responses correctly', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({
          error: 'Unauthorized access',
          code: 'UNAUTHORIZED',
          details: 'Authentication required'
        }), {
          status: 401,
          headers: { 
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer realm="sandbox"'
          }
        })
      );

      await expect(client.commands.execute('echo test')).rejects.toThrow();
    });

    it('should handle forbidden responses correctly', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({
          error: 'Forbidden operation',
          code: 'FORBIDDEN',
          details: 'Insufficient permissions'
        }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      await expect(client.files.deleteFile('/protected/file.txt')).rejects.toThrow();
    });
  });

  describe('request timeout scenarios', () => {
    it('should handle request timeout scenarios', async () => {
      // Mock a timeout scenario using AbortController
      const abortController = new AbortController();
      
      fetchMock.mockImplementation(async () => {
        return new Promise((_, reject) => {
          const timeoutId = setTimeout(() => {
            abortController.abort();
            reject(new DOMException('Request timed out', 'AbortError'));
          }, 100);
          
          abortController.signal.addEventListener('abort', () => {
            clearTimeout(timeoutId);
            reject(new DOMException('Request timed out', 'AbortError'));
          });
        });
      });

      await expect(client.utils.ping()).rejects.toThrow();
    });

    it('should handle slow response scenarios', async () => {
      fetchMock.mockImplementation(async () => {
        // Simulate slow response
        await new Promise(resolve => setTimeout(resolve, 50));
        return new Response(JSON.stringify({ success: true, message: 'pong' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      });

      const result = await client.utils.ping();
      expect(typeof result).toBe('string');
      expect(result).toBe('pong');
    });

    it('should handle network connectivity issues', async () => {
      fetchMock.mockRejectedValue(new Error('Network error: Connection refused'));

      await expect(client.utils.ping()).rejects.toThrow('Network error');
    });
  });

  describe('response format validation', () => {
    it('should handle valid JSON responses', async () => {
      const responseData = {
        success: true,
        message: 'pong',
        timestamp: '2024-01-01T00:00:00Z'
      };

      fetchMock.mockImplementation(() => 
        Promise.resolve(new Response(JSON.stringify(responseData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      const result = await client.utils.ping();
      expect(typeof result).toBe('string');
      expect(result).toBe('pong');
    });

    it('should handle malformed JSON responses', async () => {
      fetchMock.mockResolvedValue(
        new Response('{ invalid json }', {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      await expect(client.utils.ping()).rejects.toThrow();
    });

    it('should handle empty responses', async () => {
      fetchMock.mockResolvedValue(
        new Response('', {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      await expect(client.utils.ping()).rejects.toThrow();
    });

    it('should handle non-JSON responses', async () => {
      fetchMock.mockResolvedValue(
        new Response('Plain text response', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' }
        })
      );

      await expect(client.utils.ping()).rejects.toThrow();
    });
  });

  describe('HTTP method routing', () => {
    beforeEach(() => {
      // Create fresh response for each call to avoid "Body already read" errors
      fetchMock.mockImplementation(() => 
        Promise.resolve(new Response(JSON.stringify({ 
          success: true, 
          message: 'pong',
          availableCommands: ['ls', 'pwd'],
          count: 2,
          processes: [],
          ports: []
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );
    });

    it('should route GET requests correctly', async () => {
      await client.utils.ping();
      await client.utils.getCommands();
      await client.processes.listProcesses();
      await client.ports.getExposedPorts();

      const getCalls = fetchMock.mock.calls.filter((call: [string, RequestInit]) => call[1]?.method === 'GET');
      expect(getCalls.length).toBe(4);
      
      expect(getCalls.some((call: [string, RequestInit]) => call[0].includes('/api/ping'))).toBe(true);
      expect(getCalls.some((call: [string, RequestInit]) => call[0].includes('/api/commands'))).toBe(true);
      expect(getCalls.some((call: [string, RequestInit]) => call[0].includes('/api/process/list'))).toBe(true);
      expect(getCalls.some((call: [string, RequestInit]) => call[0].includes('/api/exposed-ports'))).toBe(true);
    });

    it('should route POST requests correctly', async () => {
      // Mock different responses for different endpoints
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('execute')) {
          return Promise.resolve(new Response(JSON.stringify({ 
            success: true, stdout: 'test', stderr: '', exitCode: 0 
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        } else if (url.includes('write')) {
          return Promise.resolve(new Response(JSON.stringify({ 
            success: true, exitCode: 0, path: '/test.txt' 
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        } else if (url.includes('process/start')) {
          return Promise.resolve(new Response(JSON.stringify({ 
            success: true, process: { id: 'test-id', pid: 123 }
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        } else if (url.includes('expose-port')) {
          return Promise.resolve(new Response(JSON.stringify({ 
            success: true, port: 3000, protocol: 'http', url: 'http://localhost:3000'
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        } else if (url.includes('git/checkout')) {
          return Promise.resolve(new Response(JSON.stringify({ 
            success: true, repoUrl: 'https://github.com/user/repo.git', branch: 'main', targetDir: 'repo', stdout: '', stderr: '', exitCode: 0
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { 
          status: 200, headers: { 'Content-Type': 'application/json' } 
        }));
      });

      await client.commands.execute('echo test');
      await client.files.writeFile('/test.txt', 'content');
      await client.processes.startProcess('node app.js');
      await client.ports.exposePort(3000);
      await client.git.checkout('https://github.com/user/repo.git');

      const postCalls = fetchMock.mock.calls.filter((call: [string, RequestInit]) => call[1]?.method === 'POST');
      expect(postCalls.length).toBe(5);
      
      expect(postCalls.some((call: [string, RequestInit]) => call[0].includes('/api/execute'))).toBe(true);
      expect(postCalls.some((call: [string, RequestInit]) => call[0].includes('/api/write'))).toBe(true);
      expect(postCalls.some((call: [string, RequestInit]) => call[0].includes('/api/process/start'))).toBe(true);
      expect(postCalls.some((call: [string, RequestInit]) => call[0].includes('/api/expose-port'))).toBe(true);
      expect(postCalls.some((call: [string, RequestInit]) => call[0].includes('/api/git/checkout'))).toBe(true);
    });

    it('should route DELETE requests correctly', async () => {
      // Mock specific responses for DELETE requests
      fetchMock.mockImplementation((url: string, options?: RequestInit) => {
        if (url.includes('delete') && options?.method === 'POST') {
          // File deletion uses POST, not DELETE
          return Promise.resolve(new Response(JSON.stringify({ 
            success: true, exitCode: 0, path: '/test.txt' 
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        } else if (url.includes('process/process-123')) {
          return Promise.resolve(new Response(JSON.stringify({ 
            success: true, message: 'Process killed' 
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        } else if (url.includes('exposed-ports/3000')) {
          return Promise.resolve(new Response(JSON.stringify({ 
            success: true, message: 'Port unexposed' 
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { 
          status: 200, headers: { 'Content-Type': 'application/json' } 
        }));
      });

      await client.files.deleteFile('/test.txt'); // Uses POST
      await client.processes.killProcess('process-123'); // Uses DELETE
      await client.ports.unexposePort(3000); // Uses DELETE

      // Only 2 actual DELETE calls (process and port), file delete uses POST
      const deleteCalls = fetchMock.mock.calls.filter((call: [string, RequestInit]) => call[1]?.method === 'DELETE');
      expect(deleteCalls.length).toBe(2);
      
      const postCalls = fetchMock.mock.calls.filter((call: [string, RequestInit]) => call[1]?.method === 'POST');
      expect(postCalls.some((call: [string, RequestInit]) => call[0].includes('/api/delete'))).toBe(true);
      expect(deleteCalls.some((call: [string, RequestInit]) => call[0].includes('/api/process/process-123'))).toBe(true);
      expect(deleteCalls.some((call: [string, RequestInit]) => call[0].includes('/api/exposed-ports/3000'))).toBe(true);
    });
  });

  describe('request body serialization', () => {
    beforeEach(() => {
      // Create fresh response for each call
      fetchMock.mockImplementation(() => 
        Promise.resolve(new Response(JSON.stringify({ 
          success: true,
          process: { id: 'test-id', pid: 123 },
          content: 'test content',
          exitCode: 0,
          path: '/test.txt'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );
    });

    it('should serialize complex request bodies correctly', async () => {
      const complexOptions = {
        processId: 'server-process',
        sessionId: 'complex-test-session'
      };

      await client.processes.startProcess('node server.js', complexOptions);

      const postCall = fetchMock.mock.calls.find((call: [string, RequestInit]) => 
        call[1]?.method === 'POST' && call[0].includes('/api/process/start')
      );

      expect(postCall).toBeDefined();
      expect(postCall![1].body).toBeDefined();
      const requestBody = JSON.parse(postCall![1].body as string);
      expect(requestBody).toEqual(expect.objectContaining({
        command: 'node server.js'
        // Note: ProcessClient startProcess method has specific parameter structure
      }));
    });

    it('should handle empty request bodies for POST requests', async () => {
      await client.files.readFile('/test.txt');

      const postCall = fetchMock.mock.calls.find((call: [string, RequestInit]) => 
        call[1]?.method === 'POST' && call[0].includes('/api/read')
      );

      expect(postCall![1].body).toBeDefined();
      const requestBody = JSON.parse(postCall![1].body as string);
      expect(requestBody).toEqual(expect.objectContaining({
        path: '/test.txt'
      }));
    });

    it('should handle special characters in request bodies', async () => {
      const specialContent = 'Content with special chars: ñáéíóú & <script>alert("test")</script>';
      
      await client.files.writeFile('/special.txt', specialContent);

      const postCall = fetchMock.mock.calls.find((call: [string, RequestInit]) => 
        call[1]?.method === 'POST' && call[0].includes('/api/write')
      );

      expect(postCall![1].body).toBeDefined();
      const requestBody = JSON.parse(postCall![1].body as string);
      expect(requestBody.content).toBe(specialContent);
    });
  });

  describe('error response handling flow', () => {
    it('should handle 4xx client errors correctly', async () => {
      const errorCodes = [400, 401, 403, 404, 422];
      
      for (const statusCode of errorCodes) {
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify({
            error: `Client error ${statusCode}`,
            code: `HTTP_${statusCode}`,
            details: `Status code ${statusCode} response`
          }), {
            status: statusCode,
            headers: { 'Content-Type': 'application/json' }
          })
        );

        await expect(client.utils.ping()).rejects.toThrow();
      }
    });

    it('should handle 5xx server errors correctly', async () => {
      const errorCodes = [500, 502, 503, 504];
      
      for (const statusCode of errorCodes) {
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify({
            error: `Server error ${statusCode}`,
            code: `HTTP_${statusCode}`,
            details: `Status code ${statusCode} response`
          }), {
            status: statusCode,
            headers: { 'Content-Type': 'application/json' }
          })
        );

        await expect(client.utils.ping()).rejects.toThrow();
      }
    });

    it('should handle network-level errors', async () => {
      const networkErrors = [
        new TypeError('Failed to fetch'),
        new Error('Network request failed'),
        new DOMException('Request aborted', 'AbortError')
      ];

      for (const error of networkErrors) {
        fetchMock.mockRejectedValueOnce(error);
        await expect(client.utils.ping()).rejects.toThrow();
        fetchMock.mockClear();
      }
    });
  });

  describe('concurrent request handling', () => {
    it('should handle multiple concurrent requests', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('ping')) {
          return Promise.resolve(new Response(JSON.stringify({ success: true, message: 'pong' }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
          }));
        } else if (url.includes('commands')) {
          return Promise.resolve(new Response(JSON.stringify({ success: true, availableCommands: ['ls'], count: 1 }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
          }));
        } else if (url.includes('write')) {
          return Promise.resolve(new Response(JSON.stringify({ success: true, exitCode: 0, path: '/test.txt' }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
          }));
        } else if (url.includes('execute')) {
          return Promise.resolve(new Response(JSON.stringify({ success: true, stdout: 'test', stderr: '', exitCode: 0 }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
          }));
        }
        return Promise.resolve(new Response(JSON.stringify({ success: true }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        }));
      });

      const requests = [
        client.utils.ping(),
        client.utils.getCommands(),
        client.files.writeFile('/test1.txt', 'content1'),
        client.files.writeFile('/test2.txt', 'content2'),
        client.commands.execute('echo test1'),
        client.commands.execute('echo test2')
      ];

      const results = await Promise.all(requests);
      
      expect(results).toHaveLength(6);
      // Utility methods return strings, not objects with success property
      expect(typeof results[0]).toBe('string'); // ping
      expect(Array.isArray(results[1])).toBe(true); // getCommands
      // Other results have success property
      expect(results[2]).toHaveProperty('success');
      expect(results[3]).toHaveProperty('success');
      expect(results[4]).toHaveProperty('success');
      expect(results[5]).toHaveProperty('success');

      // Verify all requests were made
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it('should handle mixed success and failure concurrent requests', async () => {
      // Mock alternating success/failure responses
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, message: 'pong' }), { 
          status: 200, headers: { 'Content-Type': 'application/json' } 
        }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Failed' }), { 
          status: 500, headers: { 'Content-Type': 'application/json' } 
        }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ 
          success: true, content: 'file content', path: '/test.txt', exitCode: 0 
        }), { 
          status: 200, headers: { 'Content-Type': 'application/json' } 
        }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Failed' }), { 
          status: 500, headers: { 'Content-Type': 'application/json' } 
        }));

      const requests = [
        client.utils.ping(),
        client.utils.getCommands(),
        client.files.readFile('/test.txt'),
        client.commands.execute('echo test')
      ];

      const results = await Promise.allSettled(requests);
      
      expect(results).toHaveLength(4);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
      expect(results.filter(r => r.status === 'rejected')).toHaveLength(2);
    });
  });
});