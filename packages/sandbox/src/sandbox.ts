import { Container, getContainer } from "@cloudflare/containers";
import { CodeInterpreter } from "./interpreter";
import type {
  CodeContext,
  CreateContextOptions,
  ExecutionResult,
  RunCodeOptions,
} from "./interpreter-types";
import { JupyterClient } from "./jupyter-client";
import { isLocalhostPattern } from "./request-handler";
import {
  logSecurityEvent,
  SecurityError,
  sanitizeSandboxId,
  validatePort,
} from "./security";
import { parseSSEStream } from "./sse-parser";
import type {
  ExecEvent,
  ExecOptions,
  ExecResult,
  ExecuteResponse,
  ExecutionSession,
  ISandbox,
  Process,
  ProcessOptions,
  ProcessStatus,
  StreamOptions,
} from "./types";
import { ProcessNotFoundError, SandboxError } from "./types";

export function getSandbox(ns: DurableObjectNamespace<Sandbox>, id: string) {
  const stub = getContainer(ns, id);

  // Store the name on first access
  stub.setSandboxName?.(id);

  return stub;
}

export class Sandbox<Env = unknown> extends Container<Env> implements ISandbox {
  defaultPort = 3000; // Default port for the container's Bun server
  sleepAfter = "20m"; // Keep container warm for 20 minutes to avoid cold starts
  client: JupyterClient;
  private sandboxName: string | null = null;
  private codeInterpreter: CodeInterpreter;
  private defaultSessionInitialized = false;
  private defaultSessionName: string | undefined = undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.client = new JupyterClient({
      onCommandComplete: (success, exitCode, _stdout, _stderr, command) => {
        console.log(
          `[Container] Command completed: ${command}, Success: ${success}, Exit code: ${exitCode}`
        );
      },
      onCommandStart: (command) => {
        console.log(`[Container] Command started: ${command}`);
      },
      onError: (error, _command) => {
        console.error(`[Container] Command error: ${error}`);
      },
      onOutput: (stream, data, _command) => {
        console.log(`[Container] [${stream}] ${data}`);
      },
      port: 3000, // Control plane port
      stub: this,
    });

    // Initialize code interpreter
    this.codeInterpreter = new CodeInterpreter(this);

    // Load the sandbox name from storage on initialization
    this.ctx.blockConcurrencyWhile(async () => {
      this.sandboxName =
        (await this.ctx.storage.get<string>("sandboxName")) || null;
    });
  }

  // RPC method to set the sandbox name
  async setSandboxName(name: string): Promise<void> {
    if (!this.sandboxName) {
      this.sandboxName = name;
      await this.ctx.storage.put("sandboxName", name);
      console.log(`[Sandbox] Stored sandbox name via RPC: ${name}`);
    }
  }

  // RPC method to set environment variables
  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.envVars = { ...this.envVars, ...envVars };
    console.log(`[Sandbox] Updated environment variables`);
    
    // If we have a default session, update its environment too
    if (this.defaultSessionInitialized) {
      // This would update the session's environment variables
      // For now, new exec calls will use these vars
    }
  }

  override onStart() {
    console.log("Sandbox successfully started");
    // Note: We don't initialize the default session here to avoid
    // potential infinite loops. The session will be created lazily
    // on first exec() call.
  }

  override onStop() {
    console.log("Sandbox successfully shut down");
    // Client cleanup if needed in the future
  }

  override onError(error: unknown) {
    console.log("Sandbox error:", error);
  }

  // Override fetch to route internal container requests to appropriate ports
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Capture and store the sandbox name from the header if present
    if (!this.sandboxName && request.headers.has("X-Sandbox-Name")) {
      const name = request.headers.get("X-Sandbox-Name")!;
      this.sandboxName = name;
      await this.ctx.storage.put("sandboxName", name);
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

  // Helper to ensure default session is initialized for consistent working directory
  private async ensureDefaultSession(): Promise<void> {
    if (!this.defaultSessionInitialized) {
      await this.initializeDefaultSession();
    }
  }

  // Helper to resolve relative paths to absolute paths using session working directory
  private resolvePath(path: string): string {
    return path.startsWith('/') ? path : `/workspace/${path}`;
  }

  // Initialize the default session for this sandbox
  private async initializeDefaultSession(): Promise<void> {
    if (this.defaultSessionInitialized) return;
    
    try {
      // Create a default session that persists state
      const sessionName = `sandbox-${this.sandboxName || 'default'}`;
      await this.client.createSession({
        name: sessionName,
        env: this.envVars || {},
        cwd: '/workspace',
        isolation: true
      });
      this.defaultSessionInitialized = true;
      this.defaultSessionName = sessionName; // Store the session name
      console.log(`[Sandbox] Default session initialized: ${sessionName}`);
    } catch (error) {
      console.warn("[Sandbox] Could not initialize default session:", error);
      // Continue without session - will use legacy exec
    }
  }

  // Enhanced exec method - now uses the sandbox's implicit session
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    // Lazily initialize the default session on first use
    if (!this.defaultSessionInitialized) {
      try {
        await this.initializeDefaultSession();
      } catch (error) {
        console.warn("[Sandbox] Could not initialize default session:", error);
        // Continue without session - will use legacy exec
      }
    }
    
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    // Handle timeout
    let timeoutId: NodeJS.Timeout | undefined;

    try {
      // Handle cancellation
      if (options?.signal?.aborted) {
        throw new Error("Operation was aborted");
      }

      let result: ExecResult;

      if (options?.stream && options?.onOutput) {
        // Streaming with callbacks - we need to collect the final result
        result = await this.executeWithStreaming(
          command,
          options,
          startTime,
          timestamp
        );
      } else {
        // Regular execution - use the sandbox's default session
        const response = await this.client.exec(this.defaultSessionName, command, {
          cwd: options?.cwd,
          env: options?.env,
        });

        const duration = Date.now() - startTime;
        result = this.mapExecuteResponseToExecResult(
          response,
          duration
        );
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
    let stdout = "";
    let stderr = "";

    try {
      // Get streaming execution from client using default session
      const stream = await this.client.execStream(this.defaultSessionName, command);

      for await (const event of parseSSEStream<ExecEvent>(stream)) {
        // Check for cancellation
        if (options.signal?.aborted) {
          throw new Error("Operation was aborted");
        }

        switch (event.type) {
          case "stdout":
          case "stderr":
            if (event.data) {
              // Update accumulated output
              if (event.type === "stdout") stdout += event.data;
              if (event.type === "stderr") stderr += event.data;

              // Call user's callback
              if (options.onOutput) {
                options.onOutput(event.type, event.data);
              }
            }
            break;

          case "complete": {
            // Use result from complete event if available
            const duration = Date.now() - startTime;
            return (
              event.result || {
                success: event.exitCode === 0,
                exitCode: event.exitCode || 0,
                stdout,
                stderr,
                command,
                duration,
                timestamp,
              }
            );
          }

          case "error":
            throw new Error(event.error || "Command execution failed");
        }
      }

      // If we get here without a complete event, something went wrong
      throw new Error("Stream ended without completion event");
    } catch (error) {
      if (options.signal?.aborted) {
        throw new Error("Operation was aborted");
      }
      throw error;
    }
  }

  private mapExecuteResponseToExecResult(
    response: ExecuteResponse,
    duration: number
  ): ExecResult {
    return {
      success: response.success,
      exitCode: response.exitCode,
      stdout: response.stdout,
      stderr: response.stderr,
      command: response.command,
      duration,
      timestamp: response.timestamp,
    };
  }

  // Background process management
  async startProcess(
    command: string,
    options?: ProcessOptions
  ): Promise<Process> {
    // Use the new HttpClient method to start the process
    try {
      const response = await this.client.startProcess(command, {
        processId: options?.processId,
        timeout: options?.timeout,
        env: options?.env,
        cwd: options?.cwd,
        encoding: options?.encoding,
        autoCleanup: options?.autoCleanup,
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

        async kill(): Promise<void> {
          throw new Error("Method will be replaced");
        },
        async getStatus(): Promise<ProcessStatus> {
          throw new Error("Method will be replaced");
        },
        async getLogs(): Promise<{ stdout: string; stderr: string }> {
          throw new Error("Method will be replaced");
        },
      };

      // Bind context properly
      processObj.kill = async (signal?: string) => {
        await this.killProcess(process.id, signal);
      };

      processObj.getStatus = async () => {
        const current = await this.getProcess(process.id);
        return current?.status || "error";
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
    const response = await this.client.listProcesses();

    return response.processes.map((processData) => ({
      id: processData.id,
      pid: processData.pid,
      command: processData.command,
      status: processData.status,
      startTime: new Date(processData.startTime),
      endTime: processData.endTime ? new Date(processData.endTime) : undefined,
      exitCode: processData.exitCode,

      kill: async (signal?: string) => {
        await this.killProcess(processData.id, signal);
      },

      getStatus: async () => {
        const current = await this.getProcess(processData.id);
        return current?.status || "error";
      },

      getLogs: async () => {
        const logs = await this.getProcessLogs(processData.id);
        return { stdout: logs.stdout, stderr: logs.stderr };
      },
    }));
  }

  async getProcess(id: string): Promise<Process | null> {
    const response = await this.client.getProcess(id);
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

      kill: async (signal?: string) => {
        await this.killProcess(processData.id, signal);
      },

      getStatus: async () => {
        const current = await this.getProcess(processData.id);
        return current?.status || "error";
      },

      getLogs: async () => {
        const logs = await this.getProcessLogs(processData.id);
        return { stdout: logs.stdout, stderr: logs.stderr };
      },
    };
  }

  async killProcess(id: string, _signal?: string): Promise<void> {
    try {
      // Note: signal parameter is not currently supported by the HttpClient implementation
      await this.client.killProcess(id);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Process not found")
      ) {
        throw new ProcessNotFoundError(id);
      }
      throw new SandboxError(
        `Failed to kill process ${id}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        "KILL_PROCESS_FAILED"
      );
    }
  }

  async killAllProcesses(): Promise<number> {
    const response = await this.client.killAllProcesses();
    return response.killedCount;
  }

  async cleanupCompletedProcesses(): Promise<number> {
    // For now, this would need to be implemented as a container endpoint
    // as we no longer maintain local process storage
    // We'll return 0 as a placeholder until the container endpoint is added
    return 0;
  }

  async getProcessLogs(
    id: string
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const response = await this.client.getProcessLogs(id);
      return {
        stdout: response.stdout,
        stderr: response.stderr,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Process not found")
      ) {
        throw new ProcessNotFoundError(id);
      }
      throw error;
    }
  }

  // Streaming methods - return ReadableStream for RPC compatibility
  async execStream(
    command: string,
    options?: StreamOptions
  ): Promise<ReadableStream<Uint8Array>> {
    // Lazily initialize the default session on first use
    if (!this.defaultSessionInitialized) {
      try {
        await this.initializeDefaultSession();
      } catch (error) {
        console.warn("[Sandbox] Could not initialize default session:", error);
      }
    }

    // Check for cancellation
    if (options?.signal?.aborted) {
      throw new Error("Operation was aborted");
    }

    // Get the stream from HttpClient using default session
    const stream = await this.client.execStream(this.defaultSessionName, command);

    // Return the ReadableStream directly - can be converted to AsyncIterable by consumers
    return stream;
  }

  async streamProcessLogs(
    processId: string,
    options?: { signal?: AbortSignal }
  ): Promise<ReadableStream<Uint8Array>> {
    // Check for cancellation
    if (options?.signal?.aborted) {
      throw new Error("Operation was aborted");
    }

    // Get the stream from HttpClient
    const stream = await this.client.streamProcessLogs(processId);

    // Return the ReadableStream directly - can be converted to AsyncIterable by consumers
    return stream;
  }

  async gitCheckout(
    repoUrl: string,
    options: { branch?: string; targetDir?: string }
  ) {
    await this.ensureDefaultSession();
    
    const targetDir = options.targetDir ? this.resolvePath(options.targetDir) : options.targetDir;
    return this.client.gitCheckout(repoUrl, options.branch, targetDir);
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}) {
    await this.ensureDefaultSession();
    return this.client.mkdir(path, options.recursive, this.defaultSessionName);
  }

  async writeFile(
    path: string,
    content: string,
    options: { encoding?: string } = {}
  ) {
    await this.ensureDefaultSession();
    return this.client.writeFile(path, content, options.encoding, this.defaultSessionName);
  }

  async deleteFile(path: string) {
    await this.ensureDefaultSession();
    return this.client.deleteFile(path, this.defaultSessionName);
  }

  async renameFile(oldPath: string, newPath: string) {
    await this.ensureDefaultSession();
    return this.client.renameFile(oldPath, newPath, this.defaultSessionName);
  }

  async moveFile(sourcePath: string, destinationPath: string) {
    await this.ensureDefaultSession();
    return this.client.moveFile(sourcePath, destinationPath, this.defaultSessionName);
  }

  async readFile(path: string, options: { encoding?: string } = {}) {
    await this.ensureDefaultSession();
    return this.client.readFile(path, options.encoding, this.defaultSessionName);
  }

  async listFiles(
    path: string,
    options: {
      recursive?: boolean;
      includeHidden?: boolean;
    } = {}
  ) {
    await this.ensureDefaultSession();
    return this.client.listFiles(path, options, this.defaultSessionName);
  }

  async exposePort(port: number, options: { name?: string; hostname: string }) {
    await this.client.exposePort(port, options?.name);

    // We need the sandbox name to construct preview URLs
    if (!this.sandboxName) {
      throw new Error(
        "Sandbox name not available. Ensure sandbox is accessed through getSandbox()"
      );
    }

    const url = this.constructPreviewUrl(
      port,
      this.sandboxName,
      options.hostname
    );

    return {
      url,
      port,
      name: options?.name,
    };
  }

  async unexposePort(port: number) {
    if (!validatePort(port)) {
      logSecurityEvent(
        "INVALID_PORT_UNEXPOSE",
        {
          port,
        },
        "high"
      );
      throw new SecurityError(
        `Invalid port number: ${port}. Must be between 1024-65535 and not reserved.`
      );
    }

    await this.client.unexposePort(port);

    logSecurityEvent(
      "PORT_UNEXPOSED",
      {
        port,
      },
      "low"
    );
  }

  async getExposedPorts(hostname: string) {
    const response = await this.client.getExposedPorts();

    // We need the sandbox name to construct preview URLs
    if (!this.sandboxName) {
      throw new Error(
        "Sandbox name not available. Ensure sandbox is accessed through getSandbox()"
      );
    }

    return response.ports.map((port) => ({
      url: this.constructPreviewUrl(port.port, this.sandboxName!, hostname),
      port: port.port,
      name: port.name,
      exposedAt: port.exposedAt,
    }));
  }

  private constructPreviewUrl(
    port: number,
    sandboxId: string,
    hostname: string
  ): string {
    if (!validatePort(port)) {
      logSecurityEvent(
        "INVALID_PORT_REJECTED",
        {
          port,
          sandboxId,
          hostname,
        },
        "high"
      );
      throw new SecurityError(
        `Invalid port number: ${port}. Must be between 1024-65535 and not reserved.`
      );
    }

    let sanitizedSandboxId: string;
    try {
      sanitizedSandboxId = sanitizeSandboxId(sandboxId);
    } catch (error) {
      logSecurityEvent(
        "INVALID_SANDBOX_ID_REJECTED",
        {
          sandboxId,
          port,
          hostname,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "high"
      );
      throw error;
    }

    const isLocalhost = isLocalhostPattern(hostname);

    if (isLocalhost) {
      // Unified subdomain approach for localhost (RFC 6761)
      const [host, portStr] = hostname.split(":");
      const mainPort = portStr || "80";

      // Use URL constructor for safe URL building
      try {
        const baseUrl = new URL(`http://${host}:${mainPort}`);
        // Construct subdomain safely
        const subdomainHost = `${port}-${sanitizedSandboxId}.${host}`;
        baseUrl.hostname = subdomainHost;

        const finalUrl = baseUrl.toString();

        logSecurityEvent(
          "PREVIEW_URL_CONSTRUCTED",
          {
            port,
            sandboxId: sanitizedSandboxId,
            hostname,
            resultUrl: finalUrl,
            environment: "localhost",
          },
          "low"
        );

        return finalUrl;
      } catch (error) {
        logSecurityEvent(
          "URL_CONSTRUCTION_FAILED",
          {
            port,
            sandboxId: sanitizedSandboxId,
            hostname,
            error: error instanceof Error ? error.message : "Unknown error",
          },
          "high"
        );
        throw new SecurityError(
          `Failed to construct preview URL: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
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

      logSecurityEvent(
        "PREVIEW_URL_CONSTRUCTED",
        {
          port,
          sandboxId: sanitizedSandboxId,
          hostname,
          resultUrl: finalUrl,
          environment: "production",
        },
        "low"
      );

      return finalUrl;
    } catch (error) {
      logSecurityEvent(
        "URL_CONSTRUCTION_FAILED",
        {
          port,
          sandboxId: sanitizedSandboxId,
          hostname,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "high"
      );
      throw new SecurityError(
        `Failed to construct preview URL: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  // Code Interpreter Methods

  /**
   * Create a new code execution context
   */
  async createCodeContext(
    options?: CreateContextOptions
  ): Promise<CodeContext> {
    return this.codeInterpreter.createCodeContext(options);
  }

  /**
   * Run code with streaming callbacks
   */
  async runCode(
    code: string,
    options?: RunCodeOptions
  ): Promise<ExecutionResult> {
    const execution = await this.codeInterpreter.runCode(code, options);
    // Convert to plain object for RPC serialization
    return execution.toJSON();
  }

  /**
   * Run code and return a streaming response
   */
  async runCodeStream(
    code: string,
    options?: RunCodeOptions
  ): Promise<ReadableStream> {
    return this.codeInterpreter.runCodeStream(code, options);
  }

  /**
   * List all code contexts
   */
  async listCodeContexts(): Promise<CodeContext[]> {
    return this.codeInterpreter.listCodeContexts();
  }

  /**
   * Delete a code context
   */
  async deleteCodeContext(contextId: string): Promise<void> {
    return this.codeInterpreter.deleteCodeContext(contextId);
  }

  // ============================================================================
  // Session Management (Simple Isolation)
  // ============================================================================

  /**
   * Create a new execution session with isolation
   * Returns a session object with exec() method
   */

  async createSession(options: {
    name?: string;
    env?: Record<string, string>;
    cwd?: string;
    isolation?: boolean;
  }): Promise<ExecutionSession> {
    const sessionName = options.name || `session-${Date.now()}`;
    
    await this.client.createSession({
      name: sessionName,
      env: options.env,
      cwd: options.cwd,
      isolation: options.isolation
    });
    // Return comprehensive ExecutionSession object that implements all ISandbox methods
    return {
      name: sessionName,
      
      // Command execution - clean method names
      exec: async (command: string, options?: ExecOptions) => {
        const result = await this.client.exec(sessionName, command);
        return {
          ...result,
          command,
          duration: 0,
          timestamp: new Date().toISOString()
        };
      },
      
      execStream: async (command: string, options?: StreamOptions) => {
        return await this.client.execStream(sessionName, command);
      },
      
      // Process management - route to session-aware methods
      startProcess: async (command: string, options?: ProcessOptions) => {
        // For now, delegate to sandbox's process methods
        // TODO: Implement session-aware process management
        return await this.startProcess(command, options);
      },
      
      listProcesses: async () => {
        // For now, delegate to sandbox's process methods  
        // TODO: Filter by session
        return await this.listProcesses();
      },
      
      getProcess: async (id: string) => {
        return await this.getProcess(id);
      },
      
      killProcess: async (id: string, signal?: string) => {
        return await this.killProcess(id, signal);
      },
      
      killAllProcesses: async () => {
        // TODO: Kill only session processes
        return await this.killAllProcesses();
      },
      
      streamProcessLogs: async (processId: string, options?: { signal?: AbortSignal }) => {
        return await this.streamProcessLogs(processId, options);
      },
      
      getProcessLogs: async (id: string) => {
        return await this.getProcessLogs(id);
      },
      
      cleanupCompletedProcesses: async () => {
        return await this.cleanupCompletedProcesses();
      },
      
      // File operations - clean method names (no "InSession" suffix)
      writeFile: async (path: string, content: string, options?: { encoding?: string }) => {
        return await this.client.writeFile(path, content, options?.encoding, sessionName);
      },
      
      readFile: async (path: string, options?: { encoding?: string }) => {
        return await this.client.readFile(path, options?.encoding, sessionName);
      },
      
      mkdir: async (path: string, options?: { recursive?: boolean }) => {
        return await this.client.mkdir(path, options?.recursive, sessionName);
      },
      
      deleteFile: async (path: string) => {
        return await this.client.deleteFile(path, sessionName);
      },
      
      renameFile: async (oldPath: string, newPath: string) => {
        return await this.client.renameFile(oldPath, newPath, sessionName);
      },
      
      moveFile: async (sourcePath: string, destinationPath: string) => {
        return await this.client.moveFile(sourcePath, destinationPath, sessionName);
      },
      
      listFiles: async (path: string, options?: { recursive?: boolean; includeHidden?: boolean }) => {
        return await this.client.listFiles(path, options, sessionName);
      },
      
      gitCheckout: async (repoUrl: string, options?: { branch?: string; targetDir?: string }) => {
        return await this.gitCheckout(repoUrl, options || {});
      },
      
      // Port management
      exposePort: async (port: number, options: { name?: string; hostname: string }) => {
        return await this.exposePort(port, options);
      },
      
      unexposePort: async (port: number) => {
        return await this.unexposePort(port);
      },
      
      getExposedPorts: async (hostname: string) => {
        return await this.getExposedPorts(hostname);
      },
      
      // Environment management
      setEnvVars: async (envVars: Record<string, string>) => {
        // TODO: Implement session-specific environment updates
        console.log(`[Session ${sessionName}] Environment variables update not yet implemented`);
      },
      
      // Code Interpreter API
      createCodeContext: async (options?: any) => {
        return await this.createCodeContext(options);
      },
      
      runCode: async (code: string, options?: any) => {
        return await this.runCode(code, options);
      },
      
      runCodeStream: async (code: string, options?: any) => {
        return await this.runCodeStream(code, options);
      },
      
      listCodeContexts: async () => {
        return await this.listCodeContexts();
      },
      
      deleteCodeContext: async (contextId: string) => {
        return await this.deleteCodeContext(contextId);
      }
    };
  }
}
