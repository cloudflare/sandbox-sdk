import { SandboxClient } from '../../clients/sandbox-client';
import { CommandClient } from '../../clients/command-client';
import { FileClient } from '../../clients/file-client';
import { ProcessClient } from '../../clients/process-client';
import { PortClient } from '../../clients/port-client';
import { GitClient } from '../../clients/git-client';
import { UtilityClient } from '../../clients/utility-client';

describe('SandboxClient', () => {
  let client: SandboxClient;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    
    client = new SandboxClient({
      baseUrl: 'http://test-sandbox.com',
      port: 3000,
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe('initialization', () => {
    it('should create all domain clients', () => {
      expect(client.commands).toBeInstanceOf(CommandClient);
      expect(client.files).toBeInstanceOf(FileClient);
      expect(client.processes).toBeInstanceOf(ProcessClient);
      expect(client.ports).toBeInstanceOf(PortClient);
      expect(client.git).toBeInstanceOf(GitClient);
      expect(client.utils).toBeInstanceOf(UtilityClient);
    });

    it('should use default baseUrl if not provided', () => {
      const defaultClient = new SandboxClient();
      expect(defaultClient.commands).toBeInstanceOf(CommandClient);
    });

    it('should pass options to all clients', () => {
      const options = {
        baseUrl: 'http://custom.com',
        port: 8080,
        onCommandComplete: vi.fn(),
        onError: vi.fn(),
      };

      const customClient = new SandboxClient(options);
      expect(customClient.commands).toBeInstanceOf(CommandClient);
      expect(customClient.files).toBeInstanceOf(FileClient);
    });
  });

  describe('session management', () => {
    it('should set session ID for all clients', () => {
      const sessionId = 'test-session-123';
      
      client.setSessionId(sessionId);
      
      expect(client.getSessionId()).toBe(sessionId);
    });

    it('should clear session ID for all clients', () => {
      client.setSessionId('test-session');
      expect(client.getSessionId()).toBe('test-session');
      
      client.setSessionId(null);
      expect(client.getSessionId()).toBeNull();
    });
  });

  describe('convenience methods', () => {
    it('should delegate ping to utils client', async () => {
      const pingResponse = {
        success: true,
        message: 'pong',
        timestamp: '2023-01-01T00:00:00Z'
      };
      
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(pingResponse), { status: 200 }));
      
      const result = await client.ping();
      
      expect(result).toBe('pong');
    });

    it('should provide sandbox info from multiple clients', async () => {
      // Mock all HTTP requests with correct response formats
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify({
          success: true,
          message: 'alive',
          timestamp: '2023-01-01T00:00:00Z'
        }), { status: 200 })) // ping
        .mockResolvedValueOnce(new Response(JSON.stringify({
          success: true,
          availableCommands: ['ls', 'cat', 'echo'],
          count: 3,
          timestamp: '2023-01-01T00:00:00Z'
        }), { status: 200 })) // getCommands
        .mockResolvedValueOnce(new Response(JSON.stringify({
          success: true,
          ports: [{
            port: 3001,
            url: 'http://preview.com',
            name: 'web',
            isActive: true,
            exposedAt: '2023-01-01T00:00:00Z'
          }],
          count: 1,
          timestamp: '2023-01-01T00:00:00Z'
        }), { status: 200 })) // getExposedPorts
        .mockResolvedValueOnce(new Response(JSON.stringify({
          success: true,
          processes: [
            {
              id: 'proc1',
              command: 'npm start',
              status: 'running',
              startTime: '2023-01-01T00:00:00Z'
            },
            {
              id: 'proc2', 
              command: 'npm test',
              status: 'completed',
              startTime: '2023-01-01T00:00:00Z',
              endTime: '2023-01-01T00:01:00Z'
            }
          ],
          count: 2,
          timestamp: '2023-01-01T00:00:00Z'
        }), { status: 200 })); // listProcesses

      const info = await client.getInfo();

      expect(info).toEqual({
        ping: 'alive',
        commands: ['ls', 'cat', 'echo'],
        exposedPorts: 1,
        runningProcesses: 1, // Only running processes
      });
    });

    it('should handle errors in getInfo gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      fetchMock.mockRejectedValueOnce(new Error('Connection failed'));
      
      await expect(client.getInfo()).rejects.toThrow('Connection failed');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[SandboxClient] Error getting sandbox info:',
        expect.any(Error)
      );
      
      consoleErrorSpy.mockRestore();
    });
  });

  describe('client composition', () => {
    it('should provide organized API structure', () => {
      // Verify the clean API structure
      expect(typeof client.commands.execute).toBe('function');
      expect(typeof client.commands.executeStream).toBe('function');
      
      expect(typeof client.files.writeFile).toBe('function');
      expect(typeof client.files.readFile).toBe('function');
      expect(typeof client.files.deleteFile).toBe('function');
      
      expect(typeof client.processes.startProcess).toBe('function');
      expect(typeof client.processes.listProcesses).toBe('function');
      expect(typeof client.processes.killProcess).toBe('function');
      
      expect(typeof client.ports.exposePort).toBe('function');
      expect(typeof client.ports.unexposePort).toBe('function');
      
      expect(typeof client.git.checkout).toBe('function');
      
      expect(typeof client.utils.ping).toBe('function');
      expect(typeof client.utils.getCommands).toBe('function');
    });
  });
});