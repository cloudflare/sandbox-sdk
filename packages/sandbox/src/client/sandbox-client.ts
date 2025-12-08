import type {
  CodeContext,
  CreateContextOptions,
  DeleteFileResult,
  ExecOptions,
  ExecResult,
  ExecutionResult,
  ExecutionSession,
  FileExistsResult,
  GitCheckoutResult,
  ISandbox,
  ListFilesOptions,
  ListFilesResult,
  MkdirResult,
  MountBucketOptions,
  MoveFileResult,
  Process,
  ProcessOptions,
  ReadFileResult,
  RenameFileResult,
  RunCodeOptions,
  SessionDeleteResult,
  SessionOptions,
  StreamOptions,
  WaitForLogResult,
  WaitForPortOptions,
  WriteFileResult
} from '@repo/shared';
import { HttpClient, type HttpClientOptions } from './http-client';

/**
 * Client-side Sandbox implementation that communicates with a bridge Worker
 * This allows accessing Sandbox from any platform via HTTP
 */
export class BridgeSandboxClient implements ISandbox {
  private readonly http: HttpClient;
  readonly id: string;

  constructor(
    sandboxId: string,
    options: Omit<HttpClientOptions, 'sandboxId'>
  ) {
    this.id = sandboxId;
    this.http = new HttpClient({ ...options, sandboxId });
  }

  // =========================================================================
  // Command Execution
  // =========================================================================

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return this.http.request<ExecResult>('POST', '/exec', { command, options });
  }

  async execStream(
    command: string,
    options?: StreamOptions
  ): Promise<ReadableStream<Uint8Array>> {
    return this.http.requestStream('POST', '/exec/stream', {
      command,
      options
    });
  }

  // =========================================================================
  // Process Management
  // =========================================================================

  async startProcess(
    command: string,
    options?: ProcessOptions
  ): Promise<Process> {
    const result = await this.http.request<{
      processId: string;
      pid?: number;
      command: string;
      status: string;
      startTime?: string;
      sessionId?: string;
    }>('POST', '/processes/start', { command, options });

    return this.createProcessProxy(result.processId, result);
  }

  async listProcesses(): Promise<Process[]> {
    const result = await this.http.request<{
      processes: Array<{
        processId: string;
        pid?: number;
        command: string;
        status: string;
        startTime?: string;
        sessionId?: string;
      }>;
    }>('GET', '/processes');
    return result.processes.map((p) => this.createProcessProxy(p.processId, p));
  }

  async getProcess(id: string): Promise<Process | null> {
    try {
      const result = await this.http.request<{
        processId: string;
        pid?: number;
        command: string;
        status: string;
        startTime?: string;
        sessionId?: string;
      }>('GET', `/processes/${id}`);
      return this.createProcessProxy(id, result);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('NOT_FOUND')) {
        return null;
      }
      throw error;
    }
  }

  async killProcess(id: string, signal?: string): Promise<void> {
    await this.http.request(
      'DELETE',
      `/processes/${id}`,
      signal ? { signal } : undefined
    );
  }

  async killAllProcesses(): Promise<number> {
    const processes = await this.listProcesses();
    let killed = 0;
    for (const process of processes) {
      try {
        await this.killProcess(process.id);
        killed++;
      } catch {
        // Ignore errors for individual processes
      }
    }
    return killed;
  }

  async cleanupCompletedProcesses(): Promise<number> {
    const result = await this.http.request<{ cleaned: number }>(
      'POST',
      '/processes/cleanup'
    );
    return result.cleaned;
  }

  async getProcessLogs(
    id: string
  ): Promise<{ stdout: string; stderr: string; processId: string }> {
    return this.http.request('GET', `/processes/${id}/logs`);
  }

  async streamProcessLogs(
    processId: string,
    _options?: { signal?: AbortSignal }
  ): Promise<ReadableStream<Uint8Array>> {
    return this.http.requestStream(
      'GET',
      `/processes/${processId}/logs/stream`
    );
  }

  // =========================================================================
  // File Operations
  // =========================================================================

  async writeFile(
    path: string,
    content: string,
    options?: { encoding?: string }
  ): Promise<WriteFileResult> {
    return this.http.request('POST', '/files/write', {
      path,
      content,
      options
    });
  }

  async readFile(
    path: string,
    options?: { encoding?: string }
  ): Promise<ReadFileResult> {
    const params = new URLSearchParams({ path });
    if (options?.encoding) params.set('encoding', options.encoding);
    return this.http.request('GET', `/files/read?${params}`);
  }

  async readFileStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const params = new URLSearchParams({ path });
    return this.http.requestStream('GET', `/files/read/stream?${params}`);
  }

  async mkdir(
    path: string,
    options?: { recursive?: boolean }
  ): Promise<MkdirResult> {
    return this.http.request('POST', '/files/mkdir', { path, options });
  }

  async deleteFile(path: string): Promise<DeleteFileResult> {
    return this.http.request('POST', '/files/delete', { path });
  }

  async renameFile(
    oldPath: string,
    newPath: string
  ): Promise<RenameFileResult> {
    return this.http.request('POST', '/files/rename', { oldPath, newPath });
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string
  ): Promise<MoveFileResult> {
    return this.http.request('POST', '/files/move', {
      sourcePath,
      destinationPath
    });
  }

  async listFiles(
    path: string,
    options?: ListFilesOptions
  ): Promise<ListFilesResult> {
    const params = new URLSearchParams({ path });
    if (options?.recursive) params.set('recursive', 'true');
    if (options?.includeHidden) params.set('includeHidden', 'true');
    return this.http.request('GET', `/files/list?${params}`);
  }

  async exists(path: string, _sessionId?: string): Promise<FileExistsResult> {
    const params = new URLSearchParams({ path });
    return this.http.request('GET', `/files/exists?${params}`);
  }

  // =========================================================================
  // Git Operations
  // =========================================================================

  async gitCheckout(
    repoUrl: string,
    options?: { branch?: string; targetDir?: string }
  ): Promise<GitCheckoutResult> {
    return this.http.request('POST', '/git/checkout', { repoUrl, options });
  }

  // =========================================================================
  // Environment Management
  // =========================================================================

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    await this.http.request('POST', '/env', { envVars });
  }

  // =========================================================================
  // Session Management
  // =========================================================================

  async createSession(options?: SessionOptions): Promise<ExecutionSession> {
    const result = await this.http.request<{ sessionId: string }>(
      'POST',
      '/sessions',
      { options }
    );
    return this.createSessionProxy(result.sessionId);
  }

  async deleteSession(sessionId: string): Promise<SessionDeleteResult> {
    return this.http.request('DELETE', `/sessions/${sessionId}`);
  }

  // =========================================================================
  // Code Interpreter
  // =========================================================================

  async createCodeContext(
    options?: CreateContextOptions
  ): Promise<CodeContext> {
    return this.http.request('POST', '/code/contexts', { options });
  }

  async runCode(
    code: string,
    options?: RunCodeOptions
  ): Promise<ExecutionResult> {
    return this.http.request('POST', '/code/run', { code, options });
  }

  async runCodeStream(
    code: string,
    options?: RunCodeOptions
  ): Promise<ReadableStream<Uint8Array>> {
    return this.http.requestStream('POST', '/code/run/stream', {
      code,
      options
    });
  }

  async listCodeContexts(): Promise<CodeContext[]> {
    const result = await this.http.request<{ contexts: CodeContext[] }>(
      'GET',
      '/code/contexts'
    );
    return result.contexts;
  }

  async deleteCodeContext(contextId: string): Promise<void> {
    await this.http.request('DELETE', `/code/contexts/${contextId}`);
  }

  // =========================================================================
  // Bucket Mounting - Not supported via bridge
  // =========================================================================

  async mountBucket(
    _bucket: string,
    _mountPath: string,
    _options: MountBucketOptions
  ): Promise<void> {
    throw new Error(
      'mountBucket is not supported via HTTP bridge - use direct DO connection'
    );
  }

  async unmountBucket(_mountPath: string): Promise<void> {
    throw new Error(
      'unmountBucket is not supported via HTTP bridge - use direct DO connection'
    );
  }

  // =========================================================================
  // WebSocket - Not supported via bridge
  // =========================================================================

  async wsConnect(_request: Request, _port: number): Promise<Response> {
    throw new Error(
      'wsConnect is not supported via HTTP bridge - use direct DO connection'
    );
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private createProcessProxy(
    processId: string,
    data: {
      pid?: number;
      command: string;
      status: string;
      startTime?: string;
      sessionId?: string;
    }
  ): Process {
    const client = this;
    return {
      id: processId,
      pid: data.pid,
      command: data.command,
      status: data.status as 'running' | 'completed' | 'failed' | 'killed',
      startTime: data.startTime ? new Date(data.startTime) : new Date(),
      endTime: undefined,
      exitCode: undefined,
      sessionId: data.sessionId,
      async kill(signal?: string) {
        await client.killProcess(processId, signal);
      },
      async getStatus() {
        const process = await client.getProcess(processId);
        return process?.status || 'error';
      },
      async getLogs() {
        const logs = await client.getProcessLogs(processId);
        return { stdout: logs.stdout, stderr: logs.stderr };
      },
      async waitForLog(
        pattern: string | RegExp,
        timeout?: number
      ): Promise<WaitForLogResult> {
        // Basic implementation - poll for log matching pattern
        const startTime = Date.now();
        const maxWait = timeout || 30000;
        while (Date.now() - startTime < maxWait) {
          const logs = await client.getProcessLogs(processId);
          const combined = logs.stdout + logs.stderr;
          const lines = combined.split('\n');
          for (const line of lines) {
            if (typeof pattern === 'string') {
              if (line.includes(pattern)) {
                return { line, match: undefined };
              }
            } else {
              const match = line.match(pattern);
              if (match) {
                return { line, match };
              }
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`Timeout waiting for log pattern: ${pattern}`);
      },
      async waitForPort(
        _port: number,
        _options?: WaitForPortOptions
      ): Promise<void> {
        // This is a complex operation that requires polling - simplified stub
        throw new Error('waitForPort not fully implemented in bridge client');
      }
    };
  }

  private createSessionProxy(sessionId: string): ExecutionSession {
    const client = this;
    return {
      id: sessionId,
      async exec(command: string, options?: ExecOptions) {
        return client.http.request<ExecResult>('POST', '/exec', {
          command,
          options,
          sessionId
        });
      },
      async execStream(command: string, options?: StreamOptions) {
        return client.http.requestStream('POST', '/exec/stream', {
          command,
          options,
          sessionId
        });
      },
      async startProcess(command: string, options?: ProcessOptions) {
        // Note: sessionId is not part of ProcessOptions per the shared types
        // Session context is handled separately in the bridge
        return client.startProcess(command, options);
      },
      async listProcesses() {
        return client.listProcesses();
      },
      async getProcess(id: string) {
        return client.getProcess(id);
      },
      async killProcess(id: string, signal?: string) {
        return client.killProcess(id, signal);
      },
      async killAllProcesses() {
        return client.killAllProcesses();
      },
      async cleanupCompletedProcesses() {
        return client.cleanupCompletedProcesses();
      },
      async getProcessLogs(id: string) {
        return client.getProcessLogs(id);
      },
      async streamProcessLogs(
        processId: string,
        options?: { signal?: AbortSignal }
      ) {
        return client.streamProcessLogs(processId, options);
      },
      async writeFile(
        path: string,
        content: string,
        options?: { encoding?: string }
      ) {
        return client.writeFile(path, content, options);
      },
      async readFile(path: string, options?: { encoding?: string }) {
        return client.readFile(path, options);
      },
      async readFileStream(path: string) {
        return client.readFileStream(path);
      },
      async mkdir(path: string, options?: { recursive?: boolean }) {
        return client.mkdir(path, options);
      },
      async deleteFile(path: string) {
        return client.deleteFile(path);
      },
      async renameFile(oldPath: string, newPath: string) {
        return client.renameFile(oldPath, newPath);
      },
      async moveFile(sourcePath: string, destinationPath: string) {
        return client.moveFile(sourcePath, destinationPath);
      },
      async listFiles(path: string, options?: ListFilesOptions) {
        return client.listFiles(path, options);
      },
      async exists(path: string) {
        return client.exists(path, sessionId);
      },
      async gitCheckout(
        repoUrl: string,
        options?: { branch?: string; targetDir?: string }
      ) {
        return client.gitCheckout(repoUrl, options);
      },
      async setEnvVars(envVars: Record<string, string>) {
        return client.setEnvVars(envVars);
      },
      async createCodeContext(options?: CreateContextOptions) {
        return client.createCodeContext(options);
      },
      async runCode(code: string, options?: RunCodeOptions) {
        return client.runCode(code, options);
      },
      async runCodeStream(code: string, options?: RunCodeOptions) {
        return client.runCodeStream(code, options);
      },
      async listCodeContexts() {
        return client.listCodeContexts();
      },
      async deleteCodeContext(contextId: string) {
        return client.deleteCodeContext(contextId);
      },
      async mountBucket(
        bucket: string,
        mountPath: string,
        options: MountBucketOptions
      ) {
        return client.mountBucket(bucket, mountPath, options);
      },
      async unmountBucket(mountPath: string) {
        return client.unmountBucket(mountPath);
      }
    };
  }
}
