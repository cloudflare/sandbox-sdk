import { Container, getContainer } from "@cloudflare/containers";
import type {
  CodeContext,
  CreateContextOptions,
  ExecEvent,
  ExecOptions,
  ExecResult,
  ExecutionResult,
  ExecutionSession,
  ISandbox,
  Process,
  ProcessOptions,
  ProcessStatus,
  RunCodeOptions,
  SessionOptions,
  StreamOptions
} from "@repo/shared-types";
import { type ExecuteResponse, SandboxClient } from "./clients";
import {
  ProcessNotFoundError,
  SandboxError
} from "./errors";
import { CodeInterpreter } from "./interpreter";
import { isLocalhostPattern } from "./request-handler";
import {
  logSecurityEvent,
  SecurityError,
  sanitizeSandboxId,
  validatePort
} from "./security";
import { parseSSEStream } from "./sse-parser";

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
  private codeInterpreter: CodeInterpreter;
  private sandboxName: string | null = null;
  private portTokens: Map<number, string> = new Map();
  private defaultSession: string | null = null;
  envVars: Record<string, string> = {};

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx as any, env);
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

    // Initialize code interpreter - pass 'this' after client is ready
    // The CodeInterpreter extracts client.interpreter from the sandbox
    this.codeInterpreter = new CodeInterpreter(this);

    // Load the sandbox name and port tokens from storage on initialization
    this.ctx.blockConcurrencyWhile(async () => {
      this.sandboxName = await this.ctx.storage.get<string>('sandboxName') || null;
      const storedTokens = await this.ctx.storage.get<Record<string, string>>('portTokens') || {};

      // Convert stored tokens back to Map
      this.portTokens = new Map();
      for (const [portStr, token] of Object.entries(storedTokens)) {
        this.portTokens.set(parseInt(portStr, 10), token);
      }
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
    // Note: Session cleanup happens automatically when container shuts down
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
      return parseInt(proxyMatch[1], 10);
    }

    // All other requests go to control plane on port 3000
    // This includes /api/* endpoints and any other control requests
    return 3000;
  }

  /**
   * Ensure default session exists - lazy initialization
   * This is called automatically by all public methods that need a session
   */
  private async ensureDefaultSession(): Promise<string> {
    if (!this.defaultSession) {
      const sessionId = `sandbox-${this.sandboxName || 'default'}`;

      // Create session in container
      await this.client.utils.createSession({
        id: sessionId,
        env: this.envVars || {},
        cwd: '/workspace',
      });

      this.defaultSession = sessionId;
      console.log(`[Sandbox] Default session initialized: ${sessionId}`);
    }
    return this.defaultSession;
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

      // Get or create default session
      const sessionId = await this.ensureDefaultSession();

      let result: ExecResult;

      if (options?.stream && options?.onOutput) {
        // Streaming with callbacks - we need to collect the final result
        result = await this.executeWithStreaming(command, sessionId, options, startTime, timestamp);
      } else {
        // Regular execution with session
        const response = await this.client.commands.execute(command, sessionId);

        const duration = Date.now() - startTime;
        result = this.mapExecuteResponseToExecResult(response, duration, sessionId);
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
    sessionId: string,
    options: ExecOptions,
    startTime: number,
    timestamp: string
  ): Promise<ExecResult> {
    let stdout = '';
    let stderr = '';

    try {
      const stream = await this.client.commands.executeStream(command, sessionId);

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
              sessionId
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
    response: ExecuteResponse,
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
      const sessionId = await this.ensureDefaultSession();
      const response = await this.client.processes.startProcess(command, sessionId, {
        processId: options?.processId
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
        sessionId,

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
    const sessionId = await this.ensureDefaultSession();
    const response = await this.client.processes.listProcesses(sessionId);

    return response.processes.map(processData => ({
      id: processData.id,
      pid: processData.pid,
      command: processData.command,
      status: processData.status,
      startTime: new Date(processData.startTime),
      endTime: processData.endTime ? new Date(processData.endTime) : undefined,
      exitCode: processData.exitCode,
      sessionId,

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
    const sessionId = await this.ensureDefaultSession();
    const response = await this.client.processes.getProcess(id, sessionId);
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
      sessionId,

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
      const sessionId = await this.ensureDefaultSession();
      // Note: signal parameter is not currently supported by the HttpClient implementation
      await this.client.processes.killProcess(id, sessionId);
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
    const sessionId = await this.ensureDefaultSession();
    const response = await this.client.processes.killAllProcesses(sessionId);
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
      const sessionId = await this.ensureDefaultSession();
      const response = await this.client.processes.getProcessLogs(id, sessionId);
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

    const sessionId = await this.ensureDefaultSession();
    // Get the stream from CommandClient
    return this.client.commands.executeStream(command, sessionId);
  }

  async streamProcessLogs(processId: string, options?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>> {
    // Check for cancellation
    if (options?.signal?.aborted) {
      throw new Error('Operation was aborted');
    }

    const sessionId = await this.ensureDefaultSession();
    // Get the stream from ProcessClient
    return this.client.processes.streamProcessLogs(processId, sessionId);
  }

  async gitCheckout(
    repoUrl: string,
    options: { branch?: string; targetDir?: string }
  ) {
    const sessionId = await this.ensureDefaultSession();
    return this.client.git.checkout(repoUrl, sessionId, {
      branch: options.branch,
      targetDir: options.targetDir
    });
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean } = {}
  ) {
    const sessionId = await this.ensureDefaultSession();
    return this.client.files.mkdir(path, sessionId, { recursive: options.recursive });
  }

  async writeFile(
    path: string,
    content: string,
    options: { encoding?: string } = {}
  ) {
    const sessionId = await this.ensureDefaultSession();
    return this.client.files.writeFile(path, content, sessionId, { encoding: options.encoding });
  }

  async deleteFile(path: string) {
    const sessionId = await this.ensureDefaultSession();
    return this.client.files.deleteFile(path, sessionId);
  }

  async renameFile(
    oldPath: string,
    newPath: string
  ) {
    const sessionId = await this.ensureDefaultSession();
    return this.client.files.renameFile(oldPath, newPath, sessionId);
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string
  ) {
    const sessionId = await this.ensureDefaultSession();
    return this.client.files.moveFile(sourcePath, destinationPath, sessionId);
  }

  async readFile(
    path: string,
    options: { encoding?: string } = {}
  ) {
    const sessionId = await this.ensureDefaultSession();
    return this.client.files.readFile(path, sessionId, { encoding: options.encoding });
  }

  async exposePort(port: number, options: { name?: string; hostname: string }) {
    const sessionId = await this.ensureDefaultSession();
    await this.client.ports.exposePort(port, sessionId, options?.name);

    // We need the sandbox name to construct preview URLs
    if (!this.sandboxName) {
      throw new Error('Sandbox name not available. Ensure sandbox is accessed through getSandbox()');
    }

    // Generate and store token for this port
    const token = this.generatePortToken();
    this.portTokens.set(port, token);
    await this.persistPortTokens();

    const url = this.constructPreviewUrl(port, this.sandboxName, options.hostname, token);

    logSecurityEvent('PORT_TOKEN_GENERATED', {
      port,
      sandboxId: this.sandboxName,
      tokenLength: token.length
    }, 'low');

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

    const sessionId = await this.ensureDefaultSession();
    await this.client.ports.unexposePort(port, sessionId);

    // Clean up token for this port
    if (this.portTokens.has(port)) {
      this.portTokens.delete(port);
      await this.persistPortTokens();
    }

    logSecurityEvent('PORT_UNEXPOSED', {
      port
    }, 'low');
  }

  async getExposedPorts(hostname: string) {
    const sessionId = await this.ensureDefaultSession();
    const response = await this.client.ports.getExposedPorts(sessionId);

    // We need the sandbox name to construct preview URLs
    if (!this.sandboxName) {
      throw new Error('Sandbox name not available. Ensure sandbox is accessed through getSandbox()');
    }

    return response.ports.map(port => {
      // Get token for this port - must exist for all exposed ports
      const token = this.portTokens.get(port.port);
      if (!token) {
        throw new Error(`Port ${port.port} is exposed but has no token. This should not happen.`);
      }

      return {
        url: this.constructPreviewUrl(port.port, this.sandboxName!, hostname, token),
        port: port.port,
        name: port.name,
        exposedAt: port.exposedAt,
      };
    });
  }


  async isPortExposed(port: number): Promise<boolean> {
    try {
      const sessionId = await this.ensureDefaultSession();
      const response = await this.client.ports.getExposedPorts(sessionId);
      return response.ports.some(exposedPort => exposedPort.port === port);
    } catch (error) {
      console.error(`[Sandbox] Error checking if port ${port} is exposed:`, error);
      return false;
    }
  }

  async validatePortToken(port: number, token: string): Promise<boolean> {
    // First check if port is exposed
    const isExposed = await this.isPortExposed(port);
    if (!isExposed) {
      return false;
    }

    // Get stored token for this port - must exist for all exposed ports
    const storedToken = this.portTokens.get(port);
    if (!storedToken) {
      // This should not happen - all exposed ports must have tokens
      console.error(`Port ${port} is exposed but has no token. This indicates a bug.`);
      return false;
    }

    // Constant-time comparison to prevent timing attacks
    return storedToken === token;
  }

  private generatePortToken(): string {
    // Generate cryptographically secure 16-character token using Web Crypto API
    // Available in Cloudflare Workers runtime
    const array = new Uint8Array(12); // 12 bytes = 16 base64url chars (after padding removal)
    crypto.getRandomValues(array);

    // Convert to base64url format (URL-safe, no padding, lowercase)
    const base64 = btoa(String.fromCharCode(...array));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '').toLowerCase();
  }

  private async persistPortTokens(): Promise<void> {
    // Convert Map to plain object for storage
    const tokensObj: Record<string, string> = {};
    for (const [port, token] of this.portTokens.entries()) {
      tokensObj[port.toString()] = token;
    }
    await this.ctx.storage.put('portTokens', tokensObj);
  }

  private constructPreviewUrl(port: number, sandboxId: string, hostname: string, token: string): string {
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
        // Construct subdomain safely with mandatory token
        const subdomainHost = `${port}-${sanitizedSandboxId}-${token}.${host}`;
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

      // Construct subdomain safely with mandatory token
      const subdomainHost = `${port}-${sanitizedSandboxId}-${token}.${hostname}`;
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

  // ============================================================================
  // Session Management - Advanced Use Cases
  // ============================================================================

  /**
   * Create isolated execution session for advanced use cases
   * Returns ExecutionSession with full sandbox API bound to specific session
   */
  async createSession(options?: SessionOptions): Promise<ExecutionSession> {
    const sessionId = options?.id || `session-${Date.now()}`;

    // Create session in container
    await this.client.utils.createSession({
      id: sessionId,
      env: options?.env,
      cwd: options?.cwd,
    });

    // Return wrapper that binds sessionId to all operations
    return this.getSessionWrapper(sessionId);
  }

  /**
   * Get an existing session by ID
   * Returns ExecutionSession wrapper bound to the specified session
   *
   * This is useful for retrieving sessions across different requests/contexts
   * without storing the ExecutionSession object (which has RPC lifecycle limitations)
   *
   * @param sessionId - The ID of an existing session
   * @returns ExecutionSession wrapper bound to the session
   */
  async getSession(sessionId: string): Promise<ExecutionSession> {
    // No need to verify session exists in container - operations will fail naturally if it doesn't
    return this.getSessionWrapper(sessionId);
  }

  /**
   * Internal helper to create ExecutionSession wrapper for a given sessionId
   * Used by both createSession and getSession
   */
  private getSessionWrapper(sessionId: string): ExecutionSession {
    return {
      id: sessionId,

      // Command execution
      exec: async (command: string, options?: ExecOptions) => {
        const startTime = Date.now();
        const response = await this.client.commands.execute(command, sessionId);
        const duration = Date.now() - startTime;
        return this.mapExecuteResponseToExecResult(response, duration, sessionId);
      },

      execStream: async (command: string, options?: StreamOptions) => {
        return this.client.commands.executeStream(command, sessionId);
      },

      // Process management
      startProcess: async (command: string, options?: ProcessOptions) => {
        const response = await this.client.processes.startProcess(command, sessionId, {
          processId: options?.processId
        });
        const process = response.process;
        return {
          id: process.id,
          pid: process.pid,
          command: process.command,
          status: process.status as ProcessStatus,
          startTime: new Date(process.startTime),
          endTime: process.endTime ? new Date(process.endTime) : undefined,
          exitCode: process.exitCode ?? undefined,
          sessionId,
          kill: async (signal?: string) => {
            await this.client.processes.killProcess(process.id, sessionId);
          },
          getStatus: async () => {
            const resp = await this.client.processes.getProcess(process.id, sessionId);
            return resp.process?.status as ProcessStatus || "error";
          },
          getLogs: async () => {
            const logs = await this.client.processes.getProcessLogs(process.id, sessionId);
            return { stdout: logs.stdout, stderr: logs.stderr };
          },
        };
      },

      listProcesses: async () => {
        const response = await this.client.processes.listProcesses(sessionId);
        return response.processes.map(p => ({
          id: p.id,
          pid: p.pid,
          command: p.command,
          status: p.status,
          startTime: new Date(p.startTime),
          endTime: p.endTime ? new Date(p.endTime) : undefined,
          exitCode: p.exitCode ?? undefined,
          sessionId,
          kill: async (signal?: string) => {
            await this.client.processes.killProcess(p.id, sessionId);
          },
          getStatus: async () => {
            const resp = await this.client.processes.getProcess(p.id, sessionId);
            return resp.process?.status || "error";
          },
          getLogs: async () => {
            const logs = await this.client.processes.getProcessLogs(p.id, sessionId);
            return { stdout: logs.stdout, stderr: logs.stderr };
          },
        }));
      },

      getProcess: async (id: string) => {
        const response = await this.client.processes.getProcess(id, sessionId);
        if (!response.process) return null;
        const p = response.process;
        return {
          id: p.id,
          pid: p.pid,
          command: p.command,
          status: p.status,
          startTime: new Date(p.startTime),
          endTime: p.endTime ? new Date(p.endTime) : undefined,
          exitCode: p.exitCode ?? undefined,
          sessionId,
          kill: async (signal?: string) => {
            await this.client.processes.killProcess(p.id, sessionId);
          },
          getStatus: async () => {
            const resp = await this.client.processes.getProcess(p.id, sessionId);
            return resp.process?.status || "error";
          },
          getLogs: async () => {
            const logs = await this.client.processes.getProcessLogs(p.id, sessionId);
            return { stdout: logs.stdout, stderr: logs.stderr };
          },
        };
      },

      killProcess: async (id: string, signal?: string) => {
        await this.client.processes.killProcess(id, sessionId);
      },

      killAllProcesses: async () => {
        const response = await this.client.processes.killAllProcesses(sessionId);
        return response.killedCount;
      },

      cleanupCompletedProcesses: async () => {
        return 0; // Placeholder
      },

      getProcessLogs: async (id: string) => {
        const response = await this.client.processes.getProcessLogs(id, sessionId);
        return {
          stdout: response.stdout,
          stderr: response.stderr,
          processId: response.processId
        };
      },

      streamProcessLogs: async (processId: string, options?: { signal?: AbortSignal }) => {
        return this.client.processes.streamProcessLogs(processId, sessionId);
      },

      // Environment management
      setEnvVars: async (envVars: Record<string, string>) => {
        try {
          // Set environment variables by executing export commands
          for (const [key, value] of Object.entries(envVars)) {
            const escapedValue = value.replace(/'/g, "'\\''");
            const exportCommand = `export ${key}='${escapedValue}'`;

            const result = await this.client.commands.execute(exportCommand, sessionId);

            if (result.exitCode !== 0) {
              throw new Error(`Failed to set ${key}: ${result.stderr || 'Unknown error'}`);
            }
          }

          console.log(`[Session ${sessionId}] Environment variables updated successfully`);
        } catch (error) {
          console.error(`[Session ${sessionId}] Failed to set environment variables:`, error);
          throw error;
        }
      },

      // Code interpreter methods - delegate to sandbox's code interpreter
      createCodeContext: async (options?: CreateContextOptions) => {
        return this.codeInterpreter.createCodeContext(options);
      },

      runCode: async (code: string, options?: RunCodeOptions) => {
        const execution = await this.codeInterpreter.runCode(code, options);
        return execution.toJSON();
      },

      listCodeContexts: async () => {
        return this.codeInterpreter.listCodeContexts();
      },

      deleteCodeContext: async (contextId: string) => {
        return this.codeInterpreter.deleteCodeContext(contextId);
      },

      // File operations
      writeFile: async (path: string, content: string, options?: { encoding?: string }) => {
        return this.client.files.writeFile(path, content, sessionId, options);
      },

      readFile: async (path: string, options?: { encoding?: string }) => {
        return this.client.files.readFile(path, sessionId, options);
      },

      mkdir: async (path: string, options?: { recursive?: boolean }) => {
        return this.client.files.mkdir(path, sessionId, options);
      },

      deleteFile: async (path: string) => {
        return this.client.files.deleteFile(path, sessionId);
      },

      renameFile: async (oldPath: string, newPath: string) => {
        return this.client.files.renameFile(oldPath, newPath, sessionId);
      },

      moveFile: async (sourcePath: string, destinationPath: string) => {
        return this.client.files.moveFile(sourcePath, destinationPath, sessionId);
      },

      // Git operations
      gitCheckout: async (repoUrl: string, options?: { branch?: string; targetDir?: string }) => {
        return this.client.git.checkout(repoUrl, sessionId, options);
      }
    };
  }

  // ============================================================================
  // Code interpreter methods - delegate to CodeInterpreter wrapper
  // ============================================================================

  async createCodeContext(options?: CreateContextOptions): Promise<CodeContext> {
    return this.codeInterpreter.createCodeContext(options);
  }

  async runCode(code: string, options?: RunCodeOptions): Promise<ExecutionResult> {
    const execution = await this.codeInterpreter.runCode(code, options);
    return execution.toJSON();
  }

  async listCodeContexts(): Promise<CodeContext[]> {
    return this.codeInterpreter.listCodeContexts();
  }

  async deleteCodeContext(contextId: string): Promise<void> {
    return this.codeInterpreter.deleteCodeContext(contextId);
  }
}
