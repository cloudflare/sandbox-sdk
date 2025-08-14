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
  private defaultSession: ExecutionSession | null = null;

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
    if (this.defaultSession) {
      await this.defaultSession.setEnvVars(envVars);
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

  // Helper to ensure default session is initialized
  private async ensureDefaultSession(): Promise<ExecutionSession> {
    if (!this.defaultSession) {
      const sessionName = `sandbox-${this.sandboxName || 'default'}`;
      this.defaultSession = await this.createSession({
        name: sessionName,
        env: this.envVars || {},
        cwd: '/workspace',
        isolation: true
      });
      console.log(`[Sandbox] Default session initialized: ${sessionName}`);
    }
    return this.defaultSession;
  }


  // Enhanced exec method - delegates to default session
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const session = await this.ensureDefaultSession();
    return session.exec(command, options);
  }


  // Background process management - delegates to default session
  async startProcess(
    command: string,
    options?: ProcessOptions
  ): Promise<Process> {
    const session = await this.ensureDefaultSession();
    return session.startProcess(command, options);
  }

  async listProcesses(): Promise<Process[]> {
    const session = await this.ensureDefaultSession();
    return session.listProcesses();
  }

  async getProcess(id: string): Promise<Process | null> {
    const session = await this.ensureDefaultSession();
    return session.getProcess(id);
  }

  async killProcess(id: string, signal?: string): Promise<void> {
    const session = await this.ensureDefaultSession();
    return session.killProcess(id, signal);
  }

  async killAllProcesses(): Promise<number> {
    const session = await this.ensureDefaultSession();
    return session.killAllProcesses();
  }

  async cleanupCompletedProcesses(): Promise<number> {
    const session = await this.ensureDefaultSession();
    return session.cleanupCompletedProcesses();
  }

  async getProcessLogs(
    id: string
  ): Promise<{ stdout: string; stderr: string }> {
    const session = await this.ensureDefaultSession();
    return session.getProcessLogs(id);
  }

  // Streaming methods - delegates to default session
  async execStream(
    command: string,
    options?: StreamOptions
  ): Promise<ReadableStream<Uint8Array>> {
    const session = await this.ensureDefaultSession();
    return session.execStream(command, options);
  }

  async streamProcessLogs(
    processId: string,
    options?: { signal?: AbortSignal }
  ): Promise<ReadableStream<Uint8Array>> {
    const session = await this.ensureDefaultSession();
    return session.streamProcessLogs(processId, options);
  }

  async gitCheckout(
    repoUrl: string,
    options: { branch?: string; targetDir?: string }
  ) {
    const session = await this.ensureDefaultSession();
    return session.gitCheckout(repoUrl, options);
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}) {
    const session = await this.ensureDefaultSession();
    return session.mkdir(path, options);
  }

  async writeFile(
    path: string,
    content: string,
    options: { encoding?: string } = {}
  ) {
    const session = await this.ensureDefaultSession();
    return session.writeFile(path, content, options);
  }

  async deleteFile(path: string) {
    const session = await this.ensureDefaultSession();
    return session.deleteFile(path);
  }

  async renameFile(oldPath: string, newPath: string) {
    const session = await this.ensureDefaultSession();
    return session.renameFile(oldPath, newPath);
  }

  async moveFile(sourcePath: string, destinationPath: string) {
    const session = await this.ensureDefaultSession();
    return session.moveFile(sourcePath, destinationPath);
  }

  async readFile(path: string, options: { encoding?: string } = {}) {
    const session = await this.ensureDefaultSession();
    return session.readFile(path, options);
  }

  async listFiles(
    path: string,
    options: {
      recursive?: boolean;
      includeHidden?: boolean;
    } = {}
  ) {
    const session = await this.ensureDefaultSession();
    return session.listFiles(path, options);
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
        // Use session-specific process management
        const response = await this.client.startProcess(command, sessionName, {
          processId: options?.processId,
          timeout: options?.timeout,
          env: options?.env,
          cwd: options?.cwd,
          encoding: options?.encoding,
          autoCleanup: options?.autoCleanup,
        });
        
        // Convert response to Process object with bound methods
        const process = response.process;
        return {
          id: process.id,
          pid: process.pid,
          command: process.command,
          status: process.status as ProcessStatus,
          startTime: new Date(process.startTime),
          endTime: process.endTime ? new Date(process.endTime) : undefined,
          exitCode: process.exitCode ?? undefined,
          kill: async (signal?: string) => {
            await this.client.killProcess(process.id);
          },
          getStatus: async () => {
            const resp = await this.client.getProcess(process.id);
            return resp.process?.status as ProcessStatus || "error";
          },
          getLogs: async () => {
            return await this.client.getProcessLogs(process.id);
          },
        };
      },
      
      listProcesses: async () => {
        // Get processes for this specific session
        const response = await this.client.listProcesses(sessionName);
        
        // Convert to Process objects with bound methods
        return response.processes.map(p => ({
          id: p.id,
          pid: p.pid,
          command: p.command,
          status: p.status as ProcessStatus,
          startTime: new Date(p.startTime),
          endTime: p.endTime ? new Date(p.endTime) : undefined,
          exitCode: p.exitCode ?? undefined,
          kill: async (signal?: string) => {
            await this.client.killProcess(p.id);
          },
          getStatus: async () => {
            const processResp = await this.client.getProcess(p.id);
            return processResp.process?.status as ProcessStatus || "error";
          },
          getLogs: async () => {
            return this.client.getProcessLogs(p.id);
          },
        }));
      },
      
      getProcess: async (id: string) => {
        const response = await this.client.getProcess(id);
        if (!response.process) return null;
        
        const p = response.process;
        return {
          id: p.id,
          pid: p.pid,
          command: p.command,
          status: p.status as ProcessStatus,
          startTime: new Date(p.startTime),
          endTime: p.endTime ? new Date(p.endTime) : undefined,
          exitCode: p.exitCode ?? undefined,
          kill: async (signal?: string) => {
            await this.client.killProcess(p.id);
          },
          getStatus: async () => {
            const processResp = await this.client.getProcess(p.id);
            return processResp.process?.status as ProcessStatus || "error";
          },
          getLogs: async () => {
            return this.client.getProcessLogs(p.id);
          },
        };
      },
      
      killProcess: async (id: string, signal?: string) => {
        await this.client.killProcess(id);
      },
      
      killAllProcesses: async () => {
        // Kill all processes for this specific session
        const response = await this.client.killAllProcesses(sessionName);
        return response.killedCount;
      },
      
      streamProcessLogs: async (processId: string, options?: { signal?: AbortSignal }) => {
        return await this.client.streamProcessLogs(processId, options);
      },
      
      getProcessLogs: async (id: string) => {
        return await this.client.getProcessLogs(id);
      },
      
      cleanupCompletedProcesses: async () => {
        // This would need a new endpoint to cleanup processes for a specific session
        // For now, return 0 as no cleanup is performed
        return 0;
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
        return await this.client.listFiles(path, sessionName, options);
      },
      
      gitCheckout: async (repoUrl: string, options?: { branch?: string; targetDir?: string }) => {
        return await this.client.gitCheckout(repoUrl, sessionName, options?.branch, options?.targetDir);
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
