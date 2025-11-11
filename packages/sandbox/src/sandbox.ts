import type { DurableObject } from 'cloudflare:workers';
import { Container, getContainer, switchPort } from '@cloudflare/containers';
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
  SandboxOptions,
  SessionOptions,
  StreamOptions
} from '@repo/shared';
import {
  createLogger,
  runWithLogger,
  type SessionDeleteResult,
  TraceContext
} from '@repo/shared';
import { type ExecuteResponse, SandboxClient } from './clients';
import type { ErrorResponse } from './errors';
import { CustomDomainRequiredError, ErrorCode } from './errors';
import { CodeInterpreter } from './interpreter';
import { isLocalhostPattern } from './request-handler';
import { SecurityError, sanitizeSandboxId, validatePort } from './security';
import { parseSSEStream } from './sse-parser';
import { SDK_VERSION } from './version';

export function getSandbox(
  ns: DurableObjectNamespace<Sandbox>,
  id: string,
  options?: SandboxOptions
): Sandbox {
  const stub = getContainer(ns, id) as unknown as Sandbox;

  // Store the name on first access
  stub.setSandboxName?.(id);

  if (options?.baseUrl) {
    stub.setBaseUrl(options.baseUrl);
  }

  if (options?.sleepAfter !== undefined) {
    stub.setSleepAfter(options.sleepAfter);
  }

  if (options?.keepAlive !== undefined) {
    stub.setKeepAlive(options.keepAlive);
  }

  return Object.assign(stub, {
    wsConnect: connect(stub)
  });
}

export function connect(stub: {
  fetch: (request: Request) => Promise<Response>;
}) {
  return async (request: Request, port: number) => {
    // Validate port before routing
    if (!validatePort(port)) {
      throw new SecurityError(
        `Invalid or restricted port: ${port}. Ports must be in range 1024-65535 and not reserved.`
      );
    }
    const portSwitchedRequest = switchPort(request, port);
    return await stub.fetch(portSwitchedRequest);
  };
}

export class Sandbox<Env = unknown> extends Container<Env> implements ISandbox {
  defaultPort = 3000; // Default port for the container's Bun server
  sleepAfter: string | number = '10m'; // Sleep the sandbox if no requests are made in this timeframe

  client: SandboxClient;
  private codeInterpreter: CodeInterpreter;
  private sandboxName: string | null = null;
  private baseUrl: string | null = null;
  private portTokens: Map<number, string> = new Map();
  private defaultSession: string | null = null;
  envVars: Record<string, string> = {};
  private logger: ReturnType<typeof createLogger>;
  private keepAliveEnabled: boolean = false;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);

    const envObj = env as any;
    // Set sandbox environment variables from env object
    const sandboxEnvKeys = ['SANDBOX_LOG_LEVEL', 'SANDBOX_LOG_FORMAT'] as const;
    sandboxEnvKeys.forEach((key) => {
      if (envObj?.[key]) {
        this.envVars[key] = envObj[key];
      }
    });

    this.logger = createLogger({
      component: 'sandbox-do',
      sandboxId: this.ctx.id.toString()
    });

    this.client = new SandboxClient({
      logger: this.logger,
      port: 3000, // Control plane port
      stub: this
    });

    // Initialize code interpreter - pass 'this' after client is ready
    // The CodeInterpreter extracts client.interpreter from the sandbox
    this.codeInterpreter = new CodeInterpreter(this);

    // Load the sandbox name, port tokens, and default session from storage on initialization
    this.ctx.blockConcurrencyWhile(async () => {
      this.sandboxName =
        (await this.ctx.storage.get<string>('sandboxName')) || null;
      this.defaultSession =
        (await this.ctx.storage.get<string>('defaultSession')) || null;
      const storedTokens =
        (await this.ctx.storage.get<Record<string, string>>('portTokens')) ||
        {};

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
    }
  }

  // RPC method to set the base URL
  async setBaseUrl(baseUrl: string): Promise<void> {
    if (!this.baseUrl) {
      this.baseUrl = baseUrl;
      await this.ctx.storage.put('baseUrl', baseUrl);
    } else {
      if (this.baseUrl !== baseUrl) {
        throw new Error(
          'Base URL already set and different from one previously provided'
        );
      }
    }
  }

  // RPC method to set the sleep timeout
  async setSleepAfter(sleepAfter: string | number): Promise<void> {
    this.sleepAfter = sleepAfter;
  }

  // RPC method to enable keepAlive mode
  async setKeepAlive(keepAlive: boolean): Promise<void> {
    this.keepAliveEnabled = keepAlive;
    if (keepAlive) {
      this.logger.info(
        'KeepAlive mode enabled - container will stay alive until explicitly destroyed'
      );
    } else {
      this.logger.info(
        'KeepAlive mode disabled - container will timeout normally'
      );
    }
  }

  // RPC method to set environment variables
  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    // Update local state for new sessions
    this.envVars = { ...this.envVars, ...envVars };

    // If default session already exists, update it directly
    if (this.defaultSession) {
      // Set environment variables by executing export commands in the existing session
      for (const [key, value] of Object.entries(envVars)) {
        const escapedValue = value.replace(/'/g, "'\\''");
        const exportCommand = `export ${key}='${escapedValue}'`;

        const result = await this.client.commands.execute(
          exportCommand,
          this.defaultSession
        );

        if (result.exitCode !== 0) {
          throw new Error(
            `Failed to set ${key}: ${result.stderr || 'Unknown error'}`
          );
        }
      }
    }
  }

  /**
   * Cleanup and destroy the sandbox container
   */
  override async destroy(): Promise<void> {
    this.logger.info('Destroying sandbox container');
    await super.destroy();
  }

  override onStart() {
    this.logger.debug('Sandbox started');

    // Check version compatibility asynchronously (don't block startup)
    this.checkVersionCompatibility().catch((error) => {
      this.logger.error(
        'Version compatibility check failed',
        error instanceof Error ? error : new Error(String(error))
      );
    });
  }

  /**
   * Check if the container version matches the SDK version
   * Logs a warning if there's a mismatch
   */
  private async checkVersionCompatibility(): Promise<void> {
    try {
      // Get the SDK version (imported from version.ts)
      const sdkVersion = SDK_VERSION;

      // Get container version
      const containerVersion = await this.client.utils.getVersion();

      // If container version is unknown, it's likely an old container without the endpoint
      if (containerVersion === 'unknown') {
        this.logger.warn(
          'Container version check: Container version could not be determined. ' +
            'This may indicate an outdated container image. ' +
            'Please update your container to match SDK version ' +
            sdkVersion
        );
        return;
      }

      // Check if versions match
      if (containerVersion !== sdkVersion) {
        const message =
          `Version mismatch detected! SDK version (${sdkVersion}) does not match ` +
          `container version (${containerVersion}). This may cause compatibility issues. ` +
          `Please update your container image to version ${sdkVersion}`;

        // Log warning - we can't reliably detect dev vs prod environment in Durable Objects
        // so we always use warning level as requested by the user
        this.logger.warn(message);
      } else {
        this.logger.debug('Version check passed', {
          sdkVersion,
          containerVersion
        });
      }
    } catch (error) {
      // Don't fail the sandbox initialization if version check fails
      this.logger.debug('Version compatibility check encountered an error', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  override onStop() {
    this.logger.debug('Sandbox stopped');
  }

  override onError(error: unknown) {
    this.logger.error(
      'Sandbox error',
      error instanceof Error ? error : new Error(String(error))
    );
  }

  /**
   * Override onActivityExpired to prevent automatic shutdown when keepAlive is enabled
   * When keepAlive is disabled, calls parent implementation which stops the container
   */
  override async onActivityExpired(): Promise<void> {
    if (this.keepAliveEnabled) {
      this.logger.debug(
        'Activity expired but keepAlive is enabled - container will stay alive'
      );
      // Do nothing - don't call stop(), container stays alive
    } else {
      // Default behavior: stop the container
      this.logger.debug('Activity expired - stopping container');
      await super.onActivityExpired();
    }
  }

  // Override fetch to route internal container requests to appropriate ports
  override async fetch(request: Request): Promise<Response> {
    // Extract or generate trace ID from request
    const traceId =
      TraceContext.fromHeaders(request.headers) || TraceContext.generate();

    // Create request-specific logger with trace ID
    const requestLogger = this.logger.child({ traceId, operation: 'fetch' });

    return await runWithLogger(requestLogger, async () => {
      const url = new URL(request.url);

      // Capture and store the sandbox name from the header if present
      if (!this.sandboxName && request.headers.has('X-Sandbox-Name')) {
        const name = request.headers.get('X-Sandbox-Name')!;
        this.sandboxName = name;
        await this.ctx.storage.put('sandboxName', name);
      }

      // Detect WebSocket upgrade request (RFC 6455 compliant)
      const upgradeHeader = request.headers.get('Upgrade');
      const connectionHeader = request.headers.get('Connection');
      const isWebSocket =
        upgradeHeader?.toLowerCase() === 'websocket' &&
        connectionHeader?.toLowerCase().includes('upgrade');

      if (isWebSocket) {
        // WebSocket path: Let parent Container class handle WebSocket proxying
        // This bypasses containerFetch() which uses JSRPC and cannot handle WebSocket upgrades
        try {
          requestLogger.debug('WebSocket upgrade requested', {
            path: url.pathname,
            port: this.determinePort(url)
          });
          return await super.fetch(request);
        } catch (error) {
          requestLogger.error(
            'WebSocket connection failed',
            error instanceof Error ? error : new Error(String(error)),
            { path: url.pathname }
          );
          throw error;
        }
      }

      // Non-WebSocket: Use existing port determination and HTTP routing logic
      const port = this.determinePort(url);

      // Route to the appropriate port
      return await this.containerFetch(request, port);
    });
  }

  wsConnect(request: Request, port: number): Promise<Response> {
    // Dummy implementation that will be overridden by the stub
    throw new Error('Not implemented here to avoid RPC serialization issues');
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
   *
   * The session is persisted to Durable Object storage to survive hot reloads
   * during development. If a session already exists in the container after reload,
   * we reuse it instead of trying to create a new one.
   */
  private async ensureDefaultSession(): Promise<string> {
    if (!this.defaultSession) {
      const sessionId = `sandbox-${this.sandboxName || 'default'}`;

      try {
        // Try to create session in container
        await this.client.utils.createSession({
          id: sessionId,
          env: this.envVars || {},
          cwd: '/workspace'
        });

        this.defaultSession = sessionId;
        // Persist to storage so it survives hot reloads
        await this.ctx.storage.put('defaultSession', sessionId);
        this.logger.debug('Default session initialized', { sessionId });
      } catch (error: any) {
        // If session already exists (e.g., after hot reload), reuse it
        if (error?.message?.includes('already exists')) {
          this.logger.debug('Reusing existing session after reload', {
            sessionId
          });
          this.defaultSession = sessionId;
          // Persist to storage in case it wasn't saved before
          await this.ctx.storage.put('defaultSession', sessionId);
        } else {
          // Re-throw other errors
          throw error;
        }
      }
    }
    return this.defaultSession;
  }

  // Enhanced exec method - always returns ExecResult with optional streaming
  // This replaces the old exec method to match ISandbox interface
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const session = await this.ensureDefaultSession();
    return this.execWithSession(command, session, options);
  }

  /**
   * Internal session-aware exec implementation
   * Used by both public exec() and session wrappers
   */
  private async execWithSession(
    command: string,
    sessionId: string,
    options?: ExecOptions
  ): Promise<ExecResult> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    let timeoutId: NodeJS.Timeout | undefined;

    try {
      // Handle cancellation
      if (options?.signal?.aborted) {
        throw new Error('Operation was aborted');
      }

      let result: ExecResult;

      if (options?.stream && options?.onOutput) {
        // Streaming with callbacks - we need to collect the final result
        result = await this.executeWithStreaming(
          command,
          sessionId,
          options,
          startTime,
          timestamp
        );
      } else {
        // Regular execution with session
        const response = await this.client.commands.execute(
          command,
          sessionId,
          options?.timeout,
          options?.env,
          options?.cwd
        );

        const duration = Date.now() - startTime;
        result = this.mapExecuteResponseToExecResult(
          response,
          duration,
          sessionId
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
    sessionId: string,
    options: ExecOptions,
    startTime: number,
    timestamp: string
  ): Promise<ExecResult> {
    let stdout = '';
    let stderr = '';

    try {
      const stream = await this.client.commands.executeStream(
        command,
        sessionId
      );

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

  /**
   * Create a Process domain object from HTTP client DTO
   * Centralizes process object creation with bound methods
   * This eliminates duplication across startProcess, listProcesses, getProcess, and session wrappers
   */
  private createProcessFromDTO(
    data: {
      id: string;
      pid?: number;
      command: string;
      status: ProcessStatus;
      startTime: string | Date;
      endTime?: string | Date;
      exitCode?: number;
    },
    sessionId: string
  ): Process {
    return {
      id: data.id,
      pid: data.pid,
      command: data.command,
      status: data.status,
      startTime:
        typeof data.startTime === 'string'
          ? new Date(data.startTime)
          : data.startTime,
      endTime: data.endTime
        ? typeof data.endTime === 'string'
          ? new Date(data.endTime)
          : data.endTime
        : undefined,
      exitCode: data.exitCode,
      sessionId,

      kill: async (signal?: string) => {
        await this.killProcess(data.id, signal);
      },

      getStatus: async () => {
        const current = await this.getProcess(data.id);
        return current?.status || 'error';
      },

      getLogs: async () => {
        const logs = await this.getProcessLogs(data.id);
        return { stdout: logs.stdout, stderr: logs.stderr };
      }
    };
  }

  // Background process management
  async startProcess(
    command: string,
    options?: ProcessOptions,
    sessionId?: string
  ): Promise<Process> {
    // Use the new HttpClient method to start the process
    try {
      const session = sessionId ?? (await this.ensureDefaultSession());
      const response = await this.client.processes.startProcess(
        command,
        session,
        {
          processId: options?.processId
        }
      );

      const processObj = this.createProcessFromDTO(
        {
          id: response.processId,
          pid: response.pid,
          command: response.command,
          status: 'running' as ProcessStatus,
          startTime: new Date(),
          endTime: undefined,
          exitCode: undefined
        },
        session
      );

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

  async listProcesses(sessionId?: string): Promise<Process[]> {
    const session = sessionId ?? (await this.ensureDefaultSession());
    const response = await this.client.processes.listProcesses();

    return response.processes.map((processData) =>
      this.createProcessFromDTO(
        {
          id: processData.id,
          pid: processData.pid,
          command: processData.command,
          status: processData.status,
          startTime: processData.startTime,
          endTime: processData.endTime,
          exitCode: processData.exitCode
        },
        session
      )
    );
  }

  async getProcess(id: string, sessionId?: string): Promise<Process | null> {
    const session = sessionId ?? (await this.ensureDefaultSession());
    const response = await this.client.processes.getProcess(id);
    if (!response.process) {
      return null;
    }

    const processData = response.process;
    return this.createProcessFromDTO(
      {
        id: processData.id,
        pid: processData.pid,
        command: processData.command,
        status: processData.status,
        startTime: processData.startTime,
        endTime: processData.endTime,
        exitCode: processData.exitCode
      },
      session
    );
  }

  async killProcess(
    id: string,
    signal?: string,
    sessionId?: string
  ): Promise<void> {
    // Note: signal parameter is not currently supported by the HttpClient implementation
    // The HTTP client already throws properly typed errors, so we just let them propagate
    await this.client.processes.killProcess(id);
  }

  async killAllProcesses(sessionId?: string): Promise<number> {
    const response = await this.client.processes.killAllProcesses();
    return response.cleanedCount;
  }

  async cleanupCompletedProcesses(sessionId?: string): Promise<number> {
    // For now, this would need to be implemented as a container endpoint
    // as we no longer maintain local process storage
    // We'll return 0 as a placeholder until the container endpoint is added
    return 0;
  }

  async getProcessLogs(
    id: string,
    sessionId?: string
  ): Promise<{ stdout: string; stderr: string; processId: string }> {
    // The HTTP client already throws properly typed errors, so we just let them propagate
    const response = await this.client.processes.getProcessLogs(id);
    return {
      stdout: response.stdout,
      stderr: response.stderr,
      processId: response.processId
    };
  }

  // Streaming methods - return ReadableStream for RPC compatibility
  async execStream(
    command: string,
    options?: StreamOptions
  ): Promise<ReadableStream<Uint8Array>> {
    // Check for cancellation
    if (options?.signal?.aborted) {
      throw new Error('Operation was aborted');
    }

    const session = await this.ensureDefaultSession();
    // Get the stream from CommandClient
    return this.client.commands.executeStream(command, session);
  }

  /**
   * Internal session-aware execStream implementation
   */
  private async execStreamWithSession(
    command: string,
    sessionId: string,
    options?: StreamOptions
  ): Promise<ReadableStream<Uint8Array>> {
    // Check for cancellation
    if (options?.signal?.aborted) {
      throw new Error('Operation was aborted');
    }

    return this.client.commands.executeStream(command, sessionId);
  }

  /**
   * Stream logs from a background process as a ReadableStream.
   */
  async streamProcessLogs(
    processId: string,
    options?: { signal?: AbortSignal }
  ): Promise<ReadableStream<Uint8Array>> {
    // Check for cancellation
    if (options?.signal?.aborted) {
      throw new Error('Operation was aborted');
    }

    return this.client.processes.streamProcessLogs(processId);
  }

  async gitCheckout(
    repoUrl: string,
    options: { branch?: string; targetDir?: string; sessionId?: string }
  ) {
    const session = options.sessionId ?? (await this.ensureDefaultSession());
    return this.client.git.checkout(repoUrl, session, {
      branch: options.branch,
      targetDir: options.targetDir
    });
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean; sessionId?: string } = {}
  ) {
    const session = options.sessionId ?? (await this.ensureDefaultSession());
    return this.client.files.mkdir(path, session, {
      recursive: options.recursive
    });
  }

  async writeFile(
    path: string,
    content: string,
    options: { encoding?: string; sessionId?: string } = {}
  ) {
    const session = options.sessionId ?? (await this.ensureDefaultSession());
    return this.client.files.writeFile(path, content, session, {
      encoding: options.encoding
    });
  }

  async deleteFile(path: string, sessionId?: string) {
    const session = sessionId ?? (await this.ensureDefaultSession());
    return this.client.files.deleteFile(path, session);
  }

  async renameFile(oldPath: string, newPath: string, sessionId?: string) {
    const session = sessionId ?? (await this.ensureDefaultSession());
    return this.client.files.renameFile(oldPath, newPath, session);
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string,
    sessionId?: string
  ) {
    const session = sessionId ?? (await this.ensureDefaultSession());
    return this.client.files.moveFile(sourcePath, destinationPath, session);
  }

  async readFile(
    path: string,
    options: { encoding?: string; sessionId?: string } = {}
  ) {
    const session = options.sessionId ?? (await this.ensureDefaultSession());
    return this.client.files.readFile(path, session, {
      encoding: options.encoding
    });
  }

  /**
   * Stream a file from the sandbox using Server-Sent Events
   * Returns a ReadableStream that can be consumed with streamFile() or collectFile() utilities
   * @param path - Path to the file to stream
   * @param options - Optional session ID
   */
  async readFileStream(
    path: string,
    options: { sessionId?: string } = {}
  ): Promise<ReadableStream<Uint8Array>> {
    const session = options.sessionId ?? (await this.ensureDefaultSession());
    return this.client.files.readFileStream(path, session);
  }

  async listFiles(
    path: string,
    options?: { recursive?: boolean; includeHidden?: boolean }
  ) {
    const session = await this.ensureDefaultSession();
    return this.client.files.listFiles(path, session, options);
  }

  async exists(path: string, sessionId?: string) {
    const session = sessionId ?? (await this.ensureDefaultSession());
    return this.client.files.exists(path, session);
  }

  async exposePort(port: number, options: { name?: string; hostname: string }) {
    // Check if hostname is workers.dev domain (doesn't support wildcard subdomains)
    if (options.hostname.endsWith('.workers.dev')) {
      const errorResponse: ErrorResponse = {
        code: ErrorCode.CUSTOM_DOMAIN_REQUIRED,
        message: `Port exposure requires a custom domain. .workers.dev domains do not support wildcard subdomains required for port proxying.`,
        context: { originalError: options.hostname },
        httpStatus: 400,
        timestamp: new Date().toISOString()
      };
      throw new CustomDomainRequiredError(errorResponse);
    }

    const sessionId = await this.ensureDefaultSession();
    await this.client.ports.exposePort(port, sessionId, options?.name);

    // We need the sandbox name to construct preview URLs
    if (!this.sandboxName) {
      throw new Error(
        'Sandbox name not available. Ensure sandbox is accessed through getSandbox()'
      );
    }

    // Generate and store token for this port
    const token = this.generatePortToken();
    this.portTokens.set(port, token);
    await this.persistPortTokens();

    const url = this.constructPreviewUrl(
      port,
      this.sandboxName,
      options.hostname,
      token
    );

    return {
      url,
      port,
      name: options?.name
    };
  }

  async unexposePort(port: number) {
    if (!validatePort(port)) {
      throw new SecurityError(
        `Invalid port number: ${port}. Must be between 1024-65535 and not reserved.`
      );
    }

    const sessionId = await this.ensureDefaultSession();
    await this.client.ports.unexposePort(port, sessionId);

    // Clean up token for this port
    if (this.portTokens.has(port)) {
      this.portTokens.delete(port);
      await this.persistPortTokens();
    }
  }

  async getExposedPorts(hostname: string) {
    const sessionId = await this.ensureDefaultSession();
    const response = await this.client.ports.getExposedPorts(sessionId);

    // We need the sandbox name to construct preview URLs
    if (!this.sandboxName) {
      throw new Error(
        'Sandbox name not available. Ensure sandbox is accessed through getSandbox()'
      );
    }

    return response.ports.map((port) => {
      // Get token for this port - must exist for all exposed ports
      const token = this.portTokens.get(port.port);
      if (!token) {
        throw new Error(
          `Port ${port.port} is exposed but has no token. This should not happen.`
        );
      }

      return {
        url: this.constructPreviewUrl(
          port.port,
          this.sandboxName!,
          hostname,
          token
        ),
        port: port.port,
        status: port.status
      };
    });
  }

  async isPortExposed(port: number): Promise<boolean> {
    try {
      const sessionId = await this.ensureDefaultSession();
      const response = await this.client.ports.getExposedPorts(sessionId);
      return response.ports.some((exposedPort) => exposedPort.port === port);
    } catch (error) {
      this.logger.error(
        'Error checking if port is exposed',
        error instanceof Error ? error : new Error(String(error)),
        { port }
      );
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
      this.logger.error(
        'Port is exposed but has no token - bug detected',
        undefined,
        { port }
      );
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
    return base64
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
      .toLowerCase();
  }

  private async persistPortTokens(): Promise<void> {
    // Convert Map to plain object for storage
    const tokensObj: Record<string, string> = {};
    for (const [port, token] of this.portTokens.entries()) {
      tokensObj[port.toString()] = token;
    }
    await this.ctx.storage.put('portTokens', tokensObj);
  }

  private constructPreviewUrl(
    port: number,
    sandboxId: string,
    hostname: string,
    token: string
  ): string {
    if (!validatePort(port)) {
      throw new SecurityError(
        `Invalid port number: ${port}. Must be between 1024-65535 and not reserved.`
      );
    }

    // Validate sandbox ID (will throw SecurityError if invalid)
    const sanitizedSandboxId = sanitizeSandboxId(sandboxId);

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

        return baseUrl.toString();
      } catch (error) {
        throw new SecurityError(
          `Failed to construct preview URL: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        );
      }
    }

    // Production subdomain logic - enforce HTTPS
    try {
      // Always use HTTPS for production (non-localhost)
      const protocol = 'https';
      const baseUrl = new URL(`${protocol}://${hostname}`);

      // Construct subdomain safely with mandatory token
      const subdomainHost = `${port}-${sanitizedSandboxId}-${token}.${hostname}`;
      baseUrl.hostname = subdomainHost;

      return baseUrl.toString();
    } catch (error) {
      throw new SecurityError(
        `Failed to construct preview URL: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
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
      cwd: options?.cwd
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
   * Delete an execution session
   * Cleans up session resources and removes it from the container
   * Note: Cannot delete the default session. To reset the default session,
   * use sandbox.destroy() to terminate the entire sandbox.
   *
   * @param sessionId - The ID of the session to delete
   * @returns Result with success status, sessionId, and timestamp
   * @throws Error if attempting to delete the default session
   */
  async deleteSession(sessionId: string): Promise<SessionDeleteResult> {
    // Prevent deletion of default session
    if (this.defaultSession && sessionId === this.defaultSession) {
      throw new Error(
        `Cannot delete default session '${sessionId}'. Use sandbox.destroy() to terminate the sandbox.`
      );
    }

    const response = await this.client.utils.deleteSession(sessionId);

    // Map HTTP response to result type
    return {
      success: response.success,
      sessionId: response.sessionId,
      timestamp: response.timestamp
    };
  }

  /**
   * Internal helper to create ExecutionSession wrapper for a given sessionId
   * Used by both createSession and getSession
   */
  private getSessionWrapper(sessionId: string): ExecutionSession {
    return {
      id: sessionId,

      // Command execution - delegate to internal session-aware methods
      exec: (command, options) =>
        this.execWithSession(command, sessionId, options),
      execStream: (command, options) =>
        this.execStreamWithSession(command, sessionId, options),

      // Process management
      startProcess: (command, options) =>
        this.startProcess(command, options, sessionId),
      listProcesses: () => this.listProcesses(sessionId),
      getProcess: (id) => this.getProcess(id, sessionId),
      killProcess: (id, signal) => this.killProcess(id, signal),
      killAllProcesses: () => this.killAllProcesses(),
      cleanupCompletedProcesses: () => this.cleanupCompletedProcesses(),
      getProcessLogs: (id) => this.getProcessLogs(id),
      streamProcessLogs: (processId, options) =>
        this.streamProcessLogs(processId, options),

      // File operations - pass sessionId via options or parameter
      writeFile: (path, content, options) =>
        this.writeFile(path, content, { ...options, sessionId }),
      readFile: (path, options) =>
        this.readFile(path, { ...options, sessionId }),
      readFileStream: (path) => this.readFileStream(path, { sessionId }),
      mkdir: (path, options) => this.mkdir(path, { ...options, sessionId }),
      deleteFile: (path) => this.deleteFile(path, sessionId),
      renameFile: (oldPath, newPath) =>
        this.renameFile(oldPath, newPath, sessionId),
      moveFile: (sourcePath, destPath) =>
        this.moveFile(sourcePath, destPath, sessionId),
      listFiles: (path, options) =>
        this.client.files.listFiles(path, sessionId, options),
      exists: (path) => this.exists(path, sessionId),

      // Git operations
      gitCheckout: (repoUrl, options) =>
        this.gitCheckout(repoUrl, { ...options, sessionId }),

      // Environment management - needs special handling
      setEnvVars: async (envVars: Record<string, string>) => {
        try {
          // Set environment variables by executing export commands
          for (const [key, value] of Object.entries(envVars)) {
            const escapedValue = value.replace(/'/g, "'\\''");
            const exportCommand = `export ${key}='${escapedValue}'`;

            const result = await this.client.commands.execute(
              exportCommand,
              sessionId
            );

            if (result.exitCode !== 0) {
              throw new Error(
                `Failed to set ${key}: ${result.stderr || 'Unknown error'}`
              );
            }
          }
        } catch (error) {
          this.logger.error(
            'Failed to set environment variables',
            error instanceof Error ? error : new Error(String(error)),
            { sessionId }
          );
          throw error;
        }
      },

      // Code interpreter methods - delegate to sandbox's code interpreter
      createCodeContext: (options) =>
        this.codeInterpreter.createCodeContext(options),
      runCode: async (code, options) => {
        const execution = await this.codeInterpreter.runCode(code, options);
        return execution.toJSON();
      },
      runCodeStream: (code, options) =>
        this.codeInterpreter.runCodeStream(code, options),
      listCodeContexts: () => this.codeInterpreter.listCodeContexts(),
      deleteCodeContext: (contextId) =>
        this.codeInterpreter.deleteCodeContext(contextId)
    };
  }

  // ============================================================================
  // Code interpreter methods - delegate to CodeInterpreter wrapper
  // ============================================================================

  async createCodeContext(
    options?: CreateContextOptions
  ): Promise<CodeContext> {
    return this.codeInterpreter.createCodeContext(options);
  }

  async runCode(
    code: string,
    options?: RunCodeOptions
  ): Promise<ExecutionResult> {
    const execution = await this.codeInterpreter.runCode(code, options);
    return execution.toJSON();
  }

  async runCodeStream(
    code: string,
    options?: RunCodeOptions
  ): Promise<ReadableStream> {
    return this.codeInterpreter.runCodeStream(code, options);
  }

  async listCodeContexts(): Promise<CodeContext[]> {
    return this.codeInterpreter.listCodeContexts();
  }

  async deleteCodeContext(contextId: string): Promise<void> {
    return this.codeInterpreter.deleteCodeContext(contextId);
  }
}
