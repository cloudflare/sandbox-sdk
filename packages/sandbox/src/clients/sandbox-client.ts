import { CommandClient } from './command-client';
import { FileClient } from './file-client';
import { GitClient } from './git-client';
import { InterpreterClient } from './interpreter-client';
import { PortClient } from './port-client';
import { ProcessClient } from './process-client';
import type { HttpClientOptions } from './types';
import { UtilityClient } from './utility-client';

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
  public readonly interpreter: InterpreterClient;
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
    this.interpreter = new InterpreterClient(clientOptions);
    this.utils = new UtilityClient(clientOptions);
  }


}