import { Container, getContainer } from "@cloudflare/containers";
import { HttpClient } from "./client";
import { isLocalhostPattern } from "./request-handler";
import type {
  ExecEvent,
  ExecOptions,
  ExecResult,
  ISandbox,
  LogEvent,
  Process,
  ProcessOptions,
  ProcessStatus,
  StreamOptions
} from "./types";
import {
  ProcessNotFoundError,
  SandboxError
} from "./types";

export function getSandbox(ns: DurableObjectNamespace<Sandbox>, id: string) {
  const stub = getContainer(ns, id);

  // Store the name on first access
  stub.setSandboxName?.(id);

  return stub;
}

export class Sandbox<Env = unknown> extends Container<Env> implements ISandbox {
  sleepAfter = "3m"; // Sleep the sandbox if no requests are made in this timeframe
  client: HttpClient;
  private workerHostname: string | null = null;
  private sandboxName: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.client = new HttpClient({
      onCommandComplete: (success, exitCode, _stdout, _stderr, command, _args) => {
        console.log(
          `[Container] Command completed: ${command}, Success: ${success}, Exit code: ${exitCode}`
        );
      },
      onCommandStart: (command, args) => {
        console.log(
          `[Container] Command started: ${command} ${args.join(" ")}`
        );
      },
      onError: (error, _command, _args) => {
        console.error(`[Container] Command error: ${error}`);
      },
      onOutput: (stream, data, _command) => {
        console.log(`[Container] [${stream}] ${data}`);
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
      this.client.clearSession();
    }
  }

  override onError(error: unknown) {
    console.log("Sandbox error:", error);
  }

  // Override fetch to capture the hostname and route to appropriate ports
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Capture the hostname from the first request
    if (!this.workerHostname) {
      this.workerHostname = url.hostname;
      console.log(`[Sandbox] Captured hostname: ${this.workerHostname}`);
    }

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
  async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
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
        result = await this.executeWithStreaming(command, args, options, startTime, timestamp);
      } else {
        // Regular execution
        const response = await this.client.execute(
          command,
          args,
          options?.sessionId,
          false // Never use background for enhanced exec
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
    args: string[],
    options: ExecOptions,
    startTime: number,
    timestamp: string
  ): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let completed = false;

      // Set up temporary handlers to capture output and completion
      const originalOnOutput = this.client.getOnOutput();
      const originalOnCommandComplete = this.client.getOnCommandComplete();

      const tempOnOutput = (stream: 'stdout' | 'stderr', data: string, cmd: string) => {
        if (cmd === command) {
          if (stream === 'stdout') stdout += data;
          if (stream === 'stderr') stderr += data;

          // Call user's callback
          if (options.onOutput) {
            options.onOutput(stream, data);
          }
        }
        // Call original handler if it exists
        originalOnOutput?.(stream, data, cmd);
      };

      const tempOnCommandComplete = (
        success: boolean,
        exitCode: number,
        finalStdout: string,
        finalStderr: string,
        cmd: string,
        cmdArgs: string[]
      ) => {
        if (cmd === command && !completed) {
          completed = true;

          // Use final output from command completion (more reliable)
          const duration = Date.now() - startTime;
          const result: ExecResult = {
            success,
            exitCode,
            stdout: finalStdout,
            stderr: finalStderr,
            command,
            args,
            duration,
            timestamp,
            sessionId: options.sessionId
          };

          // Restore original handlers
          this.client.setOnOutput(originalOnOutput || (() => {}));
          this.client.setOnCommandComplete(originalOnCommandComplete || (() => {}));

          resolve(result);
        }

        // Call original handler if it exists
        originalOnCommandComplete?.(success, exitCode, finalStdout, finalStderr, cmd, cmdArgs);
      };

      // Set temporary handlers
      this.client.setOnOutput(tempOnOutput);
      this.client.setOnCommandComplete(tempOnCommandComplete);

      // Handle cancellation
      const abortHandler = () => {
        if (!completed) {
          completed = true;
          // Restore original handlers
          this.client.setOnOutput(originalOnOutput || (() => {}));
          this.client.setOnCommandComplete(originalOnCommandComplete || (() => {}));
          reject(new Error('Operation was aborted'));
        }
      };

      if (options.signal) {
        options.signal.addEventListener('abort', abortHandler, { once: true });
      }

      // Start streaming execution
      this.client.executeStream(command, args, options.sessionId, false)
        .catch(error => {
          if (!completed) {
            completed = true;
            // Restore original handlers
            this.client.setOnOutput(originalOnOutput || (() => {}));
            this.client.setOnCommandComplete(originalOnCommandComplete || (() => {}));

            if (options.signal) {
              options.signal.removeEventListener('abort', abortHandler);
            }
            reject(error);
          }
        });
    });
  }

  private mapExecuteResponseToExecResult(
    response: import('./client').ExecuteResponse,
    duration: number,
    sessionId?: string
  ): ExecResult {
    return {
      success: response.success,
      exitCode: response.exitCode,
      stdout: response.stdout,
      stderr: response.stderr,
      command: response.command,
      args: response.args,
      duration,
      timestamp: response.timestamp,
      sessionId
    };
  }

  // Legacy exec method for backwards compatibility
  async execLegacy(command: string, args: string[], options?: { stream?: boolean; background?: boolean }) {
    if (options?.stream) {
      return this.client.executeStream(command, args, undefined, options?.background);
    }
    return this.client.execute(command, args, undefined, options?.background);
  }

  // Background process management
  async startProcess(command: string, args: string[], options?: ProcessOptions): Promise<Process> {
    // Use the new HttpClient method to start the process
    try {
      const response = await this.client.startProcess(command, args, {
        processId: options?.processId,
        sessionId: options?.sessionId,
        timeout: options?.timeout,
        env: options?.env,
        cwd: options?.cwd,
        encoding: options?.encoding,
        autoCleanup: options?.autoCleanup
      });

      const process = response.process;
      const processObj: Process = {
        id: process.id,
        pid: process.pid,
        command: process.command,
        args: process.args,
        status: process.status as ProcessStatus,
        startTime: new Date(process.startTime),
        endTime: undefined,
        exitCode: undefined,
        sessionId: process.sessionId,

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
    const response = await this.client.listProcesses();

    return response.processes.map(processData => ({
      id: processData.id,
      pid: processData.pid,
      command: processData.command,
      args: processData.args,
      status: processData.status,
      startTime: new Date(processData.startTime),
      endTime: processData.endTime ? new Date(processData.endTime) : undefined,
      exitCode: processData.exitCode,
      sessionId: processData.sessionId,

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
    const response = await this.client.getProcess(id);
    if (!response.process) {
      return null;
    }

    const processData = response.process;
    return {
      id: processData.id,
      pid: processData.pid,
      command: processData.command,
      args: processData.args,
      status: processData.status,
      startTime: new Date(processData.startTime),
      endTime: processData.endTime ? new Date(processData.endTime) : undefined,
      exitCode: processData.exitCode,
      sessionId: processData.sessionId,

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

  async killProcess(id: string, signal?: string): Promise<void> {
    try {
      // Note: signal parameter is not currently supported by the HttpClient implementation
      await this.client.killProcess(id);
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
    const response = await this.client.killAllProcesses();
    return response.killedCount;
  }

  async cleanupCompletedProcesses(): Promise<number> {
    // For now, this would need to be implemented as a container endpoint
    // as we no longer maintain local process storage
    // We'll return 0 as a placeholder until the container endpoint is added
    return 0;
  }

  async getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }> {
    try {
      const response = await this.client.getProcessLogs(id);
      return {
        stdout: response.stdout,
        stderr: response.stderr
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('Process not found')) {
        throw new ProcessNotFoundError(id);
      }
      throw error;
    }
  }


  // AsyncIterable streaming methods
  async *execStream(command: string, args: string[], options?: StreamOptions): AsyncIterable<ExecEvent> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    // Emit start event
    yield {
      type: 'start',
      timestamp,
      command,
      args
    };

    try {
      let stdout = '';
      let stderr = '';
      let completed = false;
      let error: Error | undefined;

      // Set up event handling with Promise/AsyncIterable coordination
      const events: ExecEvent[] = [];
      let eventResolve: ((value: ExecEvent) => void) | undefined;
      let pendingEvent: Promise<ExecEvent> | undefined;

      const originalOnOutput = this.client.getOnOutput();
      const originalOnCommandComplete = this.client.getOnCommandComplete();

      const tempOnOutput = (stream: 'stdout' | 'stderr', data: string, cmd: string) => {
        if (cmd === command) {
          if (stream === 'stdout') stdout += data;
          if (stream === 'stderr') stderr += data;

          const event: ExecEvent = {
            type: stream,
            timestamp: new Date().toISOString(),
            data
          };

          if (eventResolve) {
            eventResolve(event);
            eventResolve = undefined;
            pendingEvent = undefined;
          } else {
            events.push(event);
          }
        }
        originalOnOutput?.(stream, data, cmd);
      };

      const tempOnCommandComplete = (
        success: boolean,
        exitCode: number,
        finalStdout: string,
        finalStderr: string,
        cmd: string,
        cmdArgs: string[]
      ) => {
        if (cmd === command && !completed) {
          completed = true;

          const duration = Date.now() - startTime;
          const result: ExecResult = {
            success,
            exitCode,
            stdout: finalStdout,
            stderr: finalStderr,
            command,
            args,
            duration,
            timestamp,
            sessionId: options?.sessionId
          };

          const event: ExecEvent = {
            type: 'complete',
            timestamp: new Date().toISOString(),
            exitCode,
            result
          };

          if (eventResolve) {
            eventResolve(event);
            eventResolve = undefined;
            pendingEvent = undefined;
          } else {
            events.push(event);
          }

          // Restore handlers
          this.client.setOnOutput(originalOnOutput || (() => {}));
          this.client.setOnCommandComplete(originalOnCommandComplete || (() => {}));
        }
        originalOnCommandComplete?.(success, exitCode, finalStdout, finalStderr, cmd, cmdArgs);
      };

      // Set up temporary handlers
      this.client.setOnOutput(tempOnOutput);
      this.client.setOnCommandComplete(tempOnCommandComplete);

      // Start the command
      const streamPromise = this.client.executeStream(command, args, options?.sessionId, false)
        .catch(err => {
          error = err instanceof Error ? err : new Error(String(err));
          completed = true;

          // Restore handlers
          this.client.setOnOutput(originalOnOutput || (() => {}));
          this.client.setOnCommandComplete(originalOnCommandComplete || (() => {}));

          const errorEvent: ExecEvent = {
            type: 'error',
            timestamp: new Date().toISOString(),
            error
          };

          if (eventResolve) {
            eventResolve(errorEvent);
            eventResolve = undefined;
            pendingEvent = undefined;
          } else {
            events.push(errorEvent);
          }
        });

      // Yield events as they come
      while (!completed || events.length > 0) {
        if (options?.signal?.aborted) {
          throw new Error('Operation was aborted');
        }

        if (events.length > 0) {
          const event = events.shift()!;
          yield event;

          if (event.type === 'complete' || event.type === 'error') {
            break;
          }
        } else if (!completed) {
          // Wait for next event
          pendingEvent = new Promise<ExecEvent>((resolve) => {
            eventResolve = resolve;
          });

          const event = await pendingEvent;
          yield event;

          if (event.type === 'complete' || event.type === 'error') {
            break;
          }
        } else {
          break;
        }
      }

      // Wait for the stream to complete
      await streamPromise;

      if (error) {
        throw error;
      }

    } catch (err) {
      // Emit error event if we haven't already
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err : new Error(String(err))
      };
      throw err;
    }
  }

  async *streamProcessLogs(processId: string, options?: { signal?: AbortSignal }): AsyncIterable<LogEvent> {
    // Check for cancellation
    if (options?.signal?.aborted) {
      throw new Error('Operation was aborted');
    }

    try {
      // Get the stream from HttpClient
      const stream = await this.client.streamProcessLogs(processId);
      const reader = stream.getReader();

      try {
        while (true) {
          if (options?.signal?.aborted) {
            throw new Error('Operation was aborted');
          }

          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          // Parse the Server-Sent Events format
          const text = new TextDecoder().decode(value);
          const lines = text.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.substring(6));
                yield {
                  type: data.type,
                  timestamp: data.timestamp,
                  data: data.data,
                  processId,
                  sessionId: data.sessionId
                };
              } catch (parseError) {
                // Skip malformed lines
                console.warn('Failed to parse SSE data:', line, parseError);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Process not found')) {
        throw new ProcessNotFoundError(processId);
      }
      throw error;
    }
  }

  async gitCheckout(
    repoUrl: string,
    options: { branch?: string; targetDir?: string; stream?: boolean }
  ) {
    if (options?.stream) {
      return this.client.gitCheckoutStream(
        repoUrl,
        options.branch,
        options.targetDir
      );
    }
    return this.client.gitCheckout(repoUrl, options.branch, options.targetDir);
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean; stream?: boolean } = {}
  ) {
    if (options?.stream) {
      return this.client.mkdirStream(path, options.recursive);
    }
    return this.client.mkdir(path, options.recursive);
  }

  async writeFile(
    path: string,
    content: string,
    options: { encoding?: string; stream?: boolean } = {}
  ) {
    if (options?.stream) {
      return this.client.writeFileStream(path, content, options.encoding);
    }
    return this.client.writeFile(path, content, options.encoding);
  }

  async deleteFile(path: string, options: { stream?: boolean } = {}) {
    if (options?.stream) {
      return this.client.deleteFileStream(path);
    }
    return this.client.deleteFile(path);
  }

  async renameFile(
    oldPath: string,
    newPath: string,
    options: { stream?: boolean } = {}
  ) {
    if (options?.stream) {
      return this.client.renameFileStream(oldPath, newPath);
    }
    return this.client.renameFile(oldPath, newPath);
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string,
    options: { stream?: boolean } = {}
  ) {
    if (options?.stream) {
      return this.client.moveFileStream(sourcePath, destinationPath);
    }
    return this.client.moveFile(sourcePath, destinationPath);
  }

  async readFile(
    path: string,
    options: { encoding?: string; stream?: boolean } = {}
  ) {
    if (options?.stream) {
      return this.client.readFileStream(path, options.encoding);
    }
    return this.client.readFile(path, options.encoding);
  }

  async exposePort(port: number, options?: { name?: string }) {
    await this.client.exposePort(port, options?.name);

    // We need the sandbox name to construct preview URLs
    if (!this.sandboxName) {
      throw new Error('Sandbox name not available. Ensure sandbox is accessed through getSandbox()');
    }

    const hostname = this.getHostname();
    const url = this.constructPreviewUrl(port, this.sandboxName, hostname);

    return {
      url,
      port,
      name: options?.name,
    };
  }

  async unexposePort(port: number) {
    await this.client.unexposePort(port);
  }

  async getExposedPorts() {
    const response = await this.client.getExposedPorts();

    // We need the sandbox name to construct preview URLs
    if (!this.sandboxName) {
      throw new Error('Sandbox name not available. Ensure sandbox is accessed through getSandbox()');
    }

    const hostname = this.getHostname();

    return response.ports.map(port => ({
      url: this.constructPreviewUrl(port.port, this.sandboxName!, hostname),
      port: port.port,
      name: port.name,
      exposedAt: port.exposedAt,
    }));
  }

  private getHostname(): string {
    // Use the captured hostname or fall back to localhost for development
    return this.workerHostname || "localhost:8787";
  }

  private constructPreviewUrl(port: number, sandboxId: string, hostname: string): string {
    // Check if this is a localhost pattern
    const isLocalhost = isLocalhostPattern(hostname);

    if (isLocalhost) {
      // For local development, we need to use a different approach
      // Since subdomains don't work with localhost, we'll use the base URL
      // with a note that the user needs to handle routing differently
      return `http://${hostname}/preview/${port}/${sandboxId}`;
    }

    // For all other domains (workers.dev, custom domains, etc.)
    // Use subdomain-based routing pattern
    const protocol = hostname.includes(":") ? "http" : "https";
    return `${protocol}://${port}-${sandboxId}.${hostname}`;
  }
}
