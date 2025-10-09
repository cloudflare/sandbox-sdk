import type { ExecuteRequest } from "../container_src/types";
import type { Sandbox } from "./index";
import type {
  BaseExecOptions,
  DeleteFileResponse,
  ExecuteResponse,
  GetProcessLogsResponse,
  GetProcessResponse,
  GitCheckoutResponse,
  ListFilesResponse,
  ListProcessesResponse,
  MkdirResponse,
  MoveFileResponse,
  ReadFileResponse,
  RenameFileResponse,
  StartProcessRequest,
  StartProcessResponse,
  WriteFileResponse,
} from "./types";


interface CommandsResponse {
  availableCommands: string[];
  timestamp: string;
}

interface GitCheckoutRequest {
  repoUrl: string;
  branch?: string;
  targetDir?: string;
  sessionId: string;
}


interface MkdirRequest {
  path: string;
  recursive?: boolean;
  sessionId: string;
}


interface WriteFileRequest {
  path: string;
  content: string;
  encoding?: string;
  sessionId: string;
}


interface ReadFileRequest {
  path: string;
  encoding?: string;
  sessionId: string;
}


interface DeleteFileRequest {
  path: string;
  sessionId: string;
}


interface RenameFileRequest {
  oldPath: string;
  newPath: string;
  sessionId: string;
}


interface MoveFileRequest {
  sourcePath: string;
  destinationPath: string;
  sessionId: string;
}


interface ListFilesRequest {
  path: string;
  options?: {
    recursive?: boolean;
    includeHidden?: boolean;
  };
  sessionId: string;
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

  async createSession(options: {
    id: string;
    env?: Record<string, string>;
    cwd?: string;
    isolation?: boolean;
  }): Promise<{ success: boolean; id: string; message: string }> {
    try {
      const response = await this.doFetch(`/api/session/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(options),
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `Failed to create session: ${response.status}`
        );
      }

      const data = await response.json() as { success: boolean; id: string; message: string };
      console.log(`[HTTP Client] Session created: ${options.id}`);
      return data;
    } catch (error) {
      console.error("[HTTP Client] Error creating session:", error);
      throw error;
    }
  }

  async exec(
    sessionId: string,
    command: string,
    options?: Pick<BaseExecOptions, "cwd" | "env">
  ): Promise<ExecuteResponse> {
    try {
      // Always use session-specific endpoint
      const response = await this.doFetch(`/api/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: sessionId, command }),
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `Failed to execute in session: ${response.status}`
        );
      }

      const data = await response.json() as { stdout: string; stderr: string; exitCode: number; success: boolean };
      console.log(
        `[HTTP Client] Command executed in session ${sessionId}: ${command}`
      );
      
      // Convert to ExecuteResponse format for consistency
      const executeResponse: ExecuteResponse = {
        ...data,
        command,
        timestamp: new Date().toISOString()
      };

      // Call the callback if provided
      this.options.onCommandComplete?.(
        executeResponse.success,
        executeResponse.exitCode,
        executeResponse.stdout,
        executeResponse.stderr,
        executeResponse.command
      );

      return executeResponse;
    } catch (error) {
      console.error("[HTTP Client] Error executing in session:", error);
      this.options.onError?.(
        error instanceof Error ? error.message : "Unknown error",
        command
      );
      throw error;
    }
  }

  async execStream(
    sessionId: string,
    command: string
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      // Always use session-specific streaming endpoint
      const response = await this.doFetch(`/api/execute/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ 
          id: sessionId,
          command
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errorData.error || `Failed to stream execute in session: ${response.status}`
        );
      }

      if (!response.body) {
        throw new Error("No response body for streaming execution");
      }

      console.log(
        `[HTTP Client] Started streaming command in session ${sessionId}: ${command}`
      );
      return response.body;
    } catch (error) {
      console.error("[HTTP Client] Error streaming execute in session:", error);
      throw error;
    }
  }

  async gitCheckout(
    repoUrl: string,
    sessionId: string,
    branch: string = "main",
    targetDir?: string
  ): Promise<GitCheckoutResponse> {
    try {
      const response = await this.doFetch(`/api/git/checkout`, {
        body: JSON.stringify({
          branch,
          repoUrl,
          targetDir,
          sessionId,
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
    sessionId: string
  ): Promise<MkdirResponse> {
    try {
      const response = await this.doFetch(`/api/mkdir`, {
        body: JSON.stringify({
          path,
          recursive,
          sessionId,
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
        `[HTTP Client] Directory created: ${path}, Success: ${data.success}, Recursive: ${data.recursive}${sessionId ? ` in session: ${sessionId}` : ''}`
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
    sessionId: string
  ): Promise<WriteFileResponse> {
    try {
      const response = await this.doFetch(`/api/write`, {
        body: JSON.stringify({
          content,
          encoding,
          path,
          sessionId,
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
        `[HTTP Client] File written: ${path}, Success: ${data.success}${sessionId ? ` in session: ${sessionId}` : ''}`
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
    sessionId: string
  ): Promise<ReadFileResponse> {
    try {
      const response = await this.doFetch(`/api/read`, {
        body: JSON.stringify({
          encoding,
          path,
          sessionId,
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
        `[HTTP Client] File read: ${path}, Success: ${data.success}, Content length: ${data.content.length}${sessionId ? ` in session: ${sessionId}` : ''}`
      );

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error reading file:", error);
      throw error;
    }
  }

  async readFileStream(
    path: string,
    sessionId: string
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      const response = await this.doFetch(`/api/read/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path,
          sessionId,
        } as ReadFileRequest),
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
        throw new Error("No response body for file streaming");
      }

      console.log(
        `[HTTP Client] Started streaming file: ${path}${sessionId ? ` in session: ${sessionId}` : ''}`
      );
      return response.body;
    } catch (error) {
      console.error("[HTTP Client] Error streaming file:", error);
      throw error;
    }
  }

  async deleteFile(
    path: string,
    sessionId: string
  ): Promise<DeleteFileResponse> {
    try {
      const response = await this.doFetch(`/api/delete`, {
        body: JSON.stringify({
          path,
          sessionId,
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
        `[HTTP Client] File deleted: ${path}, Success: ${data.success}${sessionId ? ` in session: ${sessionId}` : ''}`
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
    sessionId: string
  ): Promise<RenameFileResponse> {
    try {
      const response = await this.doFetch(`/api/rename`, {
        body: JSON.stringify({
          newPath,
          oldPath,
          sessionId,
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
        `[HTTP Client] File renamed: ${oldPath} -> ${newPath}, Success: ${data.success}${sessionId ? ` in session: ${sessionId}` : ''}`
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
    sessionId: string
  ): Promise<MoveFileResponse> {
    try {
      const response = await this.doFetch(`/api/move`, {
        body: JSON.stringify({
          destinationPath,
          sourcePath,
          sessionId,
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
        `[HTTP Client] File moved: ${sourcePath} -> ${destinationPath}, Success: ${data.success}${sessionId ? ` in session: ${sessionId}` : ''}`
      );

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error moving file:", error);
      throw error;
    }
  }

  async listFiles(
    path: string,
    sessionId: string,
    options?: {
      recursive?: boolean;
      includeHidden?: boolean;
    }
  ): Promise<ListFilesResponse> {
    try {
      const response = await this.doFetch(`/api/list-files`, {
        body: JSON.stringify({
          path,
          options,
          sessionId,
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
        `[HTTP Client] Listed ${data.files.length} files in: ${path}, Success: ${data.success}${sessionId ? ` in session: ${sessionId}` : ''}`
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


  // Process management methods
  async startProcess(
    command: string,
    sessionId: string,
    options?: {
      processId?: string;
      timeout?: number;
      env?: Record<string, string>;
      cwd?: string;
      encoding?: string;
      autoCleanup?: boolean;
    }
  ): Promise<StartProcessResponse> {
    try {
      const response = await this.doFetch("/api/process/start", {
        body: JSON.stringify({
          command,
          sessionId,
          options,
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

  async listProcesses(sessionId?: string): Promise<ListProcessesResponse> {
    try {
      const url = sessionId 
        ? `/api/process/list?session=${encodeURIComponent(sessionId)}`
        : "/api/process/list";
      const response = await this.doFetch(url, {
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

  async killAllProcesses(sessionId?: string): Promise<{
    success: boolean;
    killedCount: number;
    message: string;
  }> {
    try {
      const url = sessionId 
        ? `/api/process/kill-all?session=${encodeURIComponent(sessionId)}`
        : "/api/process/kill-all";
      const response = await this.doFetch(url, {
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
    processId: string,
    options?: { signal?: AbortSignal }
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      const response = await this.doFetch(`/api/process/${processId}/stream`, {
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
        },
        method: "GET",
        signal: options?.signal,
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
