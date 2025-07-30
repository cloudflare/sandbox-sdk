// Using expect.expect.fail() instead of importing fail from vitest

import { CommandClient } from '../../clients/command-client';
import { FileClient } from '../../clients/file-client';
import { GitClient } from '../../clients/git-client';
import { PortClient } from '../../clients/port-client';
import { ProcessClient } from '../../clients/process-client';
import { SandboxClient } from '../../clients/sandbox-client';
import { UtilityClient } from '../../clients/utility-client';

describe('Client Method Signatures Integration', () => {
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

  describe('method signature consistency', () => {
    it('should have consistent method signatures across clients', () => {
      // Test CommandClient methods
      expect(typeof client.commands.execute).toBe('function');
      expect(typeof client.commands.executeStream).toBe('function');
      expect(typeof client.commands.getSessionId).toBe('function');
      expect(typeof client.commands.setSessionId).toBe('function');
      
      // Test FileClient methods  
      expect(typeof client.files.writeFile).toBe('function');
      expect(typeof client.files.readFile).toBe('function');
      expect(typeof client.files.deleteFile).toBe('function');
      expect(typeof client.files.mkdir).toBe('function');
      expect(typeof client.files.renameFile).toBe('function');
      expect(typeof client.files.moveFile).toBe('function');
      expect(typeof client.files.getSessionId).toBe('function');
      expect(typeof client.files.setSessionId).toBe('function');
      
      // Test ProcessClient methods
      expect(typeof client.processes.startProcess).toBe('function');
      expect(typeof client.processes.listProcesses).toBe('function');
      expect(typeof client.processes.killProcess).toBe('function');
      expect(typeof client.processes.getSessionId).toBe('function');
      expect(typeof client.processes.setSessionId).toBe('function');
      
      // Test PortClient methods
      expect(typeof client.ports.exposePort).toBe('function');
      expect(typeof client.ports.unexposePort).toBe('function');
      expect(typeof client.ports.getExposedPorts).toBe('function');
      expect(typeof client.ports.getSessionId).toBe('function');
      expect(typeof client.ports.setSessionId).toBe('function');
      
      // Test GitClient methods
      expect(typeof client.git.checkout).toBe('function');
      expect(typeof client.git.getSessionId).toBe('function');
      expect(typeof client.git.setSessionId).toBe('function');
      
      // Test UtilityClient methods
      expect(typeof client.utils.ping).toBe('function');
      expect(typeof client.utils.getCommands).toBe('function');
      expect(typeof client.utils.getSessionId).toBe('function');
      expect(typeof client.utils.setSessionId).toBe('function');
    });

    it('should provide access to all expected domain clients', () => {
      expect(client.commands).toBeInstanceOf(CommandClient);
      expect(client.files).toBeInstanceOf(FileClient);
      expect(client.processes).toBeInstanceOf(ProcessClient);
      expect(client.ports).toBeInstanceOf(PortClient);
      expect(client.git).toBeInstanceOf(GitClient);
      expect(client.utils).toBeInstanceOf(UtilityClient);
    });

    it('should have session management methods on all clients', () => {
      const clients = [
        client.commands,
        client.files,
        client.processes,
        client.ports,
        client.git,
        client.utils
      ];

      clients.forEach(domainClient => {
        expect(typeof domainClient.getSessionId).toBe('function');
        expect(typeof domainClient.setSessionId).toBe('function');
        expect(domainClient.getSessionId()).toBeNull();
      });
    });
  });

  describe('method call parameter validation', () => {
    beforeEach(() => {
      // Create a fresh Response for each test to avoid "Body already read" errors
      fetchMock.mockImplementation(() => 
        Promise.resolve(new Response(JSON.stringify({ 
          success: true, 
          data: {},
          content: 'test content',
          process: { id: 'test-id', pid: 123 }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );
    });

    it('should handle CommandClient method calls with proper parameter validation', async () => {
      // Test execute method
      await client.commands.execute('echo test');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/api/execute',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json'
          }),
          body: expect.stringContaining('echo test')
        })
      );

      fetchMock.mockClear();

      // Test executeStream method - returns Promise<ReadableStream>
      const streamPromise = client.commands.executeStream('echo stream');
      expect(streamPromise).toBeInstanceOf(Promise);
    });

    it('should handle FileClient method calls with proper parameter validation', async () => {
      // Test writeFile method
      await client.files.writeFile('/test.txt', 'content');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/api/write',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json'
          }),
          body: expect.stringContaining('/test.txt')
        })
      );

      fetchMock.mockClear();

      // Test readFile method
      await client.files.readFile('/test.txt');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/api/read',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('/test.txt')
        })
      );

      fetchMock.mockClear();

      // Test deleteFile method
      await client.files.deleteFile('/test.txt');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/api/delete',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('/test.txt')
        })
      );

      fetchMock.mockClear();

      // Test mkdir method
      await client.files.mkdir('/test-dir');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/api/mkdir',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('/test-dir')
        })
      );
    });

    it('should handle ProcessClient method calls with proper parameter validation', async () => {
      // Mock specific response for startProcess that includes process.id
      fetchMock.mockImplementationOnce(() => 
        Promise.resolve(new Response(JSON.stringify({ 
          success: true, 
          process: { id: 'test-process-id', pid: 12345 }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      // Test startProcess method
      await client.processes.startProcess('node app.js', { sessionId: 'test-session' });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/api/process/start',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('node app.js')
        })
      );

      fetchMock.mockClear();

      // Test listProcesses method - Note: GET request, no session support
      await client.processes.listProcesses();
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/api/process/list',
        expect.objectContaining({
          method: 'GET'
        })
      );

      fetchMock.mockClear();

      // Test killProcess method
      await client.processes.killProcess('process-id-123');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/api/process/process-id-123',
        expect.objectContaining({
          method: 'DELETE'
        })
      );
    });

    it('should handle PortClient method calls with proper parameter validation', async () => {
      // Test exposePort method
      await client.ports.exposePort(3000, 'test-service');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/api/expose-port',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('3000')
        })
      );

      fetchMock.mockClear();

      // Test unexposePort method
      await client.ports.unexposePort(3000);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/api/exposed-ports/3000',
        expect.objectContaining({
          method: 'DELETE'
        })
      );

      fetchMock.mockClear();

      // Test getExposedPorts method - Note: GET request, no session support
      await client.ports.getExposedPorts();
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/api/exposed-ports',
        expect.objectContaining({
          method: 'GET'
        })
      );
    });

    it('should handle GitClient method calls with proper parameter validation', async () => {
      // Test checkout method
      await client.git.checkout('https://github.com/user/repo.git', { branch: 'main' });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/api/git/checkout',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('https://github.com/user/repo.git')
        })
      );
    });

    it('should handle UtilityClient method calls with proper parameter validation', async () => {
      // Test ping method - Note: GET request, no session support
      await client.utils.ping();
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/api/ping',
        expect.objectContaining({
          method: 'GET'
        })
      );

      fetchMock.mockClear();

      // Test getCommands method - Note: GET request, no session support
      await client.utils.getCommands();
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/api/commands',
        expect.objectContaining({
          method: 'GET'
        })
      );
    });
  });

  describe('method return type validation', () => {
    it('should return correct types for CommandClient methods', async () => {
      fetchMock.mockImplementation(() => 
        Promise.resolve(new Response(JSON.stringify({
          success: true,
          stdout: 'test output',
          stderr: '',
          exitCode: 0
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      const result = await client.commands.execute('echo test');
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('stdout');
      expect(result).toHaveProperty('stderr');
      expect(result).toHaveProperty('exitCode');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.stdout).toBe('string');
      expect(typeof result.stderr).toBe('string');
      expect(typeof result.exitCode).toBe('number');
    });

    it('should return correct types for FileClient methods', async () => {
      // Test writeFile return type
      fetchMock.mockImplementationOnce(() => 
        Promise.resolve(new Response(JSON.stringify({ 
          success: true, 
          exitCode: 0, 
          path: '/test.txt' 
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      const writeResult = await client.files.writeFile('/test.txt', 'content');
      expect(writeResult).toHaveProperty('success');
      expect(writeResult).toHaveProperty('exitCode');
      expect(writeResult).toHaveProperty('path');
      expect(typeof writeResult.success).toBe('boolean');

      // Test readFile return type
      fetchMock.mockImplementationOnce(() => 
        Promise.resolve(new Response(JSON.stringify({
          success: true,
          content: 'file content',
          path: '/test.txt',
          exitCode: 0
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      const readResult = await client.files.readFile('/test.txt');
      expect(readResult).toHaveProperty('success');
      expect(readResult).toHaveProperty('content');
      expect(readResult).toHaveProperty('path');
      expect(typeof readResult.content).toBe('string');
      expect(typeof readResult.path).toBe('string');
    });

    it('should return correct types for ProcessClient methods', async () => {
      // Test startProcess return type
      fetchMock.mockImplementationOnce(() => 
        Promise.resolve(new Response(JSON.stringify({
          success: true,
          process: { id: 'process-123', pid: 12345, command: 'node app.js' }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      const startResult = await client.processes.startProcess('node app.js');
      expect(startResult).toHaveProperty('success');
      expect(startResult).toHaveProperty('process');
      expect(startResult.process).toHaveProperty('id');
      expect(startResult.process).toHaveProperty('pid');
      expect(typeof startResult.process.id).toBe('string');
      expect(typeof startResult.process.pid).toBe('number');

      // Test listProcesses return type
      fetchMock.mockImplementationOnce(() => 
        Promise.resolve(new Response(JSON.stringify({
          success: true,
          processes: [
            { id: 'proc-1', pid: 123, command: 'node app.js', status: 'running' }
          ],
          count: 1
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      const listResult = await client.processes.listProcesses();
      expect(listResult).toHaveProperty('success');
      expect(listResult).toHaveProperty('processes');
      expect(listResult).toHaveProperty('count');
      expect(Array.isArray(listResult.processes)).toBe(true);
    });

    it('should return correct types for PortClient methods', async () => {
      // Test exposePort return type
      fetchMock.mockImplementationOnce(() => 
        Promise.resolve(new Response(JSON.stringify({
          success: true,
          port: 3000,
          protocol: 'http',
          url: 'http://localhost:3000'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      const exposeResult = await client.ports.exposePort(3000);
      expect(exposeResult).toHaveProperty('success');
      expect(exposeResult).toHaveProperty('port');
      expect(exposeResult).toHaveProperty('exposedAt');
      expect(exposeResult).toHaveProperty('port');
      expect(typeof exposeResult.port).toBe('number');
      expect(typeof exposeResult.exposedAt).toBe('string');
      if (exposeResult.name) {
        expect(typeof exposeResult.name).toBe('string');
      }

      // Test getExposedPorts return type
      fetchMock.mockImplementationOnce(() => 
        Promise.resolve(new Response(JSON.stringify({
          success: true,
          ports: [
            { port: 3000, protocol: 'http', url: 'http://localhost:3000' }
          ]
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      const portsResult = await client.ports.getExposedPorts();
      expect(portsResult).toHaveProperty('success');
      expect(portsResult).toHaveProperty('ports');
      expect(Array.isArray(portsResult.ports)).toBe(true);
    });

    it('should return correct types for GitClient methods', async () => {
      fetchMock.mockImplementationOnce(() => 
        Promise.resolve(new Response(JSON.stringify({
          success: true,
          repoUrl: 'https://github.com/user/repo.git',
          branch: 'main',
          targetDir: 'repo',
          stdout: 'Cloning...',
          stderr: '',
          exitCode: 0
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      const checkoutResult = await client.git.checkout('https://github.com/user/repo.git');
      expect(checkoutResult).toHaveProperty('success');
      expect(checkoutResult).toHaveProperty('repoUrl');
      expect(checkoutResult).toHaveProperty('branch');
      expect(checkoutResult).toHaveProperty('targetDir');
      expect(typeof checkoutResult.branch).toBe('string');
      expect(typeof checkoutResult.repoUrl).toBe('string');
    });

    it('should return correct types for UtilityClient methods', async () => {
      // Test ping return type - returns string message directly
      fetchMock.mockImplementationOnce(() => 
        Promise.resolve(new Response(JSON.stringify({
          success: true,
          message: 'pong',
          timestamp: '2024-01-01T00:00:00Z'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      const pingResult = await client.utils.ping();
      expect(typeof pingResult).toBe('string');
      expect(pingResult).toBe('pong');

      // Test getCommands return type - returns string array directly
      fetchMock.mockImplementationOnce(() => 
        Promise.resolve(new Response(JSON.stringify({
          success: true,
          availableCommands: ['ls', 'pwd', 'echo', 'cat'],
          count: 4
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      const commandsResult = await client.utils.getCommands();
      expect(Array.isArray(commandsResult)).toBe(true);
      expect(commandsResult).toEqual(['ls', 'pwd', 'echo', 'cat']);
    });
  });

  describe('error handling consistency', () => {
    it('should handle client method errors consistently', async () => {
      // Mock error response - create fresh response for each call
      fetchMock.mockImplementation(() => 
        Promise.resolve(new Response(JSON.stringify({
          error: 'Command not found',
          code: 'COMMAND_NOT_FOUND',
          details: 'The specified command does not exist'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      // Test that all client methods handle errors consistently
      await expect(client.commands.execute('nonexistent-command')).rejects.toThrow();
      await expect(client.files.readFile('/nonexistent/file.txt')).rejects.toThrow();
      await expect(client.processes.killProcess('nonexistent-process')).rejects.toThrow();
      await expect(client.ports.unexposePort(99999)).rejects.toThrow();
      await expect(client.git.checkout('nonexistent-branch')).rejects.toThrow();
    });

    it('should propagate error details correctly across all clients', async () => {
      const errorResponse = {
        error: 'File not found',
        code: 'FILE_NOT_FOUND',
        path: '/test/file.txt',
        operation: 'FILE_READ'
      };

      fetchMock.mockImplementation(() => 
        Promise.resolve(new Response(JSON.stringify(errorResponse), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      try {
        await client.files.readFile('/test/file.txt');
        expect.fail('Expected error to be thrown');
      } catch (error: any) {
        // Verify error contains expected details from container
        expect(error.message).toContain('File not found');
        // Additional error properties depend on error mapping implementation
      }
    });
  });

  describe('async method behavior', () => {
    it('should handle async operations correctly', async () => {
      fetchMock.mockImplementation(() => 
        Promise.resolve(new Response(JSON.stringify({ 
          success: true,
          process: { id: 'test-process', pid: 123 }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      // Test that all methods return promises
      const executePromise = client.commands.execute('echo test');
      const writePromise = client.files.writeFile('/test.txt', 'content');
      const startPromise = client.processes.startProcess('node app.js');
      const exposePromise = client.ports.exposePort(3000);
      const checkoutPromise = client.git.checkout('https://github.com/user/repo.git');
      const pingPromise = client.utils.ping();

      expect(executePromise).toBeInstanceOf(Promise);
      expect(writePromise).toBeInstanceOf(Promise);
      expect(startPromise).toBeInstanceOf(Promise);
      expect(exposePromise).toBeInstanceOf(Promise);
      expect(checkoutPromise).toBeInstanceOf(Promise);
      expect(pingPromise).toBeInstanceOf(Promise);

      // Verify all promises resolve
      await Promise.all([
        executePromise,
        writePromise,
        startPromise,
        exposePromise,
        checkoutPromise,
        pingPromise
      ]);
    });

    it('should handle streaming methods correctly', async () => {
      // Mock a readable stream response for executeStream
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('test'));
          controller.close();
        }
      });

      fetchMock.mockImplementationOnce(() => 
        Promise.resolve(new Response(mockStream, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' }
        }))
      );

      // Test streaming methods return Promise<ReadableStream>
      const executeStreamPromise = client.commands.executeStream('echo test');
      expect(executeStreamPromise).toBeInstanceOf(Promise);
      
      const stream = await executeStreamPromise;
      expect(stream).toBeInstanceOf(ReadableStream);
    });
  });
});