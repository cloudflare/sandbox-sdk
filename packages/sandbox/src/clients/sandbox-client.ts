import { BaseHttpClient } from './base-client';
import { CommandClient } from './command-client';
import { FileClient } from './file-client';
import { GitClient } from './git-client';
import { PortClient } from './port-client';
import { ProcessClient } from './process-client';
import type { BaseApiResponse, HttpClientOptions } from './types';
import { UtilityClient } from './utility-client';

/**
 * Request interface for creating sessions
 */
export interface CreateSessionRequest {
  id: string;
  env?: Record<string, string>;
  cwd?: string;
  isolation?: boolean;
}

/**
 * Response interface for creating sessions
 */
export interface CreateSessionResponse extends BaseApiResponse {
  id: string;
  message: string;
}

/**
 * Main sandbox client that composes all domain-specific clients
 * Provides organized access to all sandbox functionality
 */
export class SandboxClient extends BaseHttpClient {
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

    // Call parent constructor
    super(clientOptions);

    // Initialize all domain clients with shared options
    this.commands = new CommandClient(clientOptions);
    this.files = new FileClient(clientOptions);
    this.processes = new ProcessClient(clientOptions);
    this.ports = new PortClient(clientOptions);
    this.git = new GitClient(clientOptions);
    this.utils = new UtilityClient(clientOptions);
  }

  /**
   * Create a new session in the container
   * This establishes a persistent session context for command execution
   */
  async createSession(options: {
    id: string;
    env?: Record<string, string>;
    cwd?: string;
    isolation?: boolean;
  }): Promise<CreateSessionResponse> {
    try {
      const data: CreateSessionRequest = {
        id: options.id,
        env: options.env,
        cwd: options.cwd || '/workspace',
        isolation: options.isolation !== false, // Default to true
      };

      const response = await this.post<CreateSessionResponse>('/api/session/create', data);
      
      this.logSuccess('Session created', `${options.id} (isolation: ${data.isolation})`);
      
      return response;
    } catch (error) {
      this.logError('createSession', error);
      throw error;
    }
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