import { Container, getContainer } from "@cloudflare/containers";
import { SandboxClient } from "./clients";
import { isLocalhostPattern } from "./request-handler";
import {
  logSecurityEvent,
  SecurityError,
  sanitizeSandboxId,
  validatePort
} from "./security";
import type {
  ExecOptions,
  ExecResult,
  ExecEvent,
  ISandbox,
  Process,
  ProcessOptions,
  ProcessStatus,
  StreamOptions
} from "./types";
import {
  ProcessNotFoundError,
  SandboxError
} from "./errors";

export function getSandbox(ns: DurableObjectNamespace<Sandbox>, id: string) {
  const stub = getContainer(ns, id);

  // Store the name on first access
  stub.setSandboxName?.(id);

  return stub;
}

export class Sandbox<Env = unknown> extends Container<Env> implements ISandbox {
  defaultPort = 3000; // Default port for the container's Bun server
  sleepAfter = "3m"; // Sleep the sandbox if no requests are made in this timeframe
  client: SandboxClient;
  private sandboxName: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.client = new SandboxClient({
      onCommandComplete: (success, exitCode, _stdout, _stderr, command) => {
        console.log(
          `[Container] Command completed: ${command}, Success: ${success}, Exit code: ${exitCode}`
        );
      },
      onError: (error, _command) => {
        console.error(`[Container] Command error: ${error}`);
      },
      port: 3000, // Control plane port
      stub: this,
    });

    // Load the sandbox name from storage on initialization
    this.ctx.blockConcurrencyWhile(async () => {
      this.sandboxName = await this.ctx.storage.get<string>('sandboxName') || null;
    });
  }

  // RPC method to set the sandbox name
  async setSandboxName(name: string): Promise<void> {
    if (!this.sandboxName) {
      this.sandboxName = name;
      await this.ctx.storage.put('sandboxName', name);
      console.log(`[Sandbox] Stored sandbox name via RPC: ${name}`);
    }
  }

  // RPC method to set environment variables
  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.envVars = { ...this.envVars, ...envVars };
    console.log(`[Sandbox] Updated environment variables`);
  }

  override onStart() {
    console.log("Sandbox successfully started");
  }

  override onStop() {
    console.log("Sandbox successfully shut down");
    if (this.client) {
      this.client.setSessionId(null);
    }
  }

  override onError(error: unknown) {
    console.log("Sandbox error:", error);
  }

  // Override fetch to route internal container requests to appropriate ports
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Capture and store the sandbox name from the header if present
    if (!this.sandboxName && request.headers.has('X-Sandbox-Name')) {
      const name = request.headers.get('X-Sandbox-Name')!;
      this.sandboxName = name;
      await this.ctx.storage.put('sandboxName', name);
      console.log(`[Sandbox] Stored sandbox name: ${this.sandboxName}`);
    }

    // Determine which port to route to
    const port = this.determinePort(url);

    // Route to the appropriate port
    return await this.containerFetch(request, port);
  }

  private determinePort(url: URL): number {
    // Extract port from proxy requests (e.g., /proxy/8080/*)
    const proxyMatch = url.pathname.match(/^\/proxy\/(\d+)/);
    if (proxyMatch) {
      return parseInt(proxyMatch[1]);
    }

    // All other requests go to control plane on port 3000
    // This includes /api/* endpoints and any other control requests
    return 3000;
  }

  // Enhanced exec method - always returns ExecResult with optional streaming
  // This replaces the old exec method to match ISandbox interface
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    // Handle timeout
    let timeoutId: NodeJS.Timeout | undefined;

    try {
      // Handle cancellation
      if (options?.signal?.aborted) {
        throw new Error('Operation was aborted');
      }

      let result: ExecResult;

      if (options?.stream && options?.onOutput) {
        // Streaming with callbacks - we need to collect the final result
        result = await this.executeWithStreaming(command, options, startTime, timestamp);
      } else {
        // Regular execution
        const response = await this.client.commands.execute(
          command,
          options?.sessionId
        );

        const duration = Date.now() - startTime;
        result = this.mapExecuteResponseToExecResult(response, duration, options?.sessionId);
      }

      // Call completion callback if provided
      if (options?.onComplete) {
        options.onComplete(result);
      }

      return result;
    } catch (error) {
      if (options?.onError && error instanceof Error) {
        options.onError(error);
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async executeWithStreaming(
    command: string,
    options: ExecOptions,
    startTime: number,
    timestamp: string
  ): Promise<ExecResult> {
    let stdout = '';
    let stderr = '';

    try {
      const stream = await this.client.commands.executeStream(command, options.sessionId);
      const { parseSSEStream } = await import('./sse-parser');

      for await (const event of parseSSEStream<ExecEvent>(stream)) {
        // Check for cancellation
        if (options.signal?.aborted) {
          throw new Error('Operation was aborted');
        }

        switch (event.type) {
          case 'stdout':
          case 'stderr':
            if (event.data) {
              // Update accumulated output
              if (event.type === 'stdout') stdout += event.data;
              if (event.type === 'stderr') stderr += event.data;

              // Call user's callback
              if (options.onOutput) {
                options.onOutput(event.type, event.data);
              }
            }
            break;

          case 'complete': {
            // Use result from complete event if available
            const duration = Date.now() - startTime;
            return {
              success: (event.exitCode ?? 0) === 0,
              exitCode: event.exitCode ?? 0,
              stdout,
              stderr,
              command,
              duration,
              timestamp,
              sessionId: options.sessionId
            };
          }

          case 'error':
            throw new Error(event.data || 'Command execution failed');
        }
      }

      // If we get here without a complete event, something went wrong
      throw new Error('Stream ended without completion event');

    } catch (error) {
      if (options.signal?.aborted) {
        throw new Error('Operation was aborted');
      }
      throw error;
    }
  }

  private mapExecuteResponseToExecResult(
    response: import('./clients').ExecuteResponse,
    duration: number,
    sessionId?: string
  ): ExecResult {
    return {
      success: response.success,
      exitCode: response.exitCode,
      stdout: response.stdout,
      stderr: response.stderr,
      command: response.command,
      duration,
      timestamp: response.timestamp,
      sessionId
    };
  }


  // Background process management
  async startProcess(command: string, options?: ProcessOptions): Promise<Process> {
    // Use the new HttpClient method to start the process
    try {
      const response = await this.client.processes.startProcess(command, {
        processId: options?.processId,
        sessionId: options?.sessionId
      });

      const process = response.process;
      const processObj: Process = {
        id: process.id,
        pid: process.pid,
        command: process.command,
        status: process.status as ProcessStatus,
        startTime: new Date(process.startTime),
        endTime: undefined,
        exitCode: undefined,
        sessionId: options?.sessionId,

        async kill(): Promise<void> {
          throw new Error('Method will be replaced');
        },
        async getStatus(): Promise<ProcessStatus> {
          throw new Error('Method will be replaced');
        },
        async getLogs(): Promise<{ stdout: string; stderr: string }> {
          throw new Error('Method will be replaced');
        }
      };

      // Bind context properly
      processObj.kill = async (signal?: string) => {
        await this.killProcess(process.id, signal);
      };

      processObj.getStatus = async () => {
        const current = await this.getProcess(process.id);
        return current?.status || 'error';
      };

      processObj.getLogs = async () => {
        const logs = await this.getProcessLogs(process.id);
        return { stdout: logs.stdout, stderr: logs.stderr };
      };

      // Call onStart callback if provided
      if (options?.onStart) {
        options.onStart(processObj);
      }

      return processObj;

    } catch (error) {
      if (options?.onError && error instanceof Error) {
        options.onError(error);
      }

      throw error;
    }
  }

  async listProcesses(): Promise<Process[]> {
    const response = await this.client.processes.listProcesses();

    return response.processes.map(processData => ({
      id: processData.id,
      pid: processData.pid,
      command: processData.command,
      status: processData.status,
      startTime: new Date(processData.startTime),
      endTime: processData.endTime ? new Date(processData.endTime) : undefined,
      exitCode: processData.exitCode,
      sessionId: undefined, // Process list doesn't include sessionId from backend

      kill: async (signal?: string) => {
        await this.killProcess(processData.id, signal);
      },

      getStatus: async () => {
        const current = await this.getProcess(processData.id);
        return current?.status || 'error';
      },

      getLogs: async () => {
        const logs = await this.getProcessLogs(processData.id);
        return { stdout: logs.stdout, stderr: logs.stderr };
      }
    }));
  }

  async getProcess(id: string): Promise<Process | null> {
    const response = await this.client.processes.getProcess(id);
    if (!response.process) {
      return null;
    }

    const processData = response.process;
    return {
      id: processData.id,
      pid: processData.pid,
      command: processData.command,
      status: processData.status,
      startTime: new Date(processData.startTime),
      endTime: processData.endTime ? new Date(processData.endTime) : undefined,
      exitCode: processData.exitCode,
      sessionId: undefined, // Individual process doesn't include sessionId from backend

      kill: async (signal?: string) => {
        await this.killProcess(processData.id, signal);
      },

      getStatus: async () => {
        const current = await this.getProcess(processData.id);
        return current?.status || 'error';
      },

      getLogs: async () => {
        const logs = await this.getProcessLogs(processData.id);
        return { stdout: logs.stdout, stderr: logs.stderr };
      }
    };
  }

  async killProcess(id: string, _signal?: string): Promise<void> {
    try {
      // Note: signal parameter is not currently supported by the HttpClient implementation
      await this.client.processes.killProcess(id);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Process not found')) {
        throw new ProcessNotFoundError(id);
      }
      throw new SandboxError(
        `Failed to kill process ${id}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'KILL_PROCESS_FAILED'
      );
    }
  }

  async killAllProcesses(): Promise<number> {
    const response = await this.client.processes.killAllProcesses();
    return response.killedCount;
  }

  async cleanupCompletedProcesses(): Promise<number> {
    // For now, this would need to be implemented as a container endpoint
    // as we no longer maintain local process storage
    // We'll return 0 as a placeholder until the container endpoint is added
    return 0;
  }

  async getProcessLogs(id: string): Promise<{ stdout: string; stderr: string; processId: string }> {
    try {
      const response = await this.client.processes.getProcessLogs(id);
      return {
        stdout: response.stdout,
        stderr: response.stderr,
        processId: response.processId
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('Process not found')) {
        throw new ProcessNotFoundError(id);
      }
      throw error;
    }
  }


  // Streaming methods - return ReadableStream for RPC compatibility
  async execStream(command: string, options?: StreamOptions): Promise<ReadableStream<Uint8Array>> {
    // Check for cancellation
    if (options?.signal?.aborted) {
      throw new Error('Operation was aborted');
    }

    // Get the stream from CommandClient
    return this.client.commands.executeStream(command, options?.sessionId);
  }

  async streamProcessLogs(processId: string, options?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>> {
    // Check for cancellation
    if (options?.signal?.aborted) {
      throw new Error('Operation was aborted');
    }

    // Get the stream from ProcessClient
    return this.client.processes.streamProcessLogs(processId);
  }

  async gitCheckout(
    repoUrl: string,
    options: { branch?: string; targetDir?: string }
  ) {
    return this.client.git.checkout(repoUrl, { 
      branch: options.branch, 
      targetDir: options.targetDir 
    });
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean } = {}
  ) {
    return this.client.files.mkdir(path, { recursive: options.recursive });
  }

  async writeFile(
    path: string,
    content: string,
    options: { encoding?: string } = {}
  ) {
    return this.client.files.writeFile(path, content, { encoding: options.encoding });
  }

  async deleteFile(path: string) {
    return this.client.files.deleteFile(path);
  }

  async renameFile(
    oldPath: string,
    newPath: string
  ) {
    return this.client.files.renameFile(oldPath, newPath);
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string
  ) {
    return this.client.files.moveFile(sourcePath, destinationPath);
  }

  async readFile(
    path: string,
    options: { encoding?: string } = {}
  ) {
    return this.client.files.readFile(path, { encoding: options.encoding });
  }

  async exposePort(port: number, options: { name?: string; hostname: string }) {
    await this.client.ports.exposePort(port, options?.name);

    // We need the sandbox name to construct preview URLs
    if (!this.sandboxName) {
      throw new Error('Sandbox name not available. Ensure sandbox is accessed through getSandbox()');
    }

    const url = this.constructPreviewUrl(port, this.sandboxName, options.hostname);

    return {
      url,
      port,
      name: options?.name,
    };
  }

  async unexposePort(port: number) {
    if (!validatePort(port)) {
      logSecurityEvent('INVALID_PORT_UNEXPOSE', {
        port
      }, 'high');
      throw new SecurityError(`Invalid port number: ${port}. Must be between 1024-65535 and not reserved.`);
    }

    await this.client.ports.unexposePort(port);

    logSecurityEvent('PORT_UNEXPOSED', {
      port
    }, 'low');
  }

  async getExposedPorts(hostname: string) {
    const response = await this.client.ports.getExposedPorts();

    // We need the sandbox name to construct preview URLs
    if (!this.sandboxName) {
      throw new Error('Sandbox name not available. Ensure sandbox is accessed through getSandbox()');
    }

    return response.ports.map(port => ({
      url: this.constructPreviewUrl(port.port, this.sandboxName!, hostname),
      port: port.port,
      name: port.name,
      exposedAt: port.exposedAt,
    }));
  }


  private constructPreviewUrl(port: number, sandboxId: string, hostname: string): string {
    if (!validatePort(port)) {
      logSecurityEvent('INVALID_PORT_REJECTED', {
        port,
        sandboxId,
        hostname
      }, 'high');
      throw new SecurityError(`Invalid port number: ${port}. Must be between 1024-65535 and not reserved.`);
    }

    let sanitizedSandboxId: string;
    try {
      sanitizedSandboxId = sanitizeSandboxId(sandboxId);
    } catch (error) {
      logSecurityEvent('INVALID_SANDBOX_ID_REJECTED', {
        sandboxId,
        port,
        hostname,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 'high');
      throw error;
    }

    const isLocalhost = isLocalhostPattern(hostname);

    if (isLocalhost) {
      // Unified subdomain approach for localhost (RFC 6761)
      const [host, portStr] = hostname.split(':');
      const mainPort = portStr || '80';

      // Use URL constructor for safe URL building
      try {
        const baseUrl = new URL(`http://${host}:${mainPort}`);
        // Construct subdomain safely
        const subdomainHost = `${port}-${sanitizedSandboxId}.${host}`;
        baseUrl.hostname = subdomainHost;

        const finalUrl = baseUrl.toString();

        logSecurityEvent('PREVIEW_URL_CONSTRUCTED', {
          port,
          sandboxId: sanitizedSandboxId,
          hostname,
          resultUrl: finalUrl,
          environment: 'localhost'
        }, 'low');

        return finalUrl;
      } catch (error) {
        logSecurityEvent('URL_CONSTRUCTION_FAILED', {
          port,
          sandboxId: sanitizedSandboxId,
          hostname,
          error: error instanceof Error ? error.message : 'Unknown error'
        }, 'high');
        throw new SecurityError(`Failed to construct preview URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Production subdomain logic - enforce HTTPS
    try {
      // Always use HTTPS for production (non-localhost)
      const protocol = "https";
      const baseUrl = new URL(`${protocol}://${hostname}`);

      // Construct subdomain safely
      const subdomainHost = `${port}-${sanitizedSandboxId}.${hostname}`;
      baseUrl.hostname = subdomainHost;

      const finalUrl = baseUrl.toString();

      logSecurityEvent('PREVIEW_URL_CONSTRUCTED', {
        port,
        sandboxId: sanitizedSandboxId,
        hostname,
        resultUrl: finalUrl,
        environment: 'production'
      }, 'low');

      return finalUrl;
    } catch (error) {
      logSecurityEvent('URL_CONSTRUCTION_FAILED', {
        port,
        sandboxId: sanitizedSandboxId,
        hostname,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 'high');
      throw new SecurityError(`Failed to construct preview URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
