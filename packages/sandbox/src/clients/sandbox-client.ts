import { CommandClient } from './command-client';
import { FileClient } from './file-client';
import { ProcessClient } from './process-client';
import { PortClient } from './port-client';
import { GitClient } from './git-client';
import { UtilityClient } from './utility-client';
import type { HttpClientOptions } from './types';

/**
 * Main sandbox client that composes all domain-specific clients
 * Provides organized access to all sandbox functionality
 */
export class SandboxClient {
  public readonly commands: CommandClient;
  public readonly files: FileClient;
  public readonly processes: ProcessClient;
  public readonly ports: PortClient;
  public readonly git: GitClient;
  public readonly utils: UtilityClient;

  constructor(options: HttpClientOptions = {}) {
    // Ensure baseUrl is provided for all clients
    const clientOptions = {
      baseUrl: 'http://localhost:3000',
      ...options,
    };

    // Initialize all domain clients with shared options
    this.commands = new CommandClient(clientOptions);
    this.files = new FileClient(clientOptions);
    this.processes = new ProcessClient(clientOptions);
    this.ports = new PortClient(clientOptions);
    this.git = new GitClient(clientOptions);
    this.utils = new UtilityClient(clientOptions);
  }

  /**
   * Set session ID for all clients
   */
  public setSessionId(sessionId: string | null): void {
    this.commands.setSessionId(sessionId);
    this.files.setSessionId(sessionId);
    this.processes.setSessionId(sessionId);
    this.ports.setSessionId(sessionId);
    this.git.setSessionId(sessionId);
    this.utils.setSessionId(sessionId);
  }

  /**
   * Get session ID from the command client (all clients share the same session)
   */
  public getSessionId(): string | null {
    return this.commands.getSessionId();
  }

  /**
   * Ping the sandbox to verify connectivity
   */
  async ping(): Promise<string> {
    return this.utils.ping();
  }

  /**
   * Get basic information about the sandbox
   */
  async getInfo(): Promise<{
    ping: string;
    commands: string[];
    exposedPorts: number;
    runningProcesses: number;
  }> {
    try {
      const [pingResult, commandsResult, portsResult, processesResult] = await Promise.all([
        this.utils.ping(),
        this.utils.getCommands(),
        this.ports.getExposedPorts(),
        this.processes.listProcesses(),
      ]);

      return {
        ping: pingResult,
        commands: commandsResult,
        exposedPorts: portsResult.count,
        runningProcesses: processesResult.processes.filter(p => p.status === 'running').length,
      };
    } catch (error) {
      console.error('[SandboxClient] Error getting sandbox info:', error);
      throw error;
    }
  }
}