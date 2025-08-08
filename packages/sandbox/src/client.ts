import type { ExecuteRequest } from "../container_src/types";
import type { Sandbox } from "./index";
import type {
  BaseExecOptions,
  GetProcessLogsResponse,
  GetProcessResponse,
  ListProcessesResponse,
  StartProcessRequest,
  StartProcessResponse,
} from "./types";

export interface ExecuteResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
  timestamp: string;
}

interface CommandsResponse {
  availableCommands: string[];
  timestamp: string;
}

interface GitCheckoutRequest {
  repoUrl: string;
  branch?: string;
  targetDir?: string;
  sessionId?: string;
}

export interface GitCheckoutResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  repoUrl: string;
  branch: string;
  targetDir: string;
  timestamp: string;
}

interface MkdirRequest {
  path: string;
  recursive?: boolean;
  sessionId?: string;
}

export interface MkdirResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  path: string;
  recursive: boolean;
  timestamp: string;
}

interface WriteFileRequest {
  path: string;
  content: string;
  encoding?: string;
  sessionId?: string;
}

export interface WriteFileResponse {
  success: boolean;
  exitCode: number;
  path: string;
  timestamp: string;
}

interface ReadFileRequest {
  path: string;
  encoding?: string;
  sessionId?: string;
}

export interface ReadFileResponse {
  success: boolean;
  exitCode: number;
  path: string;
  content: string;
  timestamp: string;
}

interface DeleteFileRequest {
  path: string;
  sessionId?: string;
}

export interface DeleteFileResponse {
  success: boolean;
  exitCode: number;
  path: string;
  timestamp: string;
}

interface RenameFileRequest {
  oldPath: string;
  newPath: string;
  sessionId?: string;
}

export interface RenameFileResponse {
  success: boolean;
  exitCode: number;
  oldPath: string;
  newPath: string;
  timestamp: string;
}

interface MoveFileRequest {
  sourcePath: string;
  destinationPath: string;
  sessionId?: string;
}

export interface MoveFileResponse {
  success: boolean;
  exitCode: number;
  sourcePath: string;
  destinationPath: string;
  timestamp: string;
}

interface ListFilesRequest {
  path: string;
  options?: {
    recursive?: boolean;
    includeHidden?: boolean;
  };
  sessionId?: string;
}

export interface ListFilesResponse {
  success: boolean;
  exitCode: number;
  path: string;
  files: Array<{
    name: string;
    path: string;
    type: 'file' | 'directory' | 'symlink' | 'other';
    size: number;
    modifiedAt: string;
    mode: string;
    permissions: {
      readable: boolean;
      writable: boolean;
      executable: boolean;
    };
  }>;
  timestamp: string;
}

interface PreviewInfo {
  url: string;
  port: number;
  name?: string;
}

interface ExposedPort extends PreviewInfo {
  exposedAt: string;
  timestamp: string;
}

interface ExposePortResponse {
  success: boolean;
  port: number;
  name?: string;
  exposedAt: string;
  timestamp: string;
}

interface UnexposePortResponse {
  success: boolean;
  port: number;
  timestamp: string;
}

interface GetExposedPortsResponse {
  ports: ExposedPort[];
  count: number;
  timestamp: string;
}

interface PingResponse {
  message: string;
  timestamp: string;
}

interface HttpClientOptions {
  stub?: Sandbox;
  baseUrl?: string;
  port?: number;
  onCommandStart?: (command: string) => void;
  onOutput?: (
    stream: "stdout" | "stderr",
    data: string,
    command: string
  ) => void;
  onCommandComplete?: (
    success: boolean,
    exitCode: number,
    stdout: string,
    stderr: string,
    command: string
  ) => void;
  onError?: (error: string, command?: string) => void;
}

export class HttpClient {
  private baseUrl: string;
  private options: HttpClientOptions;
  private sessionId: string | null = null;

  constructor(options: HttpClientOptions = {}) {
    this.options = {
      ...options,
    };
    this.baseUrl = this.options.baseUrl!;
  }

  protected async doFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    const url = this.options.stub
      ? `http://localhost:${this.options.port}${path}`
      : `${this.baseUrl}${path}`;
    const method = options?.method || "GET";

    console.log(`[HTTP Client] Making ${method} request to ${url}`);

    try {
      let response: Response;

      if (this.options.stub) {
        response = await this.options.stub.containerFetch(
          url,
          options,
          this.options.port
        );
      } else {
        response = await fetch(url, options);
      }

      console.log(
        `[HTTP Client] Response: ${response.status} ${response.statusText}`
      );

      if (!response.ok) {
        console.error(
          `[HTTP Client] Request failed: ${method} ${url} - ${response.status} ${response.statusText}`
        );
      }

      return response;
    } catch (error) {
      console.error(`[HTTP Client] Request error: ${method} ${url}`, error);
      throw error;
    }
  }

  async execute(
    command: string,
    options: Pick<BaseExecOptions, "sessionId" | "cwd" | "env">
  ): Promise<ExecuteResponse> {
    try {
      const targetSessionId = options.sessionId || this.sessionId;
      const executeRequest = {
        command,
        sessionId: targetSessionId,
        cwd: options.cwd,
        env: options.env,
      } satisfies ExecuteRequest;

      const response = await this.doFetch(`/api/execute`, {
        body: JSON.stringify(executeRequest),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data: ExecuteResponse = await response.json();
      console.log(
        `[HTTP Client] Command executed: ${command}, Success: ${data.success}`
      );

      // Call the callback if provided
      this.options.onCommandComplete?.(
        data.success,
        data.exitCode,
        data.stdout,
        data.stderr,
        data.command
      );

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error executing command:", error);
      this.options.onError?.(
        error instanceof Error ? error.message : "Unknown error",
        command
      );
      throw error;
    }
  }

  async executeCommandStream(
    command: string,
    sessionId?: string
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/execute/stream`, {
        body: JSON.stringify({
          command,
          sessionId: targetSessionId,
        }),
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        method: "POST",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      if (!response.body) {
        throw new Error("No response body for streaming request");
      }

      console.log(`[HTTP Client] Started command stream: ${command}`);

      return response.body;
    } catch (error) {
      console.error("[HTTP Client] Error in command stream:", error);
      throw error;
    }
  }

  async gitCheckout(
    repoUrl: string,
    branch: string = "main",
    targetDir?: string,
    sessionId?: string
  ): Promise<GitCheckoutResponse> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/git/checkout`, {
        body: JSON.stringify({
          branch,
          repoUrl,
          sessionId: targetSessionId,
          targetDir,
        } as GitCheckoutRequest),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data: GitCheckoutResponse = await response.json();
      console.log(
        `[HTTP Client] Git checkout completed: ${repoUrl}, Success: ${data.success}, Target: ${data.targetDir}`
      );

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error in git checkout:", error);
      throw error;
    }
  }

  async mkdir(
    path: string,
    recursive: boolean = false,
    sessionId?: string
  ): Promise<MkdirResponse> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/mkdir`, {
        body: JSON.stringify({
          path,
          recursive,
          sessionId: targetSessionId,
        } as MkdirRequest),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data: MkdirResponse = await response.json();
      console.log(
        `[HTTP Client] Directory created: ${path}, Success: ${data.success}, Recursive: ${data.recursive}`
      );

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error creating directory:", error);
      throw error;
    }
  }

  async writeFile(
    path: string,
    content: string,
    encoding: string = "utf-8",
    sessionId?: string
  ): Promise<WriteFileResponse> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/write`, {
        body: JSON.stringify({
          content,
          encoding,
          path,
          sessionId: targetSessionId,
        } as WriteFileRequest),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data: WriteFileResponse = await response.json();
      console.log(
        `[HTTP Client] File written: ${path}, Success: ${data.success}`
      );

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error writing file:", error);
      throw error;
    }
  }

  async readFile(
    path: string,
    encoding: string = "utf-8",
    sessionId?: string
  ): Promise<ReadFileResponse> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/read`, {
        body: JSON.stringify({
          encoding,
          path,
          sessionId: targetSessionId,
        } as ReadFileRequest),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data: ReadFileResponse = await response.json();
      console.log(
        `[HTTP Client] File read: ${path}, Success: ${data.success}, Content length: ${data.content.length}`
      );

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error reading file:", error);
      throw error;
    }
  }

  async deleteFile(
    path: string,
    sessionId?: string
  ): Promise<DeleteFileResponse> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/delete`, {
        body: JSON.stringify({
          path,
          sessionId: targetSessionId,
        } as DeleteFileRequest),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data: DeleteFileResponse = await response.json();
      console.log(
        `[HTTP Client] File deleted: ${path}, Success: ${data.success}`
      );

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error deleting file:", error);
      throw error;
    }
  }

  async renameFile(
    oldPath: string,
    newPath: string,
    sessionId?: string
  ): Promise<RenameFileResponse> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/rename`, {
        body: JSON.stringify({
          newPath,
          oldPath,
          sessionId: targetSessionId,
        } as RenameFileRequest),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data: RenameFileResponse = await response.json();
      console.log(
        `[HTTP Client] File renamed: ${oldPath} -> ${newPath}, Success: ${data.success}`
      );

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error renaming file:", error);
      throw error;
    }
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string,
    sessionId?: string
  ): Promise<MoveFileResponse> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/move`, {
        body: JSON.stringify({
          destinationPath,
          sessionId: targetSessionId,
          sourcePath,
        } as MoveFileRequest),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data: MoveFileResponse = await response.json();
      console.log(
        `[HTTP Client] File moved: ${sourcePath} -> ${destinationPath}, Success: ${data.success}`
      );

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error moving file:", error);
      throw error;
    }
  }

  async listFiles(
    path: string,
    options?: {
      recursive?: boolean;
      includeHidden?: boolean;
    },
    sessionId?: string
  ): Promise<ListFilesResponse> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/list-files`, {
        body: JSON.stringify({
          path,
          options,
          sessionId: targetSessionId,
        } as ListFilesRequest),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data: ListFilesResponse = await response.json();
      console.log(
        `[HTTP Client] Listed ${data.files.length} files in: ${path}, Success: ${data.success}`
      );

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error listing files:", error);
      throw error;
    }
  }

  async exposePort(port: number, name?: string): Promise<ExposePortResponse> {
    try {
      const response = await this.doFetch(`/api/expose-port`, {
        body: JSON.stringify({
          port,
          name,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        console.log(errorData);
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data: ExposePortResponse = await response.json();
      console.log(
        `[HTTP Client] Port exposed: ${port}${
          name ? ` (${name})` : ""
        }, Success: ${data.success}`
      );

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error exposing port:", error);
      throw error;
    }
  }

  async unexposePort(port: number): Promise<UnexposePortResponse> {
    try {
      const response = await this.doFetch(`/api/unexpose-port`, {
        body: JSON.stringify({
          port,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "DELETE",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data: UnexposePortResponse = await response.json();
      console.log(
        `[HTTP Client] Port unexposed: ${port}, Success: ${data.success}`
      );

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error unexposing port:", error);
      throw error;
    }
  }

  async getExposedPorts(): Promise<GetExposedPortsResponse> {
    try {
      const response = await this.doFetch(`/api/exposed-ports`, {
        headers: {
          "Content-Type": "application/json",
        },
        method: "GET",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data: GetExposedPortsResponse = await response.json();
      console.log(`[HTTP Client] Got ${data.count} exposed ports`);

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error getting exposed ports:", error);
      throw error;
    }
  }

  async ping(): Promise<string> {
    try {
      const response = await this.doFetch(`/api/ping`, {
        headers: {
          "Content-Type": "application/json",
        },
        method: "GET",
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: PingResponse = await response.json();
      console.log(`[HTTP Client] Ping response: ${data.message}`);
      return data.timestamp;
    } catch (error) {
      console.error("[HTTP Client] Error pinging server:", error);
      throw error;
    }
  }

  async getCommands(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/commands`, {
        headers: {
          "Content-Type": "application/json",
        },
        method: "GET",
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: CommandsResponse = await response.json();
      console.log(
        `[HTTP Client] Available commands: ${data.availableCommands.length}`
      );
      return data.availableCommands;
    } catch (error) {
      console.error("[HTTP Client] Error getting commands:", error);
      throw error;
    }
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  clearSession(): void {
    this.sessionId = null;
  }

  // Process management methods
  async startProcess(
    command: string,
    options?: {
      processId?: string;
      sessionId?: string;
      timeout?: number;
      env?: Record<string, string>;
      cwd?: string;
      encoding?: string;
      autoCleanup?: boolean;
    }
  ): Promise<StartProcessResponse> {
    try {
      const targetSessionId = options?.sessionId || this.sessionId;

      const response = await this.doFetch("/api/process/start", {
        body: JSON.stringify({
          command,
          options: {
            ...options,
            sessionId: targetSessionId,
          },
        } as StartProcessRequest),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data: StartProcessResponse = await response.json();
      console.log(
        `[HTTP Client] Process started: ${command}, ID: ${data.process.id}`
      );

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error starting process:", error);
      throw error;
    }
  }

  async listProcesses(): Promise<ListProcessesResponse> {
    try {
      const response = await this.doFetch("/api/process/list", {
        headers: {
          "Content-Type": "application/json",
        },
        method: "GET",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data: ListProcessesResponse = await response.json();
      console.log(`[HTTP Client] Listed ${data.processes.length} processes`);

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error listing processes:", error);
      throw error;
    }
  }

  async getProcess(processId: string): Promise<GetProcessResponse> {
    try {
      const response = await this.doFetch(`/api/process/${processId}`, {
        headers: {
          "Content-Type": "application/json",
        },
        method: "GET",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data: GetProcessResponse = await response.json();
      console.log(
        `[HTTP Client] Got process ${processId}: ${
          data.process?.status || "not found"
        }`
      );

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error getting process:", error);
      throw error;
    }
  }

  async killProcess(
    processId: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      const response = await this.doFetch(`/api/process/${processId}`, {
        headers: {
          "Content-Type": "application/json",
        },
        method: "DELETE",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data = (await response.json()) as {
        success: boolean;
        message: string;
      };
      console.log(`[HTTP Client] Killed process ${processId}`);

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error killing process:", error);
      throw error;
    }
  }

  async killAllProcesses(): Promise<{
    success: boolean;
    killedCount: number;
    message: string;
  }> {
    try {
      const response = await this.doFetch("/api/process/kill-all", {
        headers: {
          "Content-Type": "application/json",
        },
        method: "DELETE",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data = (await response.json()) as {
        success: boolean;
        killedCount: number;
        message: string;
      };
      console.log(`[HTTP Client] Killed ${data.killedCount} processes`);

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error killing all processes:", error);
      throw error;
    }
  }

  async getProcessLogs(processId: string): Promise<GetProcessLogsResponse> {
    try {
      const response = await this.doFetch(`/api/process/${processId}/logs`, {
        headers: {
          "Content-Type": "application/json",
        },
        method: "GET",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data: GetProcessLogsResponse = await response.json();
      console.log(`[HTTP Client] Got logs for process ${processId}`);

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error getting process logs:", error);
      throw error;
    }
  }

  async streamProcessLogs(
    processId: string
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      const response = await this.doFetch(`/api/process/${processId}/stream`, {
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
        },
        method: "GET",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      if (!response.body) {
        throw new Error("No response body for streaming request");
      }

      console.log(
        `[HTTP Client] Started streaming logs for process ${processId}`
      );

      return response.body;
    } catch (error) {
      console.error("[HTTP Client] Error streaming process logs:", error);
      throw error;
    }
  }
}
