import type { Sandbox } from "./index";

interface ExecuteRequest {
  command: string;
  args?: string[];
  sessionId?: string;
}

export interface ExecuteResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
  args: string[];
  timestamp: string;
}

interface SessionResponse {
  sessionId: string;
  message: string;
  timestamp: string;
}

interface SessionListResponse {
  sessions: Array<{
    sessionId: string;
    hasActiveProcess: boolean;
    createdAt: string;
  }>;
  count: number;
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

interface StreamEvent {
  type: "command_start" | "output" | "command_complete" | "error";
  command?: string;
  args?: string[];
  stream?: "stdout" | "stderr";
  data?: string;
  message?: string;
  path?: string;
  oldPath?: string;
  newPath?: string;
  sourcePath?: string;
  destinationPath?: string;
  content?: string;
  success?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  timestamp?: string;
}

interface HttpClientOptions {
  stub?: Sandbox;
  baseUrl?: string;
  port?: number;
  onCommandStart?: (command: string, args: string[]) => void;
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
    command: string,
    args: string[]
  ) => void;
  onError?: (error: string, command?: string, args?: string[]) => void;
  onStreamEvent?: (event: StreamEvent) => void;
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

  private async doFetch(
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
  // Public methods to set event handlers
  setOnOutput(
    handler: (
      stream: "stdout" | "stderr",
      data: string,
      command: string
    ) => void
  ): void {
    this.options.onOutput = handler;
  }

  setOnCommandComplete(
    handler: (
      success: boolean,
      exitCode: number,
      stdout: string,
      stderr: string,
      command: string,
      args: string[]
    ) => void
  ): void {
    this.options.onCommandComplete = handler;
  }

  setOnStreamEvent(handler: (event: StreamEvent) => void): void {
    this.options.onStreamEvent = handler;
  }

  // Public getter methods
  getOnOutput():
    | ((stream: "stdout" | "stderr", data: string, command: string) => void)
    | undefined {
    return this.options.onOutput;
  }

  getOnCommandComplete():
    | ((
      success: boolean,
      exitCode: number,
      stdout: string,
      stderr: string,
      command: string,
      args: string[]
    ) => void)
    | undefined {
    return this.options.onCommandComplete;
  }

  getOnStreamEvent(): ((event: StreamEvent) => void) | undefined {
    return this.options.onStreamEvent;
  }

  async createSession(): Promise<string> {
    try {
      const response = await this.doFetch(`/api/session/create`, {
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: SessionResponse = await response.json();
      this.sessionId = data.sessionId;
      console.log(`[HTTP Client] Created session: ${this.sessionId}`);
      return this.sessionId;
    } catch (error) {
      console.error("[HTTP Client] Error creating session:", error);
      throw error;
    }
  }

  async listSessions(): Promise<SessionListResponse> {
    try {
      const response = await this.doFetch(`/api/session/list`, {
        headers: {
          "Content-Type": "application/json",
        },
        method: "GET",
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: SessionListResponse = await response.json();
      console.log(`[HTTP Client] Listed ${data.count} sessions`);
      return data;
    } catch (error) {
      console.error("[HTTP Client] Error listing sessions:", error);
      throw error;
    }
  }

  async execute(
    command: string,
    args: string[] = [],
    sessionId?: string
  ): Promise<ExecuteResponse> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/execute`, {
        body: JSON.stringify({
          args,
          command,
          sessionId: targetSessionId,
        } as ExecuteRequest),
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
        data.command,
        data.args
      );

      return data;
    } catch (error) {
      console.error("[HTTP Client] Error executing command:", error);
      this.options.onError?.(
        error instanceof Error ? error.message : "Unknown error",
        command,
        args
      );
      throw error;
    }
  }

  async executeStream(
    command: string,
    args: string[] = [],
    sessionId?: string
  ): Promise<void> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/execute/stream`, {
        body: JSON.stringify({
          args,
          command,
          sessionId: targetSessionId,
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
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      if (!response.body) {
        throw new Error("No response body for streaming request");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const eventData = line.slice(6); // Remove 'data: ' prefix
                const event: StreamEvent = JSON.parse(eventData);

                console.log(`[HTTP Client] Stream event: ${event.type}`);
                this.options.onStreamEvent?.(event);

                switch (event.type) {
                  case "command_start":
                    console.log(
                      `[HTTP Client] Command started: ${event.command
                      } ${event.args?.join(" ")}`
                    );
                    this.options.onCommandStart?.(
                      event.command!,
                      event.args || []
                    );
                    break;

                  case "output":
                    console.log(`[${event.stream}] ${event.data}`);
                    this.options.onOutput?.(
                      event.stream!,
                      event.data!,
                      event.command!
                    );
                    break;

                  case "command_complete":
                    console.log(
                      `[HTTP Client] Command completed: ${event.command}, Success: ${event.success}, Exit code: ${event.exitCode}`
                    );
                    this.options.onCommandComplete?.(
                      event.success!,
                      event.exitCode!,
                      event.stdout!,
                      event.stderr!,
                      event.command!,
                      event.args || []
                    );
                    break;

                  case "error":
                    console.error(
                      `[HTTP Client] Command error: ${event.error}`
                    );
                    this.options.onError?.(
                      event.error!,
                      event.command,
                      event.args
                    );
                    break;
                }
              } catch (parseError) {
                console.warn(
                  "[HTTP Client] Failed to parse stream event:",
                  parseError
                );
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      console.error("[HTTP Client] Error in streaming execution:", error);
      this.options.onError?.(
        error instanceof Error ? error.message : "Unknown error",
        command,
        args
      );
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

  async gitCheckoutStream(
    repoUrl: string,
    branch: string = "main",
    targetDir?: string,
    sessionId?: string
  ): Promise<void> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/git/checkout/stream`, {
        body: JSON.stringify({
          branch,
          repoUrl,
          sessionId: targetSessionId,
          targetDir,
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
        throw new Error(
          errorData.error || `HTTP error! status: ${response.status}`
        );
      }

      if (!response.body) {
        throw new Error("No response body for streaming request");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const eventData = line.slice(6); // Remove 'data: ' prefix
                const event: StreamEvent = JSON.parse(eventData);

                console.log(
                  `[HTTP Client] Git checkout stream event: ${event.type}`
                );
                this.options.onStreamEvent?.(event);

                switch (event.type) {
                  case "command_start":
                    console.log(
                      `[HTTP Client] Git checkout started: ${event.command
                      } ${event.args?.join(" ")}`
                    );
                    this.options.onCommandStart?.(
                      event.command!,
                      event.args || []
                    );
                    break;

                  case "output":
                    console.log(`[${event.stream}] ${event.data}`);
                    this.options.onOutput?.(
                      event.stream!,
                      event.data!,
                      event.command!
                    );
                    break;

                  case "command_complete":
                    console.log(
                      `[HTTP Client] Git checkout completed: ${event.command}, Success: ${event.success}, Exit code: ${event.exitCode}`
                    );
                    this.options.onCommandComplete?.(
                      event.success!,
                      event.exitCode!,
                      event.stdout!,
                      event.stderr!,
                      event.command!,
                      event.args || []
                    );
                    break;

                  case "error":
                    console.error(
                      `[HTTP Client] Git checkout error: ${event.error}`
                    );
                    this.options.onError?.(
                      event.error!,
                      event.command,
                      event.args
                    );
                    break;
                }
              } catch (parseError) {
                console.warn(
                  "[HTTP Client] Failed to parse git checkout stream event:",
                  parseError
                );
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      console.error("[HTTP Client] Error in streaming git checkout:", error);
      this.options.onError?.(
        error instanceof Error ? error.message : "Unknown error",
        "git clone",
        [branch, repoUrl, targetDir || ""]
      );
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

  async mkdirStream(
    path: string,
    recursive: boolean = false,
    sessionId?: string
  ): Promise<void> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/mkdir/stream`, {
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

      if (!response.body) {
        throw new Error("No response body for streaming request");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const eventData = line.slice(6); // Remove 'data: ' prefix
                const event: StreamEvent = JSON.parse(eventData);

                console.log(`[HTTP Client] Mkdir stream event: ${event.type}`);
                this.options.onStreamEvent?.(event);

                switch (event.type) {
                  case "command_start":
                    console.log(
                      `[HTTP Client] Mkdir started: ${event.command
                      } ${event.args?.join(" ")}`
                    );
                    this.options.onCommandStart?.(
                      event.command!,
                      event.args || []
                    );
                    break;

                  case "output":
                    console.log(`[${event.stream}] ${event.data}`);
                    this.options.onOutput?.(
                      event.stream!,
                      event.data!,
                      event.command!
                    );
                    break;

                  case "command_complete":
                    console.log(
                      `[HTTP Client] Mkdir completed: ${event.command}, Success: ${event.success}, Exit code: ${event.exitCode}`
                    );
                    this.options.onCommandComplete?.(
                      event.success!,
                      event.exitCode!,
                      event.stdout!,
                      event.stderr!,
                      event.command!,
                      event.args || []
                    );
                    break;

                  case "error":
                    console.error(`[HTTP Client] Mkdir error: ${event.error}`);
                    this.options.onError?.(
                      event.error!,
                      event.command,
                      event.args
                    );
                    break;
                }
              } catch (parseError) {
                console.warn(
                  "[HTTP Client] Failed to parse mkdir stream event:",
                  parseError
                );
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      console.error("[HTTP Client] Error in streaming mkdir:", error);
      this.options.onError?.(
        error instanceof Error ? error.message : "Unknown error",
        "mkdir",
        recursive ? ["-p", path] : [path]
      );
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

  async writeFileStream(
    path: string,
    content: string,
    encoding: string = "utf-8",
    sessionId?: string
  ): Promise<void> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/write/stream`, {
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

      if (!response.body) {
        throw new Error("No response body for streaming request");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const eventData = line.slice(6); // Remove 'data: ' prefix
                const event: StreamEvent = JSON.parse(eventData);

                console.log(
                  `[HTTP Client] Write file stream event: ${event.type}`
                );
                this.options.onStreamEvent?.(event);

                switch (event.type) {
                  case "command_start":
                    console.log(
                      `[HTTP Client] Write file started: ${event.path}`
                    );
                    this.options.onCommandStart?.("write", [
                      path,
                      content,
                      encoding,
                    ]);
                    break;

                  case "output":
                    console.log(`[output] ${event.message}`);
                    this.options.onOutput?.("stdout", event.message!, "write");
                    break;

                  case "command_complete":
                    console.log(
                      `[HTTP Client] Write file completed: ${event.path}, Success: ${event.success}`
                    );
                    this.options.onCommandComplete?.(
                      event.success!,
                      0,
                      "",
                      "",
                      "write",
                      [path, content, encoding]
                    );
                    break;

                  case "error":
                    console.error(
                      `[HTTP Client] Write file error: ${event.error}`
                    );
                    this.options.onError?.(event.error!, "write", [
                      path,
                      content,
                      encoding,
                    ]);
                    break;
                }
              } catch (parseError) {
                console.warn(
                  "[HTTP Client] Failed to parse write file stream event:",
                  parseError
                );
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      console.error("[HTTP Client] Error in streaming write file:", error);
      this.options.onError?.(
        error instanceof Error ? error.message : "Unknown error",
        "write",
        [path, content, encoding]
      );
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

  async readFileStream(
    path: string,
    encoding: string = "utf-8",
    sessionId?: string
  ): Promise<void> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/read/stream`, {
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

      if (!response.body) {
        throw new Error("No response body for streaming request");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const eventData = line.slice(6); // Remove 'data: ' prefix
                const event: StreamEvent = JSON.parse(eventData);

                console.log(
                  `[HTTP Client] Read file stream event: ${event.type}`
                );
                this.options.onStreamEvent?.(event);

                switch (event.type) {
                  case "command_start":
                    console.log(
                      `[HTTP Client] Read file started: ${event.path}`
                    );
                    this.options.onCommandStart?.("read", [path, encoding]);
                    break;

                  case "command_complete":
                    console.log(
                      `[HTTP Client] Read file completed: ${event.path
                      }, Success: ${event.success}, Content length: ${event.content?.length || 0
                      }`
                    );
                    this.options.onCommandComplete?.(
                      event.success!,
                      0,
                      event.content || "",
                      "",
                      "read",
                      [path, encoding]
                    );
                    break;

                  case "error":
                    console.error(
                      `[HTTP Client] Read file error: ${event.error}`
                    );
                    this.options.onError?.(event.error!, "read", [
                      path,
                      encoding,
                    ]);
                    break;
                }
              } catch (parseError) {
                console.warn(
                  "[HTTP Client] Failed to parse read file stream event:",
                  parseError
                );
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      console.error("[HTTP Client] Error in streaming read file:", error);
      this.options.onError?.(
        error instanceof Error ? error.message : "Unknown error",
        "read",
        [path, encoding]
      );
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

  async deleteFileStream(path: string, sessionId?: string): Promise<void> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/delete/stream`, {
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

      if (!response.body) {
        throw new Error("No response body for streaming request");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const eventData = line.slice(6); // Remove 'data: ' prefix
                const event: StreamEvent = JSON.parse(eventData);

                console.log(
                  `[HTTP Client] Delete file stream event: ${event.type}`
                );
                this.options.onStreamEvent?.(event);

                switch (event.type) {
                  case "command_start":
                    console.log(
                      `[HTTP Client] Delete file started: ${event.path}`
                    );
                    this.options.onCommandStart?.("delete", [path]);
                    break;

                  case "command_complete":
                    console.log(
                      `[HTTP Client] Delete file completed: ${event.path}, Success: ${event.success}`
                    );
                    this.options.onCommandComplete?.(
                      event.success!,
                      0,
                      "",
                      "",
                      "delete",
                      [path]
                    );
                    break;

                  case "error":
                    console.error(
                      `[HTTP Client] Delete file error: ${event.error}`
                    );
                    this.options.onError?.(event.error!, "delete", [path]);
                    break;
                }
              } catch (parseError) {
                console.warn(
                  "[HTTP Client] Failed to parse delete file stream event:",
                  parseError
                );
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      console.error("[HTTP Client] Error in streaming delete file:", error);
      this.options.onError?.(
        error instanceof Error ? error.message : "Unknown error",
        "delete",
        [path]
      );
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

  async renameFileStream(
    oldPath: string,
    newPath: string,
    sessionId?: string
  ): Promise<void> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/rename/stream`, {
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

      if (!response.body) {
        throw new Error("No response body for streaming request");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const eventData = line.slice(6); // Remove 'data: ' prefix
                const event: StreamEvent = JSON.parse(eventData);

                console.log(
                  `[HTTP Client] Rename file stream event: ${event.type}`
                );
                this.options.onStreamEvent?.(event);

                switch (event.type) {
                  case "command_start":
                    console.log(
                      `[HTTP Client] Rename file started: ${event.oldPath} -> ${event.newPath}`
                    );
                    this.options.onCommandStart?.("rename", [oldPath, newPath]);
                    break;

                  case "command_complete":
                    console.log(
                      `[HTTP Client] Rename file completed: ${event.oldPath} -> ${event.newPath}, Success: ${event.success}`
                    );
                    this.options.onCommandComplete?.(
                      event.success!,
                      0,
                      "",
                      "",
                      "rename",
                      [oldPath, newPath]
                    );
                    break;

                  case "error":
                    console.error(
                      `[HTTP Client] Rename file error: ${event.error}`
                    );
                    this.options.onError?.(event.error!, "rename", [
                      oldPath,
                      newPath,
                    ]);
                    break;
                }
              } catch (parseError) {
                console.warn(
                  "[HTTP Client] Failed to parse rename file stream event:",
                  parseError
                );
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      console.error("[HTTP Client] Error in streaming rename file:", error);
      this.options.onError?.(
        error instanceof Error ? error.message : "Unknown error",
        "rename",
        [oldPath, newPath]
      );
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

  async moveFileStream(
    sourcePath: string,
    destinationPath: string,
    sessionId?: string
  ): Promise<void> {
    try {
      const targetSessionId = sessionId || this.sessionId;

      const response = await this.doFetch(`/api/move/stream`, {
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

      if (!response.body) {
        throw new Error("No response body for streaming request");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const eventData = line.slice(6); // Remove 'data: ' prefix
                const event: StreamEvent = JSON.parse(eventData);

                console.log(
                  `[HTTP Client] Move file stream event: ${event.type}`
                );
                this.options.onStreamEvent?.(event);

                switch (event.type) {
                  case "command_start":
                    console.log(
                      `[HTTP Client] Move file started: ${event.sourcePath} -> ${event.destinationPath}`
                    );
                    this.options.onCommandStart?.("move", [
                      sourcePath,
                      destinationPath,
                    ]);
                    break;

                  case "command_complete":
                    console.log(
                      `[HTTP Client] Move file completed: ${event.sourcePath} -> ${event.destinationPath}, Success: ${event.success}`
                    );
                    this.options.onCommandComplete?.(
                      event.success!,
                      0,
                      "",
                      "",
                      "move",
                      [sourcePath, destinationPath]
                    );
                    break;

                  case "error":
                    console.error(
                      `[HTTP Client] Move file error: ${event.error}`
                    );
                    this.options.onError?.(event.error!, "move", [
                      sourcePath,
                      destinationPath,
                    ]);
                    break;
                }
              } catch (parseError) {
                console.warn(
                  "[HTTP Client] Failed to parse move file stream event:",
                  parseError
                );
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      console.error("[HTTP Client] Error in streaming move file:", error);
      this.options.onError?.(
        error instanceof Error ? error.message : "Unknown error",
        "move",
        [sourcePath, destinationPath]
      );
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
        `[HTTP Client] Port exposed: ${port}${name ? ` (${name})` : ""}, Success: ${data.success}`
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
      console.log(
        `[HTTP Client] Got ${data.count} exposed ports`
      );

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
}

// Example usage and utility functions
export function createClient(options?: HttpClientOptions): HttpClient {
  return new HttpClient(options);
}

// Convenience function for quick command execution
export async function quickExecute(
  command: string,
  args: string[] = [],
  options?: HttpClientOptions
): Promise<ExecuteResponse> {
  const client = createClient(options);
  await client.createSession();

  try {
    return await client.execute(command, args);
  } finally {
    client.clearSession();
  }
}

// Convenience function for quick streaming command execution
export async function quickExecuteStream(
  command: string,
  args: string[] = [],
  options?: HttpClientOptions
): Promise<void> {
  const client = createClient(options);
  await client.createSession();

  try {
    await client.executeStream(command, args);
  } finally {
    client.clearSession();
  }
}

// Convenience function for quick git checkout
export async function quickGitCheckout(
  repoUrl: string,
  branch: string = "main",
  targetDir?: string,
  options?: HttpClientOptions
): Promise<GitCheckoutResponse> {
  const client = createClient(options);
  await client.createSession();

  try {
    return await client.gitCheckout(repoUrl, branch, targetDir);
  } finally {
    client.clearSession();
  }
}

// Convenience function for quick directory creation
export async function quickMkdir(
  path: string,
  recursive: boolean = false,
  options?: HttpClientOptions
): Promise<MkdirResponse> {
  const client = createClient(options);
  await client.createSession();

  try {
    return await client.mkdir(path, recursive);
  } finally {
    client.clearSession();
  }
}

// Convenience function for quick streaming git checkout
export async function quickGitCheckoutStream(
  repoUrl: string,
  branch: string = "main",
  targetDir?: string,
  options?: HttpClientOptions
): Promise<void> {
  const client = createClient(options);
  await client.createSession();

  try {
    await client.gitCheckoutStream(repoUrl, branch, targetDir);
  } finally {
    client.clearSession();
  }
}

// Convenience function for quick streaming directory creation
export async function quickMkdirStream(
  path: string,
  recursive: boolean = false,
  options?: HttpClientOptions
): Promise<void> {
  const client = createClient(options);
  await client.createSession();

  try {
    await client.mkdirStream(path, recursive);
  } finally {
    client.clearSession();
  }
}

// Convenience function for quick file writing
export async function quickWriteFile(
  path: string,
  content: string,
  encoding: string = "utf-8",
  options?: HttpClientOptions
): Promise<WriteFileResponse> {
  const client = createClient(options);
  await client.createSession();

  try {
    return await client.writeFile(path, content, encoding);
  } finally {
    client.clearSession();
  }
}

// Convenience function for quick streaming file writing
export async function quickWriteFileStream(
  path: string,
  content: string,
  encoding: string = "utf-8",
  options?: HttpClientOptions
): Promise<void> {
  const client = createClient(options);
  await client.createSession();

  try {
    await client.writeFileStream(path, content, encoding);
  } finally {
    client.clearSession();
  }
}

// Convenience function for quick file reading
export async function quickReadFile(
  path: string,
  encoding: string = "utf-8",
  options?: HttpClientOptions
): Promise<ReadFileResponse> {
  const client = createClient(options);
  await client.createSession();

  try {
    return await client.readFile(path, encoding);
  } finally {
    client.clearSession();
  }
}

// Convenience function for quick streaming file reading
export async function quickReadFileStream(
  path: string,
  encoding: string = "utf-8",
  options?: HttpClientOptions
): Promise<void> {
  const client = createClient(options);
  await client.createSession();

  try {
    await client.readFileStream(path, encoding);
  } finally {
    client.clearSession();
  }
}

// Convenience function for quick file deletion
export async function quickDeleteFile(
  path: string,
  options?: HttpClientOptions
): Promise<DeleteFileResponse> {
  const client = createClient(options);
  await client.createSession();

  try {
    return await client.deleteFile(path);
  } finally {
    client.clearSession();
  }
}

// Convenience function for quick streaming file deletion
export async function quickDeleteFileStream(
  path: string,
  options?: HttpClientOptions
): Promise<void> {
  const client = createClient(options);
  await client.createSession();

  try {
    await client.deleteFileStream(path);
  } finally {
    client.clearSession();
  }
}

// Convenience function for quick file renaming
export async function quickRenameFile(
  oldPath: string,
  newPath: string,
  options?: HttpClientOptions
): Promise<RenameFileResponse> {
  const client = createClient(options);
  await client.createSession();

  try {
    return await client.renameFile(oldPath, newPath);
  } finally {
    client.clearSession();
  }
}

// Convenience function for quick streaming file renaming
export async function quickRenameFileStream(
  oldPath: string,
  newPath: string,
  options?: HttpClientOptions
): Promise<void> {
  const client = createClient(options);
  await client.createSession();

  try {
    await client.renameFileStream(oldPath, newPath);
  } finally {
    client.clearSession();
  }
}

// Convenience function for quick file moving
export async function quickMoveFile(
  sourcePath: string,
  destinationPath: string,
  options?: HttpClientOptions
): Promise<MoveFileResponse> {
  const client = createClient(options);
  await client.createSession();

  try {
    return await client.moveFile(sourcePath, destinationPath);
  } finally {
    client.clearSession();
  }
}

// Convenience function for quick streaming file moving
export async function quickMoveFileStream(
  sourcePath: string,
  destinationPath: string,
  options?: HttpClientOptions
): Promise<void> {
  const client = createClient(options);
  await client.createSession();

  try {
    await client.moveFileStream(sourcePath, destinationPath);
  } finally {
    client.clearSession();
  }
}
