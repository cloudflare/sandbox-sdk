import type React from "react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import "./style.css";
import { codeExamples } from "../shared/examples";
import { LaTeXRenderer } from "./components/LaTeXRenderer";
import { MarkdownRenderer } from "./components/MarkdownRenderer";

// Type definitions
interface FileInfo {
  name: string;
  absolutePath: string;
  relativePath: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
  mode: string;
  permissions: {
    readable: boolean;
    writable: boolean;
    executable: boolean;
  };
}

interface ListFilesOptions {
  recursive?: boolean;
  includeHidden?: boolean;
}

interface ListFilesResponse {
  success: boolean;
  path: string;
  files: FileInfo[];
  count: number;
  timestamp: string;
}

// Generate or retrieve a stable sandbox ID for this browser tab
function getClientSandboxId(): string {
  const storageKey = 'sandbox-client-id';

  // Try to get existing ID from sessionStorage (persists across page reloads)
  let sandboxId = sessionStorage.getItem(storageKey);

  if (!sandboxId) {
    // Generate new ID for this tab
    sandboxId = `client-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    sessionStorage.setItem(storageKey, sandboxId);
  }

  return sandboxId;
}

// Simple API client to replace direct HttpClient usage
class SandboxApiClient {
  private baseUrl: string;
  private sandboxId: string;
  private onCommandComplete?: (
    success: boolean,
    exitCode: number,
    stdout: string,
    stderr: string,
    command: string
  ) => void;
  private onCommandStart?: (command: string) => void;
  private onError?: (error: string, command?: string) => void;

  constructor(
    options: {
      baseUrl?: string;
      onCommandComplete?: (
        success: boolean,
        exitCode: number,
        stdout: string,
        stderr: string,
        command: string
      ) => void;
      onCommandStart?: (command: string) => void;
      onError?: (error: string, command?: string) => void;
    } = {}
  ) {
    this.baseUrl = options.baseUrl || window.location.origin;
    this.sandboxId = getClientSandboxId();
    this.onCommandComplete = options.onCommandComplete;
    this.onCommandStart = options.onCommandStart;
    this.onError = options.onError;
  }

  private async doFetch(url: string, options: RequestInit): Promise<any> {
    const response = await fetch(`${this.baseUrl}${url}`, {
      headers: {
        "Content-Type": "application/json",
        "X-Sandbox-Client-Id": this.sandboxId,
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response.json();
  }

  async execute(command: string, args: string[], options: any = {}) {
    if (this.onCommandStart) {
      this.onCommandStart(command);
    }

    try {
      const result = await this.doFetch("/api/execute", {
        method: "POST",
        body: JSON.stringify({
          command: `${command} ${args.join(" ")}`,
          ...options,
        }),
      });

      if (this.onCommandComplete) {
        this.onCommandComplete(
          result.success,
          result.exitCode,
          result.stdout,
          result.stderr,
          result.command
        );
      }

      return result;
    } catch (error: any) {
      if (this.onError) {
        this.onError(error.message, command);
      }
      throw error;
    }
  }

  async listProcesses() {
    return this.doFetch("/api/process/list", {
      method: "GET",
    });
  }

  async startProcess(command: string, args: string[], options: any = {}) {
    return this.doFetch("/api/process/start", {
      method: "POST",
      body: JSON.stringify({
        command,
        args,
        ...options,
      }),
    });
  }

  async killProcess(processId: string) {
    return this.doFetch(`/api/process/${processId}`, {
      method: "DELETE",
    });
  }

  async killAllProcesses() {
    return this.doFetch("/api/process/kill-all", {
      method: "DELETE",
    });
  }

  async getProcess(processId: string) {
    return this.doFetch(`/api/process/${processId}`, {
      method: "GET",
    });
  }

  async getProcessLogs(processId: string) {
    return this.doFetch(`/api/process/${processId}/logs`, {
      method: "GET",
    });
  }

  async exposePort(port: number, options: any = {}) {
    return this.doFetch("/api/expose-port", {
      method: "POST",
      body: JSON.stringify({
        port,
        ...options,
      }),
    });
  }

  async unexposePort(port: number) {
    return this.doFetch("/api/unexpose-port", {
      method: "POST",
      body: JSON.stringify({ port }),
    });
  }

  async getExposedPorts() {
    return this.doFetch("/api/exposed-ports", {
      method: "GET",
    });
  }

  async *streamProcessLogs(processId: string, options?: { signal?: AbortSignal }): AsyncGenerator<any> {
    const response = await fetch(
      `${this.baseUrl}/api/process/${processId}/stream`,
      {
        headers: {
          Accept: "text/event-stream",
        },
        signal: options?.signal,  // Pass the abort signal to fetch
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = ""; // Buffer for incomplete lines

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Add chunk to buffer
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events
        while (true) {
          const eventEnd = buffer.indexOf("\n\n");
          if (eventEnd === -1) break; // No complete event yet

          const eventData = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);

          // Parse the SSE event
          const lines = eventData.split("\n");
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const event = JSON.parse(line.substring(6));
                yield event;
              } catch (e) {
                console.warn("Failed to parse SSE event:", line, e);
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async writeFile(path: string, content: string, options: any = {}) {
    return this.doFetch("/api/write", {
      method: "POST",
      body: JSON.stringify({
        path,
        content,
        ...options,
      }),
    });
  }

  async readFile(path: string, options: any = {}) {
    return this.doFetch("/api/read", {
      method: "POST",
      body: JSON.stringify({
        path,
        ...options,
      }),
    });
  }

  async deleteFile(path: string) {
    return this.doFetch("/api/delete", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  }

  async renameFile(oldPath: string, newPath: string) {
    return this.doFetch("/api/rename", {
      method: "POST",
      body: JSON.stringify({ oldPath, newPath }),
    });
  }

  async moveFile(sourcePath: string, destinationPath: string) {
    return this.doFetch("/api/move", {
      method: "POST",
      body: JSON.stringify({ sourcePath, destinationPath }),
    });
  }

  async listFiles(path: string, options: ListFilesOptions = {}): Promise<ListFilesResponse> {
    return this.doFetch("/api/list-files", {
      method: "POST",
      body: JSON.stringify({ path, options }),
    });
  }

  async mkdir(path: string, options: any = {}) {
    return this.doFetch("/api/mkdir", {
      method: "POST",
      body: JSON.stringify({
        path,
        ...options,
      }),
    });
  }

  async gitCheckout(repoUrl: string, branch?: string, targetDir?: string) {
    return this.doFetch("/api/git/checkout", {
      method: "POST",
      body: JSON.stringify({ repoUrl, branch, targetDir }),
    });
  }

  async createTestBinaryFile() {
    return this.doFetch("/api/create-test-binary", {
      method: "POST",
    });
  }

  async setupNextjs(projectName?: string) {
    return this.doFetch("/api/templates/nextjs", {
      method: "POST",
      body: JSON.stringify({ projectName }),
    });
  }

  async setupReact(projectName?: string) {
    return this.doFetch("/api/templates/react", {
      method: "POST",
      body: JSON.stringify({ projectName }),
    });
  }

  async setupVue(projectName?: string) {
    return this.doFetch("/api/templates/vue", {
      method: "POST",
      body: JSON.stringify({ projectName }),
    });
  }

  async setupStatic(projectName?: string) {
    return this.doFetch("/api/templates/static", {
      method: "POST",
      body: JSON.stringify({ projectName }),
    });
  }

  async *execStream(
    command: string,
    args: string[],
    options: any = {}
  ): AsyncGenerator<any> {
    const response = await fetch(`${this.baseUrl}/api/execute/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        command: `${command} ${args.join(" ")}`,
        ...options,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = ""; // Buffer for incomplete lines

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Add chunk to buffer
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events
        while (true) {
          const eventEnd = buffer.indexOf("\n\n");
          if (eventEnd === -1) break; // No complete event yet

          const eventData = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);

          // Parse the SSE event
          const lines = eventData.split("\n");
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const event = JSON.parse(line.substring(6));
                yield event;
              } catch (e) {
                console.warn("Failed to parse SSE event:", line, e);
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async executeStream(command: string, args: string[], options: any = {}) {
    return this.execStream(command, args, options);
  }

  async ping() {
    return this.doFetch("/api/ping", {
      method: "GET",
    });
  }

  async createSession(sessionId?: string) {
    return this.doFetch("/api/session/create", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
  }

  async clearSession(sessionId: string) {
    return this.doFetch(`/api/session/clear/${sessionId}`, {
      method: "POST",
    });
  }

  // Notebook API methods
  async createNotebookSession(language: string = "python") {
    return this.doFetch("/api/notebook/session", {
      method: "POST",
      body: JSON.stringify({ language }),
    });
  }

  async *executeNotebookCell(
    code: string,
    sessionId: string,
    language: string = "python"
  ): AsyncGenerator<any> {
    const response = await fetch(`${this.baseUrl}/api/notebook/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ code, sessionId, language }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
              const event = JSON.parse(data);
              yield event;
            } catch (e) {
              console.warn("Failed to parse SSE event:", line, e);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async deleteNotebookSession(sessionId: string) {
    return this.doFetch("/api/notebook/session", {
      method: "DELETE",
      body: JSON.stringify({ sessionId }),
    });
  }
}

interface CommandResult {
  id: string;
  command: string;
  status: "running" | "completed" | "error";
  stdout: string;
  stderr: string;
  exitCode?: number;
  timestamp: Date;
}

type TabType =
  | "commands"
  | "processes"
  | "ports"
  | "streaming"
  | "files"
  | "notebook"
  | "examples";

interface ProcessInfo {
  id: string;
  pid?: number;
  command: string;
  status: "starting" | "running" | "completed" | "failed" | "killed" | "error";
  startTime: string;
  endTime?: string;
  exitCode?: number;
  sessionId?: string;
}

interface ProcessLogs {
  stdout: string;
  stderr: string;
}

function ProcessManagementTab({
  client,
  connectionStatus,
  sessionId,
}: {
  client: SandboxApiClient | null;
  connectionStatus: "disconnected" | "connecting" | "connected";
  sessionId: string | null;
}) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [processCommand, setProcessCommand] = useState("");
  const [processOptions, setProcessOptions] = useState({
    env: "",
    cwd: "",
    timeout: "",
    processId: "",
  });
  const [selectedProcess, setSelectedProcess] = useState<string | null>(null);
  const [processLogs, setProcessLogs] = useState<ProcessLogs | null>(null);
  const [isStartingProcess, setIsStartingProcess] = useState(false);

  // Refresh processes list
  const refreshProcesses = async () => {
    if (!client || connectionStatus !== "connected") return;

    try {
      setIsLoading(true);
      const response = await client.listProcesses();
      setProcesses(response.processes);
    } catch (error) {
      console.error("Failed to refresh processes:", error);
    } finally {
      setIsLoading(false);
    }
  };

  // Auto-refresh processes every 2 seconds
  useEffect(() => {
    if (connectionStatus === "connected") {
      refreshProcesses();
      const interval = setInterval(refreshProcesses, 2000);
      return () => clearInterval(interval);
    }
  }, [client, connectionStatus]);

  // Start a background process
  const startProcess = async () => {
    if (!client || connectionStatus !== "connected" || !processCommand.trim())
      return;

    try {
      setIsStartingProcess(true);

      const options: any = {};
      if (processOptions.processId.trim())
        options.processId = processOptions.processId.trim();
      if (sessionId) options.sessionId = sessionId;
      if (processOptions.timeout.trim())
        options.timeout = parseInt(processOptions.timeout.trim());
      if (processOptions.cwd.trim()) options.cwd = processOptions.cwd.trim();

      // Parse environment variables
      if (processOptions.env.trim()) {
        const env: Record<string, string> = {};
        processOptions.env.split(",").forEach((pair) => {
          const [key, value] = pair.split("=");
          if (key && value) env[key.trim()] = value.trim();
        });
        options.env = env;
      }

      const response = await client.startProcess(
        processCommand.trim(),
        options
      );
      console.log("Process started:", response);

      // Clear form
      setProcessCommand("");
      setProcessOptions({ env: "", cwd: "", timeout: "", processId: "" });

      // Refresh processes list
      await refreshProcesses();
    } catch (error: any) {
      console.error("Failed to start process:", error);
      alert(`Failed to start process: ${error.message || error}`);
    } finally {
      setIsStartingProcess(false);
    }
  };

  // Kill a process
  const killProcess = async (processId: string) => {
    if (!client || connectionStatus !== "connected") return;

    try {
      await client.killProcess(processId);
      console.log("Process killed:", processId);
      await refreshProcesses();
    } catch (error: any) {
      console.error("Failed to kill process:", error);
      alert(`Failed to kill process: ${error.message || error}`);
    }
  };

  // Kill all processes
  const killAllProcesses = async () => {
    if (!client || connectionStatus !== "connected") return;

    if (!confirm("Are you sure you want to kill all processes?")) return;

    try {
      const response = await client.killAllProcesses();
      console.log("Killed processes:", response.killedCount);
      await refreshProcesses();
    } catch (error: any) {
      console.error("Failed to kill all processes:", error);
      alert(`Failed to kill all processes: ${error.message || error}`);
    }
  };

  // Get process logs
  const getProcessLogs = async (processId: string) => {
    if (!client || connectionStatus !== "connected") return;

    try {
      const response = await client.getProcessLogs(processId);
      setProcessLogs(response);
      setSelectedProcess(processId);
    } catch (error: any) {
      console.error("Failed to get process logs:", error);
      alert(`Failed to get process logs: ${error.message || error}`);
    }
  };

  const getStatusColor = (status: ProcessInfo["status"]) => {
    switch (status) {
      case "starting":
        return "text-yellow-500";
      case "running":
        return "text-blue-500";
      case "completed":
        return "text-green-500";
      case "failed":
      case "error":
        return "text-red-500";
      case "killed":
        return "text-orange-500";
      default:
        return "text-gray-500";
    }
  };

  const getStatusIcon = (status: ProcessInfo["status"]) => {
    switch (status) {
      case "starting":
        return "⏳";
      case "running":
        return "🟢";
      case "completed":
        return "✅";
      case "failed":
      case "error":
        return "❌";
      case "killed":
        return "🔶";
      default:
        return "⏳";
    }
  };

  return (
    <div className="process-management-tab">
      <div className="process-header">
        <h2>Background Process Management</h2>
        <div className="process-controls">
          <button
            onClick={refreshProcesses}
            disabled={isLoading}
            className="btn btn-refresh"
          >
            {isLoading ? "Refreshing..." : "Refresh"}
          </button>
          <button
            onClick={killAllProcesses}
            disabled={processes.length === 0}
            className="btn btn-danger"
          >
            Kill All
          </button>
        </div>
      </div>

      {/* Process Starter */}
      <div className="process-starter">
        <h3>Start New Process</h3>
        <div className="process-form">
          <div className="form-row">
            <input
              type="text"
              placeholder="Command (e.g., node server.js --port 8080)"
              value={processCommand}
              onChange={(e) => setProcessCommand(e.target.value)}
              className="process-input"
            />
          </div>

          <div className="form-row">
            <input
              type="text"
              placeholder="Process ID (optional)"
              value={processOptions.processId}
              onChange={(e) =>
                setProcessOptions((prev) => ({
                  ...prev,
                  processId: e.target.value,
                }))
              }
              className="process-input"
            />
            <input
              type="text"
              placeholder="Working Directory (optional)"
              value={processOptions.cwd}
              onChange={(e) =>
                setProcessOptions((prev) => ({ ...prev, cwd: e.target.value }))
              }
              className="process-input"
            />
          </div>

          <div className="form-row">
            <input
              type="text"
              placeholder="Timeout (ms, optional)"
              value={processOptions.timeout}
              onChange={(e) =>
                setProcessOptions((prev) => ({
                  ...prev,
                  timeout: e.target.value,
                }))
              }
              className="process-input"
            />
            <input
              type="text"
              placeholder="Environment (KEY1=val1,KEY2=val2)"
              value={processOptions.env}
              onChange={(e) =>
                setProcessOptions((prev) => ({ ...prev, env: e.target.value }))
              }
              className="process-input"
            />
          </div>

          <button
            onClick={startProcess}
            disabled={
              !processCommand.trim() ||
              isStartingProcess ||
              connectionStatus !== "connected"
            }
            className="btn btn-start-process"
          >
            {isStartingProcess ? "Starting..." : "Start Process"}
          </button>
        </div>

        {/* Quick Templates */}
        <div className="process-templates">
          <h4>Quick Templates:</h4>
          <div className="template-buttons">
            <button
              onClick={() => {
                setProcessCommand("bun run server.js");
                setProcessOptions((prev) => ({
                  ...prev,
                  processId: "bun-server",
                }));
              }}
              className="btn btn-template"
            >
              🟨 Bun Server
            </button>
            <button
              onClick={() => {
                setProcessCommand(
                  "node -e \"setInterval(() => console.log('Heartbeat:', new Date().toISOString()), 2000)\""
                );
                setProcessOptions((prev) => ({
                  ...prev,
                  processId: "heartbeat",
                }));
              }}
              className="btn btn-template"
            >
              💓 Heartbeat
            </button>
            <button
              onClick={() => {
                setProcessCommand("tail -f /var/log/messages");
                setProcessOptions((prev) => ({
                  ...prev,
                  processId: "log-watcher",
                }));
              }}
              className="btn btn-template"
            >
              📋 Log Watcher
            </button>
          </div>
        </div>
      </div>

      {/* Process List */}
      <div className="process-list">
        <h3>Active Processes ({processes.length})</h3>
        {processes.length === 0 ? (
          <div className="no-processes">
            No background processes running. Start one above!
          </div>
        ) : (
          <div className="process-table">
            <div className="process-table-header">
              <div>Status</div>
              <div>ID</div>
              <div>Command</div>
              <div>PID</div>
              <div>Started</div>
              <div>Actions</div>
            </div>
            {processes.map((process) => (
              <div key={process.id} className="process-table-row">
                <div className="process-status">
                  <span className="status-icon">
                    {getStatusIcon(process.status)}
                  </span>
                  <span className={getStatusColor(process.status)}>
                    {process.status}
                  </span>
                </div>
                <div className="process-id">{process.id}</div>
                <div className="process-command">{process.command}</div>
                <div className="process-pid">{process.pid || "N/A"}</div>
                <div className="process-started">
                  {new Date(process.startTime).toLocaleString()}
                </div>
                <div className="process-actions">
                  <button
                    onClick={() => getProcessLogs(process.id)}
                    className="btn btn-small btn-logs"
                  >
                    Logs
                  </button>
                  {process.status === "running" && (
                    <button
                      onClick={() => killProcess(process.id)}
                      className="btn btn-small btn-kill"
                    >
                      Kill
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Process Logs */}
      {selectedProcess && processLogs && (
        <div className="process-logs">
          <h3>Process Logs: {selectedProcess}</h3>
          <button
            onClick={() => {
              setSelectedProcess(null);
              setProcessLogs(null);
            }}
            className="btn btn-small"
          >
            Close
          </button>

          {processLogs.stdout && (
            <div className="logs-section">
              <h4>STDOUT:</h4>
              <pre className="logs-output stdout-logs">
                {processLogs.stdout}
              </pre>
            </div>
          )}

          {processLogs.stderr && (
            <div className="logs-section">
              <h4>STDERR:</h4>
              <pre className="logs-output stderr-logs">
                {processLogs.stderr}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ExposedPort {
  port: number;
  name?: string;
  url: string;
  exposedAt?: string;
}

function PortManagementTab({
  client,
  connectionStatus,
  sessionId,
}: {
  client: SandboxApiClient | null;
  connectionStatus: "disconnected" | "connecting" | "connected";
  sessionId: string | null;
}) {
  const [exposedPorts, setExposedPorts] = useState<ExposedPort[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [portNumber, setPortNumber] = useState("");
  const [portName, setPortName] = useState("");
  const [isExposing, setIsExposing] = useState(false);

  // Refresh exposed ports
  const refreshPorts = async () => {
    if (!client || connectionStatus !== "connected") return;

    try {
      setIsLoading(true);
      const response = await client.getExposedPorts();
      setExposedPorts(response.ports);
    } catch (error) {
      console.error("Failed to refresh ports:", error);
    } finally {
      setIsLoading(false);
    }
  };

  // Auto-refresh ports every 3 seconds
  useEffect(() => {
    if (connectionStatus === "connected") {
      refreshPorts();
      const interval = setInterval(refreshPorts, 3000);
      return () => clearInterval(interval);
    }
  }, [client, connectionStatus]);

  // Expose a port
  const exposePort = async () => {
    if (!client || connectionStatus !== "connected" || !portNumber.trim())
      return;

    try {
      setIsExposing(true);
      const port = parseInt(portNumber.trim());
      const options = portName.trim() ? { name: portName.trim() } : undefined;

      const response = await client.exposePort(port, options?.name);
      console.log("Port exposed:", response);

      // Clear form
      setPortNumber("");
      setPortName("");

      // Refresh ports list
      await refreshPorts();
    } catch (error: any) {
      console.error("Failed to expose port:", error);
      alert(`Failed to expose port: ${error.message || error}`);
    } finally {
      setIsExposing(false);
    }
  };

  // Unexpose a port
  const unexposePort = async (port: number) => {
    if (!client || connectionStatus !== "connected") return;

    try {
      await client.unexposePort(port);
      console.log("Port unexposed:", port);
      await refreshPorts();
    } catch (error: any) {
      console.error("Failed to unexpose port:", error);
      alert(`Failed to unexpose port: ${error.message || error}`);
    }
  };

  // Server templates
  const deployBunServer = async () => {
    if (!client || connectionStatus !== "connected") return;

    try {
      setIsExposing(true);

      // Create server file
      const serverCode = `
Bun.serve({
  port: 8080,
  fetch(req) {
    const url = new URL(req.url);
    console.log(\`Server received request: \${req.method} \${url.pathname}\`);

    if (url.pathname === "/") {
      return new Response("Hello from Bun server! 🎉", {
        headers: { "Content-Type": "text/plain" }
      });
    }

    if (url.pathname === "/api/status") {
      return new Response(JSON.stringify({
        status: "running",
        timestamp: new Date().toISOString(),
        message: "Bun server is working!"
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log("Bun server running on port 8080");
      `.trim();

      await client.writeFile("server.js", serverCode);

      // Start the server as a background process
      await client.startProcess("bun", ["run", "server.js"], {
        processId: "bun-server",
        sessionId,
      });

      // Wait a moment for server to start
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Expose the port
      await client.exposePort(8080, "bun-server");

      await refreshPorts();
    } catch (error: any) {
      console.error("Failed to deploy Bun server:", error);
      alert(`Failed to deploy Bun server: ${error.message || error}`);
    } finally {
      setIsExposing(false);
    }
  };

  const deployNodeServer = async () => {
    if (!client || connectionStatus !== "connected") return;

    try {
      setIsExposing(true);

      // Create server file
      const serverCode = `
const http = require('http');

const server = http.createServer((req, res) => {
  console.log(\`Server received request: \${req.method} \${req.url}\`);

  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/') {
    res.writeHead(200);
    res.end(JSON.stringify({
      message: "Hello from Node.js server! 🟢",
      timestamp: new Date().toISOString(),
      method: req.method,
      url: req.url
    }));
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: "healthy",
      uptime: process.uptime(),
      memory: process.memoryUsage()
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(3001, () => {
  console.log('Node.js server running on port 3001');
});
      `.trim();

      await client.writeFile("node-server.js", serverCode);

      // Start the server as a background process
      await client.startProcess("node", ["node-server.js"], {
        processId: "node-server",
        sessionId,
      });

      // Wait a moment for server to start
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Expose the port
      await client.exposePort(3001, "node-server");

      await refreshPorts();
    } catch (error: any) {
      console.error("Failed to deploy Node server:", error);
      alert(`Failed to deploy Node server: ${error.message || error}`);
    } finally {
      setIsExposing(false);
    }
  };

  const deployPythonServer = async () => {
    if (!client || connectionStatus !== "connected") return;

    try {
      setIsExposing(true);

      // Create server file
      const serverCode = `
import http.server
import socketserver
import json
from datetime import datetime

class MyHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        print(f"Server received request: {self.command} {self.path}")

        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            response = {
                "message": "Hello from Python server! 🐍",
                "timestamp": datetime.now().isoformat(),
                "method": self.command,
                "path": self.path
            }
            self.wfile.write(json.dumps(response).encode())
        elif self.path == '/info':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            response = {
                "server": "Python HTTP Server",
                "port": 8000,
                "status": "running"
            }
            self.wfile.write(json.dumps(response).encode())
        else:
            self.send_response(404)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Not found"}).encode())

PORT = 8000
with socketserver.TCPServer(("", PORT), MyHandler) as httpd:
    print(f"Python server running on port {PORT}")
    httpd.serve_forever()
      `.trim();

      await client.writeFile("python-server.py", serverCode);

      // Start the server as a background process
      await client.startProcess("python3", ["python-server.py"], {
        processId: "python-server",
        sessionId,
      });

      // Wait a moment for server to start
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Expose the port
      await client.exposePort(8000, "python-server");

      await refreshPorts();
    } catch (error: any) {
      console.error("Failed to deploy Python server:", error);
      alert(`Failed to deploy Python server: ${error.message || error}`);
    } finally {
      setIsExposing(false);
    }
  };

  return (
    <div className="port-management-tab">
      <div className="port-header">
        <h2>Port Management & Preview URLs</h2>
        <div className="port-controls">
          <button
            onClick={refreshPorts}
            disabled={isLoading}
            className="btn btn-refresh"
          >
            {isLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Port Exposure */}
      <div className="port-exposer">
        <h3>Expose Port</h3>
        <div className="port-form">
          <div className="form-row">
            <input
              type="number"
              placeholder="Port Number (e.g., 8080)"
              value={portNumber}
              onChange={(e) => setPortNumber(e.target.value)}
              className="port-input"
              min="1"
              max="65535"
            />
            <input
              type="text"
              placeholder="Port Name (optional)"
              value={portName}
              onChange={(e) => setPortName(e.target.value)}
              className="port-input"
            />
          </div>

          <button
            onClick={exposePort}
            disabled={
              !portNumber.trim() ||
              isExposing ||
              connectionStatus !== "connected"
            }
            className="btn btn-expose-port"
          >
            {isExposing ? "Exposing..." : "Expose Port"}
          </button>
        </div>

        {/* Server Templates */}
        <div className="server-templates">
          <h4>Quick Server Templates:</h4>
          <div className="template-buttons">
            <button
              onClick={deployBunServer}
              disabled={isExposing || connectionStatus !== "connected"}
              className="btn btn-template"
            >
              🟨 Bun Server (8080)
            </button>
            <button
              onClick={deployNodeServer}
              disabled={isExposing || connectionStatus !== "connected"}
              className="btn btn-template"
            >
              🟢 Node.js Server (3001)
            </button>
            <button
              onClick={deployPythonServer}
              disabled={isExposing || connectionStatus !== "connected"}
              className="btn btn-template"
            >
              🐍 Python Server (8000)
            </button>
          </div>
          <p className="template-note">
            These templates will create a server file, start it as a background
            process, and expose the port automatically.
          </p>
        </div>
      </div>

      {/* Exposed Ports List */}
      <div className="exposed-ports">
        <h3>Exposed Ports ({exposedPorts.length})</h3>
        {exposedPorts.length === 0 ? (
          <div className="no-ports">
            No ports exposed yet. Expose a port above or use a server template!
          </div>
        ) : (
          <div className="ports-grid">
            {exposedPorts.map((port) => (
              <div key={port.port} className="port-card">
                <div className="port-info">
                  <div className="port-number">Port {port.port}</div>
                  {port.name && <div className="port-name">{port.name}</div>}
                  {port.exposedAt && (
                    <div className="port-exposed-at">
                      Exposed: {new Date(port.exposedAt).toLocaleString()}
                    </div>
                  )}
                </div>

                <div className="port-url">
                  <a
                    href={port.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="preview-link"
                  >
                    🌐 {port.url}
                  </a>
                </div>

                <div className="port-actions">
                  <button
                    onClick={() => window.open(port.url, "_blank")}
                    className="btn btn-small btn-visit"
                  >
                    Visit
                  </button>
                  <button
                    onClick={() => unexposePort(port.port)}
                    className="btn btn-small btn-unexpose"
                  >
                    Unexpose
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Integration Notes */}
      <div className="integration-info">
        <h3>💡 Pro Tips</h3>
        <ul>
          <li>
            <strong>Background Processes:</strong> Use the "Processes" tab to
            start servers, then expose their ports here
          </li>
          <li>
            <strong>Server Templates:</strong> Click the template buttons above
            for instant server setup
          </li>
          <li>
            <strong>Preview URLs:</strong> All exposed ports get unique preview
            URLs that work from anywhere
          </li>
          <li>
            <strong>Port Management:</strong> Unexpose ports when done to free
            up resources
          </li>
        </ul>
      </div>
    </div>
  );
}

interface StreamEvent {
  id: string;
  type: "start" | "stdout" | "stderr" | "complete" | "error";
  timestamp: string;
  data?: string;
  command?: string;
  exitCode?: number;
  error?: Error;
}

interface LogStreamEvent {
  id: string;
  type: "stdout" | "stderr" | "status" | "error";
  timestamp: string;
  data: string;
  processId: string;
  sessionId?: string;
}

interface ActiveStream {
  id: string;
  type: "command" | "process-logs";
  title: string;
  command?: string;
  processId?: string;
  isActive: boolean;
  events: (StreamEvent | LogStreamEvent)[];
  startTime: Date;
}

function FilesTab({
  client,
  connectionStatus,
}: {
  client: SandboxApiClient | null;
  connectionStatus: "disconnected" | "connecting" | "connected";
}) {
  const [currentPath, setCurrentPath] = useState("/");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [isReading, setIsReading] = useState(false);
  const [results, setResults] = useState<
    Array<{ type: "success" | "error"; message: string; timestamp: Date }>
  >([]);

  // File Operations
  const [newFileName, setNewFileName] = useState("");
  const [newFileContent, setNewFileContent] = useState("");
  const [newDirName, setNewDirName] = useState("");
  const [renameOldPath, setRenameOldPath] = useState("");
  const [renameNewPath, setRenameNewPath] = useState("");
  const [moveSourcePath, setMoveSourcePath] = useState("");
  const [moveDestPath, setMoveDestPath] = useState("");
  const [deleteFilePath, setDeleteFilePath] = useState("");
  const [listPath, setListPath] = useState("/workspace");
  const [listRecursive, setListRecursive] = useState(false);
  const [listHidden, setListHidden] = useState(false);
  const [listedFiles, setListedFiles] = useState<FileInfo[]>([]);

  // Git Operations
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("main");
  const [gitTargetDir, setGitTargetDir] = useState("");

  // Binary File Support
  const [binaryFilePath, setBinaryFilePath] = useState("/workspace/demo-chart.png");
  const [binaryFileMetadata, setBinaryFileMetadata] = useState<{
    path: string;
    mimeType: string;
    size: number;
    isBinary: boolean;
    encoding: string;
    content?: string;
  } | null>(null);
  const [isCreatingBinary, setIsCreatingBinary] = useState(false);
  const [isReadingBinary, setIsReadingBinary] = useState(false);

  const addResult = (type: "success" | "error", message: string) => {
    setResults((prev) => [...prev, { type, message, timestamp: new Date() }]);
  };

  const handleReadFile = async () => {
    if (!client || !selectedFile) return;
    setIsReading(true);
    try {
      const result = await client.readFile(selectedFile);
      setFileContent(result.content || "");
      addResult("success", `Read file: ${selectedFile}`);
    } catch (error: any) {
      addResult("error", `Failed to read ${selectedFile}: ${error.message}`);
      setFileContent("");
    } finally {
      setIsReading(false);
    }
  };

  const handleWriteFile = async () => {
    if (!client || !newFileName.trim()) return;
    try {
      await client.writeFile(newFileName, newFileContent);
      addResult("success", `Created file: ${newFileName}`);
      setNewFileName("");
      setNewFileContent("");
    } catch (error: any) {
      addResult("error", `Failed to create file: ${error.message}`);
    }
  };

  const handleCreateDir = async () => {
    if (!client || !newDirName.trim()) return;
    try {
      await client.mkdir(newDirName, { recursive: true });
      addResult("success", `Created directory: ${newDirName}`);
      setNewDirName("");
    } catch (error: any) {
      addResult("error", `Failed to create directory: ${error.message}`);
    }
  };

  const handleRenameFile = async () => {
    if (!client || !renameOldPath.trim() || !renameNewPath.trim()) return;
    try {
      await client.renameFile(renameOldPath, renameNewPath);
      addResult("success", `Renamed: ${renameOldPath} → ${renameNewPath}`);
      setRenameOldPath("");
      setRenameNewPath("");
    } catch (error: any) {
      addResult("error", `Failed to rename: ${error.message}`);
    }
  };

  const handleMoveFile = async () => {
    if (!client || !moveSourcePath.trim() || !moveDestPath.trim()) return;
    try {
      await client.moveFile(moveSourcePath, moveDestPath);
      addResult("success", `Moved: ${moveSourcePath} → ${moveDestPath}`);
      setMoveSourcePath("");
      setMoveDestPath("");
    } catch (error: any) {
      addResult("error", `Failed to move: ${error.message}`);
    }
  };

  const handleDeleteFile = async () => {
    if (!client || !deleteFilePath.trim()) return;
    try {
      await client.deleteFile(deleteFilePath);
      addResult("success", `Deleted: ${deleteFilePath}`);
      setDeleteFilePath("");
    } catch (error: any) {
      addResult("error", `Failed to delete: ${error.message}`);
    }
  };

  const handleListFiles = async () => {
    if (!client || !listPath.trim()) return;
    try {
      const result = await client.listFiles(listPath, {
        recursive: listRecursive,
        includeHidden: listHidden,
      });
      
      // Sort files for proper tree display using relativePath
      const sortedFiles = (result.files || []).sort((a, b) => {
        // Use relativePath for cleaner sorting
        const aSegments = a.relativePath.split('/').filter(s => s);
        const bSegments = b.relativePath.split('/').filter(s => s);
        
        // Compare segment by segment
        const minLength = Math.min(aSegments.length, bSegments.length);
        
        for (let i = 0; i < minLength; i++) {
          // If we're at the last segment for either path
          const aIsLast = i === aSegments.length - 1;
          const bIsLast = i === bSegments.length - 1;
          
          // If one is a parent of the other
          if (aIsLast && !bIsLast) {
            // a is a parent directory of b (if a is a directory)
            return a.type === 'directory' ? -1 : 1;
          }
          if (!aIsLast && bIsLast) {
            // b is a parent directory of a (if b is a directory)
            return b.type === 'directory' ? 1 : -1;
          }
          
          // If both are at the same level (both last or both not last)
          if (aIsLast && bIsLast) {
            // Same directory level - directories first, then alphabetical
            if (a.type === 'directory' && b.type !== 'directory') return -1;
            if (a.type !== 'directory' && b.type === 'directory') return 1;
          }
          
          // Compare the segments alphabetically
          const segmentCompare = aSegments[i].localeCompare(bSegments[i]);
          if (segmentCompare !== 0) return segmentCompare;
        }
        
        // If we get here, one path is a prefix of the other
        // The shorter path (parent) should come first
        return aSegments.length - bSegments.length;
      });
      
      setListedFiles(sortedFiles);
      addResult("success", `Listed ${result.count || 0} files in: ${listPath}`);
    } catch (error: any) {
      addResult("error", `Failed to list files: ${error.message}`);
      setListedFiles([]);
    }
  };

  const handleGitCheckout = async () => {
    if (!client || !gitRepoUrl.trim()) return;
    try {
      await client.gitCheckout(
        gitRepoUrl,
        gitBranch || "main",
        gitTargetDir || undefined
      );
      addResult(
        "success",
        `Cloned: ${gitRepoUrl} (${gitBranch}) → ${
          gitTargetDir || "current directory"
        }`
      );
    } catch (error: any) {
      addResult("error", `Failed to clone repository: ${error.message}`);
    }
  };

  const handleCreateTestBinary = async () => {
    if (!client) return;
    setIsCreatingBinary(true);
    try {
      const result = await client.createTestBinaryFile();
      addResult("success", `Created test PNG: ${result.path}`);
      setBinaryFilePath(result.path);
      // Clear any existing metadata to show fresh state
      setBinaryFileMetadata(null);
    } catch (error: any) {
      addResult("error", `Failed to create test binary: ${error.message}`);
    } finally {
      setIsCreatingBinary(false);
    }
  };

  const handleReadBinaryFile = async () => {
    if (!client || !binaryFilePath.trim()) return;
    setIsReadingBinary(true);
    try {
      const result = await client.readFile(binaryFilePath);
      setBinaryFileMetadata({
        path: result.path,
        mimeType: result.mimeType || "unknown",
        size: result.size || 0,
        isBinary: result.isBinary || false,
        encoding: result.encoding || "utf-8",
        content: result.content,
      });
      addResult("success", `Read binary file with metadata: ${binaryFilePath}`);
    } catch (error: any) {
      addResult("error", `Failed to read binary file: ${error.message}`);
      setBinaryFileMetadata(null);
    } finally {
      setIsReadingBinary(false);
    }
  };

  return (
    <div className="files-tab">
      <div className="files-section">
        <h2>📁 File Operations</h2>

        {/* File Reading */}
        <div className="operation-group">
          <h3>Read File</h3>
          <div className="input-group">
            <input
              type="text"
              placeholder="File path (e.g., /workspace/package.json)"
              value={selectedFile || ""}
              onChange={(e) => setSelectedFile(e.target.value)}
              className="file-input"
            />
            <button
              onClick={handleReadFile}
              disabled={
                !selectedFile || isReading || connectionStatus !== "connected"
              }
              className="action-button"
            >
              {isReading ? "Reading..." : "Read"}
            </button>
          </div>
          {fileContent && (
            <div className="file-content">
              <h4>File Content:</h4>
              <pre className="code-block">{fileContent}</pre>
            </div>
          )}
        </div>

        {/* File Creation */}
        <div className="operation-group">
          <h3>Create File</h3>
          <div className="input-group">
            <input
              type="text"
              placeholder="File path (e.g., /workspace/hello.txt)"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              className="file-input"
            />
          </div>
          <div className="input-group">
            <textarea
              placeholder="File content"
              value={newFileContent}
              onChange={(e) => setNewFileContent(e.target.value)}
              className="file-textarea"
              rows={4}
            />
          </div>
          <button
            onClick={handleWriteFile}
            disabled={!newFileName.trim() || connectionStatus !== "connected"}
            className="action-button"
          >
            Create File
          </button>
        </div>

        {/* Directory Creation */}
        <div className="operation-group">
          <h3>Create Directory</h3>
          <div className="input-group">
            <input
              type="text"
              placeholder="Directory path (e.g., /workspace/src)"
              value={newDirName}
              onChange={(e) => setNewDirName(e.target.value)}
              className="file-input"
            />
            <button
              onClick={handleCreateDir}
              disabled={!newDirName.trim() || connectionStatus !== "connected"}
              className="action-button"
            >
              Create Directory
            </button>
          </div>
        </div>

        {/* File Rename */}
        <div className="operation-group">
          <h3>Rename File</h3>
          <div className="input-group">
            <input
              type="text"
              placeholder="Old path"
              value={renameOldPath}
              onChange={(e) => setRenameOldPath(e.target.value)}
              className="file-input"
            />
            <input
              type="text"
              placeholder="New path"
              value={renameNewPath}
              onChange={(e) => setRenameNewPath(e.target.value)}
              className="file-input"
            />
            <button
              onClick={handleRenameFile}
              disabled={
                !renameOldPath.trim() ||
                !renameNewPath.trim() ||
                connectionStatus !== "connected"
              }
              className="action-button"
            >
              Rename
            </button>
          </div>
        </div>

        {/* File Move */}
        <div className="operation-group">
          <h3>Move File</h3>
          <div className="input-group">
            <input
              type="text"
              placeholder="Source path"
              value={moveSourcePath}
              onChange={(e) => setMoveSourcePath(e.target.value)}
              className="file-input"
            />
            <input
              type="text"
              placeholder="Destination path"
              value={moveDestPath}
              onChange={(e) => setMoveDestPath(e.target.value)}
              className="file-input"
            />
            <button
              onClick={handleMoveFile}
              disabled={
                !moveSourcePath.trim() ||
                !moveDestPath.trim() ||
                connectionStatus !== "connected"
              }
              className="action-button"
            >
              Move
            </button>
          </div>
        </div>

        {/* File Delete */}
        <div className="operation-group">
          <h3>Delete File</h3>
          <div className="input-group">
            <input
              type="text"
              placeholder="File path to delete"
              value={deleteFilePath}
              onChange={(e) => setDeleteFilePath(e.target.value)}
              className="file-input"
            />
            <button
              onClick={handleDeleteFile}
              disabled={
                !deleteFilePath.trim() || connectionStatus !== "connected"
              }
              className="action-button delete-button"
            >
              Delete
            </button>
          </div>
        </div>

        {/* List Files */}
        <div className="operation-group">
          <h3>List Files</h3>
          <div className="input-group">
            <input
              type="text"
              placeholder="Directory path (e.g., /workspace)"
              value={listPath}
              onChange={(e) => setListPath(e.target.value)}
              className="file-input"
            />
            <button
              onClick={handleListFiles}
              disabled={!listPath.trim() || connectionStatus !== "connected"}
              className="action-button"
            >
              List Files
            </button>
          </div>
          <div className="list-options">
            <label>
              <input
                type="checkbox"
                checked={listRecursive}
                onChange={(e) => setListRecursive(e.target.checked)}
              />
              Recursive
            </label>
            <label>
              <input
                type="checkbox"
                checked={listHidden}
                onChange={(e) => setListHidden(e.target.checked)}
              />
              Include Hidden
            </label>
          </div>
          {listedFiles.length > 0 && (
            <div className="file-list-results">
              <h4>Files ({listedFiles.length}):</h4>
              <div className="file-list">
                {listedFiles.map((file, index) => {
                  // Calculate indentation level using the relativePath field
                  const depth = listRecursive ? (file.relativePath.split('/').filter(s => s).length - 1) : 0;
                  
                  // For directories, add a trailing slash for clarity
                  const displayName = file.type === 'directory' ? `${file.name}/` : file.name;
                  
                  // Add tree-like prefix for better hierarchy visualization
                  const treePrefix = depth > 0 ? '├── ' : '';
                  
                  return (
                    <div 
                      key={index} 
                      className="file-item"
                      style={{ 
                        paddingLeft: `${depth * 16 + 8}px`,
                        fontWeight: file.type === 'directory' ? '500' : 'normal'
                      }}
                    >
                      {depth > 0 && <span className="tree-prefix">{treePrefix}</span>}
                      <span className="file-icon">
                        {file.type === 'directory' ? '📁' : 
                         file.permissions.executable ? '⚙️' : '📄'}
                      </span>
                      <span className="file-mode">{file.mode}</span>
                      <span className="file-name" title={file.absolutePath}>
                        {displayName}
                      </span>
                      <span className="file-details">
                        {file.type === 'file' && (
                          <span className="file-size">{file.size.toLocaleString()} bytes</span>
                        )}
                        <span className="file-date">
                          {new Date(file.modifiedAt).toLocaleDateString()}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Git Operations */}
      <div className="git-section">
        <h2>🔀 Git Operations</h2>
        <div className="operation-group">
          <h3>Clone Repository</h3>
          <div className="input-group">
            <input
              type="text"
              placeholder="Repository URL (e.g., https://github.com/user/repo.git)"
              value={gitRepoUrl}
              onChange={(e) => setGitRepoUrl(e.target.value)}
              className="file-input"
            />
          </div>
          <div className="input-group">
            <input
              type="text"
              placeholder="Branch (default: main)"
              value={gitBranch}
              onChange={(e) => setGitBranch(e.target.value)}
              className="file-input"
            />
            <input
              type="text"
              placeholder="Target directory (optional)"
              value={gitTargetDir}
              onChange={(e) => setGitTargetDir(e.target.value)}
              className="file-input"
            />
          </div>
          <button
            onClick={handleGitCheckout}
            disabled={!gitRepoUrl.trim() || connectionStatus !== "connected"}
            className="action-button"
          >
            Clone Repository
          </button>
        </div>

        {/* Popular Templates */}
        <div className="templates-section">
          <h3>Quick Templates</h3>
          <div className="template-buttons">
            <button
              onClick={() => {
                setGitRepoUrl("https://github.com/vercel/next.js.git");
                setGitBranch("canary");
                setGitTargetDir("nextjs-example");
              }}
              className="template-button"
            >
              Next.js
            </button>
            <button
              onClick={() => {
                setGitRepoUrl(
                  "https://github.com/facebook/create-react-app.git"
                );
                setGitBranch("main");
                setGitTargetDir("react-example");
              }}
              className="template-button"
            >
              React
            </button>
            <button
              onClick={() => {
                setGitRepoUrl("https://github.com/vuejs/create-vue.git");
                setGitBranch("main");
                setGitTargetDir("vue-example");
              }}
              className="template-button"
            >
              Vue.js
            </button>
          </div>
        </div>
      </div>
      {/* Quick Setup */}
      <div className="quick-setup-section">
        <h2>🚀 Quick Project Setup</h2>
        <p className="section-description">
          Create and run complete development environments with one click!
        </p>
        <div className="quick-setup-buttons">
          <button
            onClick={async () => {
              if (!client || connectionStatus !== "connected") return;
              try {
                addResult("success", "Starting Next.js project setup...");
                const result = await client.setupNextjs();
                addResult(
                  "success",
                  `${result.message} Preview: ${result.previewUrl}`
                );
              } catch (error: any) {
                addResult("error", `Failed to setup Next.js: ${error.message}`);
              }
            }}
            disabled={connectionStatus !== "connected"}
            className="quick-setup-button nextjs"
          >
            <div className="setup-icon">⚡</div>
            <div className="setup-info">
              <div className="setup-title">Next.js</div>
              <div className="setup-description">
                Full-stack React framework
              </div>
            </div>
          </button>
          <button
            onClick={async () => {
              if (!client || connectionStatus !== "connected") return;
              try {
                addResult("success", "Starting React project setup...");
                const result = await client.setupReact();
                addResult(
                  "success",
                  `${result.message} Preview: ${result.previewUrl}`
                );
              } catch (error: any) {
                addResult("error", `Failed to setup React: ${error.message}`);
              }
            }}
            disabled={connectionStatus !== "connected"}
            className="quick-setup-button react"
          >
            <div className="setup-icon">⚛️</div>
            <div className="setup-info">
              <div className="setup-title">React</div>
              <div className="setup-description">
                JavaScript library for UIs
              </div>
            </div>
          </button>
          <button
            onClick={async () => {
              if (!client || connectionStatus !== "connected") return;
              try {
                addResult("success", "Starting Vue project setup...");
                const result = await client.setupVue();
                addResult(
                  "success",
                  `${result.message} Preview: ${result.previewUrl}`
                );
              } catch (error: any) {
                addResult("error", `Failed to setup Vue: ${error.message}`);
              }
            }}
            disabled={connectionStatus !== "connected"}
            className="quick-setup-button vue"
          >
            <div className="setup-icon">💚</div>
            <div className="setup-info">
              <div className="setup-title">Vue.js</div>
              <div className="setup-description">Progressive framework</div>
            </div>
          </button>
          <button
            onClick={async () => {
              if (!client || connectionStatus !== "connected") return;
              try {
                addResult("success", "Starting static site setup...");
                const result = await client.setupStatic();
                addResult(
                  "success",
                  `${result.message} Preview: ${result.previewUrl}`
                );
              } catch (error: any) {
                addResult(
                  "error",
                  `Failed to setup static site: ${error.message}`
                );
              }
            }}
            disabled={connectionStatus !== "connected"}
            className="quick-setup-button static"
          >
            <div className="setup-icon">📄</div>
            <div className="setup-info">
              <div className="setup-title">Static Site</div>
              <div className="setup-description">Simple HTML website</div>
            </div>
          </button>
        </div>
      </div>

      {/* Binary File Support Showcase */}
      <div className="binary-showcase-section">
        <h2>🎨 Binary File Support Demo</h2>
        <p className="section-description">
          Test the new binary file reading capabilities with automatic format detection and metadata extraction.
        </p>

        <div className="operation-group">
          <h3>Step 1: Create Test Binary File</h3>
          <p className="help-text">Generate a PNG chart using matplotlib in the sandbox</p>
          <button
            onClick={handleCreateTestBinary}
            disabled={isCreatingBinary || connectionStatus !== "connected"}
            className="action-button create-binary"
          >
            {isCreatingBinary ? "Creating..." : "🎨 Create Test PNG Chart"}
          </button>
        </div>

        <div className="operation-group">
          <h3>Step 2: Read Binary File with Metadata</h3>
          <div className="input-group">
            <input
              type="text"
              placeholder="Binary file path"
              value={binaryFilePath}
              onChange={(e) => setBinaryFilePath(e.target.value)}
              className="file-input"
            />
            <button
              onClick={handleReadBinaryFile}
              disabled={!binaryFilePath.trim() || isReadingBinary || connectionStatus !== "connected"}
              className="action-button"
            >
              {isReadingBinary ? "Reading..." : "📖 Read & Display"}
            </button>
          </div>
        </div>

        {/* File Metadata Display */}
        {binaryFileMetadata && (
          <div className="binary-metadata-card">
            <h4>📊 File Metadata</h4>
            <div className="metadata-grid">
              <div className="metadata-item">
                <span className="metadata-label">File Type:</span>
                <span className="metadata-value">
                  {binaryFileMetadata.isBinary ? "🖼️" : "📄"} {binaryFileMetadata.mimeType}
                </span>
              </div>
              <div className="metadata-item">
                <span className="metadata-label">Size:</span>
                <span className="metadata-value">
                  {(binaryFileMetadata.size / 1024).toFixed(2)} KB
                </span>
              </div>
              <div className="metadata-item">
                <span className="metadata-label">Encoding:</span>
                <span className="metadata-value metadata-encoding">
                  {binaryFileMetadata.encoding}
                </span>
              </div>
              <div className="metadata-item">
                <span className="metadata-label">Binary:</span>
                <span className={`metadata-value ${binaryFileMetadata.isBinary ? "binary-yes" : "binary-no"}`}>
                  {binaryFileMetadata.isBinary ? "✓ Yes" : "✗ No"}
                </span>
              </div>
            </div>

            {/* File Preview */}
            <div className="file-preview">
              <h4>🔍 Preview</h4>
              {binaryFileMetadata.isBinary && binaryFileMetadata.mimeType.startsWith("image/") ? (
                <div className="image-preview">
                  <img
                    src={`data:${binaryFileMetadata.mimeType};base64,${binaryFileMetadata.content}`}
                    alt="Binary file preview"
                    className="preview-image"
                  />
                  <p className="preview-caption">
                    ✅ Binary file successfully read and decoded from base64!
                  </p>
                </div>
              ) : binaryFileMetadata.isBinary ? (
                <div className="binary-preview">
                  <p className="binary-info">
                    📦 Binary file ({binaryFileMetadata.mimeType})
                  </p>
                  <pre className="base64-preview">
                    {binaryFileMetadata.content?.substring(0, 200)}...
                  </pre>
                  <p className="preview-caption">
                    Base64 encoded content (first 200 chars shown)
                  </p>
                </div>
              ) : (
                <div className="text-preview">
                  <pre className="code-block">
                    {binaryFileMetadata.content}
                  </pre>
                  <p className="preview-caption">Text file content</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Results */}
      <div className="results-section">
        <h3>Operation Results</h3>
        <div className="results-container">
          {results.map((result, index) => (
            <div key={index} className={`result-item ${result.type}`}>
              <span className="timestamp">
                {result.timestamp.toLocaleTimeString()}
              </span>
              <span className={`status ${result.type}`}>
                {result.type === "success" ? "✓" : "✗"}
              </span>
              <span className="message">{result.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StreamingTab({
  client,
  connectionStatus,
  sessionId,
}: {
  client: SandboxApiClient | null;
  connectionStatus: "disconnected" | "connecting" | "connected";
  sessionId: string | null;
}) {
  const [activeStreams, setActiveStreams] = useState<ActiveStream[]>([]);
  const [commandInput, setCommandInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);

  // Refresh processes for log streaming
  useEffect(() => {
    const refreshProcesses = async () => {
      if (!client || connectionStatus !== "connected") return;

      try {
        const response = await client.listProcesses();
        setProcesses(response.processes);
      } catch (error) {
        console.error("Failed to refresh processes:", error);
      }
    };

    if (connectionStatus === "connected") {
      refreshProcesses();
      const interval = setInterval(refreshProcesses, 3000);
      return () => clearInterval(interval);
    }
  }, [client, connectionStatus]);

  // Start command streaming using execStream (AsyncIterable)
  const startCommandStream = async () => {
    if (
      !client ||
      connectionStatus !== "connected" ||
      !commandInput.trim() ||
      isStreaming
    )
      return;

    const streamId = `cmd_${Date.now()}`;
    const command = commandInput.trim();

    setIsStreaming(true);
    setCommandInput("");

    // Add stream to active streams
    const newStream: ActiveStream = {
      id: streamId,
      type: "command",
      title: `Command: ${command}`,
      command: command,
      isActive: true,
      events: [],
      startTime: new Date(),
    };

    setActiveStreams((prev) => [...prev, newStream]);

    try {
      // Use the new execStream AsyncIterable method
      const commandParts = command.split(" ");
      const cmd = commandParts[0];
      const args = commandParts.slice(1);
      const streamIterable = client.execStream(cmd, args, {
        sessionId: sessionId || undefined,
        signal: new AbortController().signal,
      });

      for await (const event of streamIterable) {
        const streamEvent: StreamEvent = {
          id: `${streamId}_${Date.now()}_${Math.random()}`,
          type: event.type as
            | "start"
            | "stdout"
            | "stderr"
            | "complete"
            | "error",
          timestamp: event.timestamp,
          data: event.data,
          command: event.command,
          exitCode: event.exitCode,
          error: event.error,
        };

        setActiveStreams((prev) =>
          prev.map((stream) =>
            stream.id === streamId
              ? {
                  ...stream,
                  events: [...stream.events, streamEvent],
                  isActive: event.type !== "complete" && event.type !== "error",
                }
              : stream
          )
        );

        // Break on completion or error
        if (event.type === "complete" || event.type === "error") {
          break;
        }
      }
    } catch (error) {
      console.error("Streaming error:", error);

      const errorEvent: StreamEvent = {
        id: `${streamId}_error_${Date.now()}`,
        type: "error",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error : new Error(String(error)),
      };

      setActiveStreams((prev) =>
        prev.map((stream) =>
          stream.id === streamId
            ? {
                ...stream,
                events: [...stream.events, errorEvent],
                isActive: false,
              }
            : stream
        )
      );
    } finally {
      setIsStreaming(false);
    }
  };

  // Start process log streaming using streamProcessLogs (AsyncIterable)
  const startProcessLogStream = async (selectedProcessId: string) => {
    if (
      !client ||
      connectionStatus !== "connected" ||
      !selectedProcessId.trim()
    )
      return;

    const streamId = `logs_${selectedProcessId}_${Date.now()}`;
    
    // Create an AbortController for this stream
    const abortController = new AbortController();
    
    // Store the abort controller so it can be aborted when user clicks stop
    streamAbortControllers.current.set(streamId, abortController);

    // Add stream to active streams
    const newStream: ActiveStream = {
      id: streamId,
      type: "process-logs",
      title: `Process Logs: ${selectedProcessId}`,
      processId: selectedProcessId,
      isActive: true,
      events: [],
      startTime: new Date(),
    };

    setActiveStreams((prev) => [...prev, newStream]);

    try {
      // Use the new streamProcessLogs AsyncIterable method with abort signal
      const logStreamIterable = client.streamProcessLogs(selectedProcessId, {
        signal: abortController.signal
      });

      for await (const logEvent of logStreamIterable) {
        const streamEvent: LogStreamEvent = {
          id: `${streamId}_${Date.now()}_${Math.random()}`,
          type: logEvent.type as "stdout" | "stderr" | "status" | "error",
          timestamp: logEvent.timestamp,
          data: logEvent.data,
          processId: logEvent.processId,
          sessionId: logEvent.sessionId,
        };

        setActiveStreams((prev) =>
          prev.map((stream) =>
            stream.id === streamId
              ? { ...stream, events: [...stream.events, streamEvent] }
              : stream
          )
        );
      }
      
      // Clean up abort controller when stream completes naturally
      streamAbortControllers.current.delete(streamId);
    } catch (error) {
      // Clean up abort controller on error
      streamAbortControllers.current.delete(streamId);
      
      // Don't log abort errors or add error events for user cancellation
      if (error instanceof Error && error.name === 'AbortError') {
        console.log("Log streaming aborted by user");
        // Just mark the stream as inactive without adding error event
        setActiveStreams((prev) =>
          prev.map((stream) =>
            stream.id === streamId
              ? { ...stream, isActive: false }
              : stream
          )
        );
        return;
      }
      
      console.error("Log streaming error:", error);

      const errorEvent: LogStreamEvent = {
        id: `${streamId}_error_${Date.now()}`,
        type: "error",
        timestamp: new Date().toISOString(),
        data: `Error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        processId: selectedProcessId,
      };

      setActiveStreams((prev) =>
        prev.map((stream) =>
          stream.id === streamId
            ? {
                ...stream,
                events: [...stream.events, errorEvent],
                isActive: false,
              }
            : stream
        )
      );
    }
  };

  // Map to store abort controllers for active streams
  const streamAbortControllers = useRef<Map<string, AbortController>>(new Map());
  
  // Stop a stream
  const stopStream = (streamId: string) => {
    setActiveStreams((prev) =>
      prev.map((stream) =>
        stream.id === streamId ? { ...stream, isActive: false } : stream
      )
    );
    
    // Abort the fetch if an abort controller exists
    const controller = streamAbortControllers.current.get(streamId);
    if (controller) {
      controller.abort();
      streamAbortControllers.current.delete(streamId);
    }
  };

  // Clear a stream
  const clearStream = (streamId: string) => {
    setActiveStreams((prev) => prev.filter((stream) => stream.id !== streamId));
  };

  // Clear all streams
  const clearAllStreams = () => {
    setActiveStreams([]);
  };

  // Get event color
  const getEventColor = (type: string) => {
    switch (type) {
      case "start":
        return "text-blue-500";
      case "stdout":
        return "text-green-500";
      case "stderr":
        return "text-red-500";
      case "complete":
        return "text-green-500";
      case "error":
        return "text-red-500";
      case "status":
        return "text-yellow-500";
      default:
        return "text-gray-500";
    }
  };

  return (
    <div className="streaming-tab">
      <div className="streaming-header">
        <h2>Advanced AsyncIterable Streaming</h2>
        <div className="stream-controls">
          <button
            onClick={clearAllStreams}
            disabled={activeStreams.length === 0}
            className="btn btn-danger"
          >
            Clear All
          </button>
        </div>
      </div>

      {/* Command Streaming */}
      <div className="command-streaming">
        <h3>Command Streaming (execStream)</h3>
        <p className="section-description">
          Test the new <code>execStream()</code> AsyncIterable method for
          real-time command output.
        </p>

        <div className="stream-form">
          <div className="form-row">
            <input
              type="text"
              placeholder="Command to stream (e.g., ping google.com, tail -f /var/log/messages)"
              value={commandInput}
              onChange={(e) => setCommandInput(e.target.value)}
              className="stream-input"
              onKeyPress={(e) => {
                if (e.key === "Enter") {
                  startCommandStream();
                }
              }}
            />
            <button
              onClick={startCommandStream}
              disabled={
                !commandInput.trim() ||
                isStreaming ||
                connectionStatus !== "connected"
              }
              className="btn btn-stream-start"
            >
              {isStreaming ? "Starting..." : "Start Stream"}
            </button>
          </div>
        </div>

        {/* Quick Command Templates */}
        <div className="stream-templates">
          <h4>Quick Stream Commands:</h4>
          <div className="template-buttons">
            <button
              onClick={() => setCommandInput("ping -c 10 google.com")}
              className="btn btn-template"
            >
              📡 Ping Test
            </button>
            <button
              onClick={() =>
                setCommandInput("find / -name '*.txt' 2>/dev/null | head -20")
              }
              className="btn btn-template"
            >
              🔍 File Search
            </button>
            <button
              onClick={() => setCommandInput("ps aux")}
              className="btn btn-template"
            >
              📊 Process List
            </button>
          </div>
        </div>
      </div>

      {/* Process Log Streaming */}
      <div className="log-streaming">
        <h3>Process Log Streaming (streamProcessLogs)</h3>
        <p className="section-description">
          Test the new <code>streamProcessLogs()</code> AsyncIterable method for
          real-time process log monitoring.
        </p>

        {processes.length === 0 ? (
          <div className="no-processes-message">
            No background processes running. Start some processes in the
            "Processes" tab first!
          </div>
        ) : (
          <div className="process-selector">
            <h4>Select Process to Stream:</h4>
            <div className="process-buttons">
              {processes
                .filter((p) => p.status === "running")
                .map((process) => (
                  <button
                    key={process.id}
                    onClick={() => startProcessLogStream(process.id)}
                    className="btn btn-template"
                    disabled={activeStreams.some(
                      (s) => s.processId === process.id
                    )}
                  >
                    📋 {process.id} ({process.command})
                    {activeStreams.some((s) => s.processId === process.id) &&
                      " ✅"}
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>

      {/* Active Streams */}
      <div className="active-streams">
        <h3>Active Streams ({activeStreams.length})</h3>

        {activeStreams.length === 0 ? (
          <div className="no-streams">
            No active streams. Start a command stream or process log stream
            above!
          </div>
        ) : (
          <div className="streams-grid">
            {activeStreams.map((stream) => (
              <div key={stream.id} className="stream-card">
                <div className="stream-header">
                  <div className="stream-info">
                    <div className="stream-title">{stream.title}</div>
                    <div className="stream-meta">
                      {stream.isActive ? (
                        <span className="status-active">🟢 Active</span>
                      ) : (
                        <span className="status-inactive">🔴 Stopped</span>
                      )}
                      <span className="stream-time">
                        Started: {stream.startTime.toLocaleTimeString()}
                      </span>
                      <span className="event-count">
                        Events: {stream.events.length}
                      </span>
                    </div>
                  </div>

                  <div className="stream-controls">
                    {stream.isActive && (
                      <button
                        onClick={() => stopStream(stream.id)}
                        className="btn btn-small btn-stop"
                      >
                        Stop
                      </button>
                    )}
                    <button
                      onClick={() => clearStream(stream.id)}
                      className="btn btn-small btn-clear"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div className="stream-events">
                  {stream.events.length === 0 ? (
                    <div className="no-events">Waiting for events...</div>
                  ) : (
                    <div className="events-list">
                      {stream.events.slice(-50).map((event) => (
                        <div key={event.id} className="stream-event">
                          <div className="event-header">
                            <span
                              className={`event-type ${getEventColor(
                                event.type
                              )}`}
                            >
                              {event.type.toUpperCase()}
                            </span>
                            <span className="event-timestamp">
                              {new Date(event.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          {event.data && (
                            <div className="event-data">
                              <pre>{event.data}</pre>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Information */}
      <div className="streaming-info">
        <h3>🚀 Streaming Features</h3>
        <ul>
          <li>
            <strong>AsyncIterable Pattern:</strong> Uses modern JavaScript async
            iterators for clean streaming
          </li>
          <li>
            <strong>Multiple Streams:</strong> Monitor multiple commands and
            process logs simultaneously
          </li>
          <li>
            <strong>Real-time Updates:</strong> Events appear immediately as
            they happen
          </li>
          <li>
            <strong>Event Filtering:</strong> Different colors and types for
            stdout, stderr, status, etc.
          </li>
          <li>
            <strong>Stream Management:</strong> Start, stop, and clear
            individual or all streams
          </li>
        </ul>
      </div>
    </div>
  );
}

interface NotebookCell {
  id: string;
  code: string;
  output: any[];
  status: "idle" | "running" | "completed" | "error";
  executionCount: number;
}

function NotebookTab({
  client,
  connectionStatus,
}: {
  client: SandboxApiClient | null;
  connectionStatus: "disconnected" | "connecting" | "connected";
}) {
  const [cells, setCells] = useState<NotebookCell[]>([]);
  const [notebookSessionId, setNotebookSessionId] = useState<string | null>(
    null
  );
  const [language, setLanguage] = useState<"python" | "javascript">("python");
  const [activeCell, setActiveCell] = useState<string | null>(null);
  const cellRefs = useRef<{ [key: string]: HTMLTextAreaElement | null }>({});

  // Initialize notebook session
  useEffect(() => {
    const initSession = async () => {
      if (!client || connectionStatus !== "connected") return;

      try {
        const session = await client.createNotebookSession(language);
        setNotebookSessionId(session.sessionId);
        // Add first cell automatically
        addCell();
      } catch (error) {
        console.error("Failed to create notebook session:", error);
      }
    };

    if (connectionStatus === "connected") {
      initSession();
    }

    return () => {
      if (notebookSessionId && client) {
        client.deleteNotebookSession(notebookSessionId);
      }
    };
  }, [client, connectionStatus, language]);

  const addCell = () => {
    const newCell: NotebookCell = {
      id: `cell-${Date.now()}`,
      code: "",
      output: [],
      status: "idle",
      executionCount: 0,
    };
    setCells((prev) => [...prev, newCell]);

    // Focus new cell after render
    setTimeout(() => {
      const textarea = cellRefs.current[newCell.id];
      if (textarea) {
        textarea.focus();
      }
    }, 100);
  };

  const deleteCell = (cellId: string) => {
    setCells((prev) => prev.filter((cell) => cell.id !== cellId));
  };

  const updateCellCode = (cellId: string, code: string) => {
    setCells((prev) =>
      prev.map((cell) => (cell.id === cellId ? { ...cell, code } : cell))
    );
  };

  const runCell = async (cellId: string, runAndAddNew: boolean = false) => {
    if (!client || !notebookSessionId || connectionStatus !== "connected")
      return;

    const cell = cells.find((c) => c.id === cellId);
    if (!cell || !cell.code.trim()) return;

    // Update cell status
    setCells((prev) =>
      prev.map((c) =>
        c.id === cellId
          ? {
              ...c,
              status: "running",
              output: [],
              executionCount: c.executionCount + 1,
            }
          : c
      )
    );

    try {
      const outputs: any[] = [];

      // Execute cell and collect outputs
      for await (const event of client.executeNotebookCell(
        cell.code,
        notebookSessionId,
        language
      )) {
        switch (event.type) {
          case "stdout":
            outputs.push({ type: "stdout", text: event.text });
            break;
          case "stderr":
            outputs.push({ type: "stderr", text: event.text });
            break;
          case "result":
            outputs.push({
              type: "result",
              data: event,
              png: event.png,
              html: event.html,
              text: event.text,
              json: event.json,
            });
            break;
          case "error":
            outputs.push({
              type: "error",
              ename: event.ename,
              evalue: event.evalue,
              traceback: event.traceback,
            });
            break;
        }

        // Update output in real-time
        setCells((prev) =>
          prev.map((c) =>
            c.id === cellId ? { ...c, output: [...outputs] } : c
          )
        );
      }

      // Mark as completed
      setCells((prev) =>
        prev.map((c) => (c.id === cellId ? { ...c, status: "completed" } : c))
      );

      if (runAndAddNew) {
        addCell();
      }
    } catch (error) {
      console.error("Cell execution error:", error);
      setCells((prev) =>
        prev.map((c) =>
          c.id === cellId
            ? {
                ...c,
                status: "error",
                output: [
                  ...c.output,
                  {
                    type: "error",
                    text: `Execution error: ${error}`,
                  },
                ],
              }
            : c
        )
      );
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, cellId: string) => {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      runCell(cellId);
    } else if (e.shiftKey && e.key === "Enter") {
      e.preventDefault();
      runCell(cellId, true);
    }
  };

  const renderOutput = (output: any) => {
    switch (output.type) {
      case "stdout":
        return <pre className="notebook-stdout">{output.text}</pre>;

      case "stderr":
        return <pre className="notebook-stderr">{output.text}</pre>;

      case "error":
        return (
          <div className="notebook-error">
            <div className="error-name">
              {output.ename}: {output.evalue}
            </div>
            {output.traceback && (
              <pre className="error-traceback">
                {output.traceback.join("\n")}
              </pre>
            )}
          </div>
        );

      case "result":
        if (output.png) {
          return (
            <img
              src={`data:image/png;base64,${output.png}`}
              alt="Plot"
              className="notebook-image"
            />
          );
        }
        if (output.html) {
          return (
            <div
              dangerouslySetInnerHTML={{ __html: output.html }}
              className="notebook-html"
            />
          );
        }
        if (output.json) {
          return (
            <pre className="notebook-json">
              {JSON.stringify(output.json, null, 2)}
            </pre>
          );
        }
        if (output.text) {
          return <pre className="notebook-text">{output.text}</pre>;
        }
        return null;

      default:
        return null;
    }
  };

  const loadExample = (type: "plot" | "data" | "js") => {
    const examples = {
      plot: {
        lang: "python" as const,
        code: `# Create a beautiful visualization
import matplotlib.pyplot as plt
import numpy as np

# Generate data
x = np.linspace(0, 10, 100)
y1 = np.sin(x)
y2 = np.cos(x)

# Create figure
plt.figure(figsize=(10, 6))
plt.plot(x, y1, 'b-', label='sin(x)', linewidth=2)
plt.plot(x, y2, 'r--', label='cos(x)', linewidth=2)
plt.fill_between(x, y1, y2, alpha=0.2)

plt.title('Trigonometric Functions', fontsize=16)
plt.xlabel('x', fontsize=12)
plt.ylabel('y', fontsize=12)
plt.legend(loc='upper right')
plt.grid(True, alpha=0.3)
plt.show()`,
      },
      data: {
        lang: "python" as const,
        code: `# Data analysis with pandas
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt

# Create sample data
np.random.seed(42)
data = {
    'Date': pd.date_range('2024-01-01', periods=30),
    'Sales': np.random.randint(100, 500, 30),
    'Customers': np.random.randint(20, 100, 30)
}

df = pd.DataFrame(data)
df['Revenue'] = df['Sales'] * np.random.uniform(10, 20, 30)

print("Sales Data Summary:")
print(df.describe())

# Create visualization
fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(10, 8))

# Sales over time
ax1.plot(df['Date'], df['Sales'], 'b-', linewidth=2)
ax1.set_title('Daily Sales')
ax1.set_ylabel('Sales')
ax1.grid(True, alpha=0.3)

# Revenue distribution
ax2.hist(df['Revenue'], bins=15, color='green', alpha=0.7, edgecolor='black')
ax2.set_title('Revenue Distribution')
ax2.set_xlabel('Revenue')
ax2.set_ylabel('Frequency')

plt.tight_layout()
plt.show()

# Show data table
df.head()`,
      },
      js: {
        lang: "javascript" as const,
        code: `// JavaScript example with console output
console.log("Hello from JavaScript!");

// Generate fibonacci sequence
function fibonacci(n) {
    const sequence = [0, 1];
    for (let i = 2; i < n; i++) {
        sequence[i] = sequence[i-1] + sequence[i-2];
    }
    return sequence;
}

const fib = fibonacci(10);
console.log("Fibonacci sequence:", fib);

// Create a simple data structure
const data = {
    name: "Code Interpreter Demo",
    features: ["Multi-language", "Rich outputs", "Persistent contexts"],
    stats: {
        languages: 2,
        performance: "Edge-optimized",
        latency: "<50ms"
    }
};

console.log("\\nDemo Info:");
console.log(JSON.stringify(data, null, 2));

// Return a result
{ fibonacci: fib, info: data }`,
      },
    };

    const example = examples[type];

    // Change language if needed
    if (example.lang !== language) {
      setLanguage(example.lang);
    }

    // Add cell with example code
    const newCell: NotebookCell = {
      id: `cell-${Date.now()}`,
      code: example.code,
      output: [],
      status: "idle",
      executionCount: 0,
    };
    setCells((prev) => [...prev, newCell]);
  };

  return (
    <div className="notebook-tab">
      <div className="notebook-header">
        <h2>📓 Interactive Notebook</h2>
        <div className="notebook-controls">
          <select
            value={language}
            onChange={(e) =>
              setLanguage(e.target.value as "python" | "javascript")
            }
            className="language-selector"
          >
            <option value="python">Python</option>
            <option value="javascript">JavaScript</option>
          </select>
          <button onClick={addCell} className="btn btn-primary">
            + Add Cell
          </button>
        </div>
      </div>

      <div className="example-buttons">
        <button onClick={() => loadExample("plot")} className="btn btn-example">
          📊 Plot Example
        </button>
        <button onClick={() => loadExample("data")} className="btn btn-example">
          📈 Data Analysis
        </button>
        <button onClick={() => loadExample("js")} className="btn btn-example">
          🟨 JavaScript
        </button>
      </div>

      <div className="notebook-cells">
        {cells.length === 0 ? (
          <div className="notebook-welcome">
            <h3>Welcome to Cloudflare Notebook</h3>
            <p>
              Click "Add Cell" to start coding, or try one of the examples
              above!
            </p>
            <div className="shortcuts-info">
              <h4>Keyboard Shortcuts:</h4>
              <div>
                <kbd>Ctrl</kbd>+<kbd>Enter</kbd> Run cell
              </div>
              <div>
                <kbd>Shift</kbd>+<kbd>Enter</kbd> Run cell and add new
              </div>
            </div>
          </div>
        ) : (
          cells.map((cell, index) => (
            <div
              key={cell.id}
              className={`notebook-cell ${cell.status} ${
                activeCell === cell.id ? "active" : ""
              }`}
            >
              <div className="cell-header">
                <span className="cell-number">[{index + 1}]</span>
                <div className="cell-actions">
                  <button
                    onClick={() => runCell(cell.id)}
                    disabled={!cell.code.trim() || cell.status === "running"}
                    className="btn btn-run"
                  >
                    {cell.status === "running" ? "⏳" : "▶"} Run
                  </button>
                  <button
                    onClick={() => deleteCell(cell.id)}
                    className="btn btn-delete"
                  >
                    🗑️
                  </button>
                </div>
              </div>

              <div className="cell-editor">
                <textarea
                  ref={(el) => {
                    cellRefs.current[cell.id] = el;
                  }}
                  value={cell.code}
                  onChange={(e) => updateCellCode(cell.id, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(e, cell.id)}
                  onFocus={() => setActiveCell(cell.id)}
                  onBlur={() => setActiveCell(null)}
                  placeholder={`Enter ${language} code...`}
                  className="cell-input"
                  spellCheck={false}
                />
              </div>

              {cell.output.length > 0 && (
                <div className="cell-output">
                  {cell.executionCount > 0 && (
                    <span className="execution-count">
                      [{cell.executionCount}]
                    </span>
                  )}
                  <div className="output-content">
                    {cell.output.map((output, idx) => (
                      <div key={idx} className="output-item">
                        {renderOutput(output)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ExamplesTab({
  client,
  connectionStatus,
}: {
  client: SandboxApiClient | null;
  connectionStatus: "disconnected" | "connecting" | "connected";
}) {
  const [results, setResults] = useState<{ [key: string]: any }>({});
  const [loading, setLoading] = useState<{ [key: string]: boolean }>({});
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    // Create a session for the examples
    const initSession = async () => {
      if (client && connectionStatus === "connected") {
        try {
          const response = await fetch("/api/notebook/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ language: "python" }),
          });
          const data: { sessionId: string; language: string } =
            await response.json();
          setSessionId(data.sessionId);
        } catch (error) {
          console.error("Failed to create session:", error);
        }
      }
    };
    initSession();
  }, [client, connectionStatus]);

  const runExample = async (exampleName: string, endpoint: string) => {
    if (!client || connectionStatus !== "connected") return;

    setLoading((prev) => ({ ...prev, [exampleName]: true }));

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
      const data = await response.json();
      setResults((prev) => ({ ...prev, [exampleName]: data }));
    } catch (error: any) {
      setResults((prev) => ({
        ...prev,
        [exampleName]: { error: error.message },
      }));
    } finally {
      setLoading((prev) => ({ ...prev, [exampleName]: false }));
    }
  };

  // Convert the imported examples to an array
  const examples = Object.values(codeExamples);

  return (
    <div className="examples-tab">
      <div className="examples-header">
        <h2>Code Interpreter Examples</h2>
        <p className="examples-description">
          Try these examples to see the code interpreter in action. Each example
          demonstrates different features.
        </p>
      </div>

      <div className="examples-grid">
        {examples.map((example) => (
          <div key={example.name} className="example-card">
            <h3>{example.title}</h3>
            <p className="example-description">{example.description}</p>

            <div className="example-code">
              <pre>{example.code}</pre>
            </div>

            <button
              className="btn btn-primary"
              onClick={() => runExample(example.name, example.endpoint)}
              disabled={
                loading[example.name] || connectionStatus !== "connected"
              }
            >
              {loading[example.name] ? "Running..." : "Run Example"}
            </button>

            {results[example.name] && (
              <div className="example-result">
                <h4>Result:</h4>

                {results[example.name].error ? (
                  <div className="error-output">
                    {typeof results[example.name].error === "string" ? (
                      <>
                        <strong>Error:</strong> {results[example.name].error}
                      </>
                    ) : results[example.name].error.name ? (
                      <>
                        <strong>
                          Error: {results[example.name].error.name}
                        </strong>
                        <p>{results[example.name].error.message}</p>
                        {results[example.name].error.traceback && (
                          <pre className="traceback">
                            {results[example.name].error.traceback.join("\n")}
                          </pre>
                        )}
                      </>
                    ) : (
                      <>
                        <strong>Error:</strong>{" "}
                        {JSON.stringify(results[example.name].error)}
                      </>
                    )}
                  </div>
                ) : (
                  <>
                    {/* Standard output */}
                    {results[example.name].stdout && (
                      <div className="output-section">
                        <strong className="output-label">Output (stdout):</strong>
                        <pre className="output-content">{results[example.name].stdout}</pre>
                      </div>
                    )}

                    {/* Standard error */}
                    {results[example.name].stderr && results[example.name].stderr.trim() && (
                      <div className="output-section">
                        <strong className="output-label" style={{ color: "#d73a49" }}>Error Output (stderr):</strong>
                        <pre className="output-content" style={{ color: "#d73a49" }}>{results[example.name].stderr}</pre>
                      </div>
                    )}

                    {/* For backwards compatibility with .output field */}
                    {results[example.name].output && !results[example.name].stdout && (
                      <div className="output-section">
                        <strong className="output-label">Output:</strong>
                        <pre className="output-content">{results[example.name].output}</pre>
                      </div>
                    )}

                    {/* HTML content (tables, etc.) */}
                    {results[example.name].html && (
                      <div className="output-section">
                        <strong className="output-label">HTML Output:</strong>
                        <div
                          className="output-content"
                          dangerouslySetInnerHTML={{ __html: results[example.name].html }}
                          style={{ 
                            overflowX: "auto",
                            maxWidth: "100%"
                          }}
                        />
                      </div>
                    )}

                    {/* PNG Chart */}
                    {results[example.name].chart && (
                      <div className="output-section">
                        <strong className="output-label">Chart (PNG):</strong>
                        <div className="output-content image-container">
                          <img
                            src={results[example.name].chart}
                            alt="Generated chart"
                            style={{ maxWidth: "100%", height: "auto", display: "block" }}
                          />
                        </div>
                      </div>
                    )}

                    {/* SVG Graphics */}
                    {results[example.name].svg && (
                      <div className="output-section">
                        <strong className="output-label">SVG Graphics:</strong>
                        <div
                          className="output-content"
                          dangerouslySetInnerHTML={{ __html: results[example.name].svg }}
                          style={{ maxWidth: "100%" }}
                        />
                      </div>
                    )}

                    {/* JSON data */}
                    {results[example.name].json && (
                      <div className="output-section">
                        <strong className="output-label">JSON Data:</strong>
                        <pre className="output-content json-output">
                          {JSON.stringify(
                            results[example.name].json,
                            null,
                            2
                          )}
                        </pre>
                      </div>
                    )}

                    {/* LaTeX formulas */}
                    {results[example.name].latex && (
                      <div className="output-section">
                        <strong className="output-label">LaTeX Formula:</strong>
                        <div className="output-content latex-output">
                          <LaTeXRenderer content={results[example.name].latex} />
                        </div>
                      </div>
                    )}

                    {/* Markdown formatted text */}
                    {results[example.name].markdown && (
                      <div className="output-section">
                        <strong className="output-label">Markdown Output:</strong>
                        <div className="output-content markdown-output">
                          <MarkdownRenderer content={results[example.name].markdown} />
                        </div>
                      </div>
                    )}

                    {/* Plain text (only if no other rich output) */}
                    {results[example.name].text && (
                      <div className="output-section">
                        <strong className="output-label">Text Result:</strong>
                        <pre className="output-content">{results[example.name].text}</pre>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="examples-advanced">
        <h3>Try More Examples</h3>
        <p>These examples just scratch the surface! You can:</p>
        <ul>
          <li>Process data with pandas DataFrames</li>
          <li>Create complex visualizations with multiple subplots</li>
          <li>Share data between Python and JavaScript contexts</li>
          <li>Build interactive data analysis workflows</li>
          <li>Generate reports with rich HTML output</li>
        </ul>
        <p>
          Check out the <strong>Notebook</strong> tab to write and run your own
          code interactively!
        </p>
      </div>
    </div>
  );
}

function SandboxTester() {
  const [activeTab, setActiveTab] = useState<TabType>("commands");
  const [client, setClient] = useState<SandboxApiClient | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [commandInput, setCommandInput] = useState("");
  const [commandOptions, setCommandOptions] = useState({
    cwd: "",
    env: "",
  });
  const [results, setResults] = useState<CommandResult[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const resultsEndRef = useRef<HTMLDivElement>(null);
  const commandInputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom when new results are added
  useEffect(() => {
    if (activeTab === "commands") {
      resultsEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [results, activeTab]);

  // Initialize HTTP client
  useEffect(() => {
    const httpClient = new SandboxApiClient({
      baseUrl: window.location.origin,
      onCommandComplete: (
        success: boolean,
        exitCode: number,
        stdout: string,
        stderr: string,
        command: string
      ) => {
        setResults((prev) => {
          const updated = [...prev];
          const lastResult = updated[updated.length - 1];
          if (lastResult && lastResult.command === command) {
            lastResult.status = success ? "completed" : "error";
            lastResult.exitCode = exitCode;
            lastResult.stdout = stdout;
            lastResult.stderr = stderr;
          }
          return updated;
        });
        setIsExecuting(false);
      },
      onCommandStart: (command: string) => {
        console.log("Command started:", command);
        // Don't create a new result here - executeCommand already does this
        setIsExecuting(true);
      },
      onError: (error: string, command?: string) => {
        console.error("Command error:", error);
        setResults((prev) => {
          const updated = [...prev];
          const lastResult = updated[updated.length - 1];
          if (lastResult && lastResult.command === command) {
            lastResult.status = "error";
            lastResult.stderr += `\nError: ${error}`;
          }
          return updated;
        });
        setIsExecuting(false);
      },
    });

    setClient(httpClient);

    // Initialize connection by creating a session
    const initializeConnection = async () => {
      try {
        setConnectionStatus("connecting");

        // Test connection with ping that actually initializes the sandbox
        let sandboxReady = false;
        let attempts = 0;
        const maxAttempts = 10; // Try for up to 10 seconds

        while (!sandboxReady && attempts < maxAttempts) {
          try {
            const pingResponse = await httpClient.ping();
            console.log("Ping response:", pingResponse);

            if (pingResponse.sandboxStatus === "ready") {
              sandboxReady = true;
              console.log("Sandbox is ready");
            } else {
              console.log("Sandbox still initializing, waiting...");
              await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
              attempts++;
            }
          } catch (error) {
            console.log("Ping failed, retrying...", error);
            await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
            attempts++;
          }
        }

        if (!sandboxReady) {
          throw new Error("Sandbox failed to initialize within timeout");
        }

        // Create a session
        const session = await httpClient.createSession();
        setSessionId(session);
        setConnectionStatus("connected");
        console.log("Connected with session:", session);
      } catch (error: any) {
        console.error("Failed to connect:", error);
        setConnectionStatus("disconnected");
      }
    };

    initializeConnection();

    // Cleanup on unmount
    return () => {
      if (httpClient && sessionId) {
        httpClient.clearSession(sessionId);
      }
    };
  }, []);

  const executeCommand = async () => {
    if (
      !client ||
      connectionStatus !== "connected" ||
      !commandInput.trim() ||
      isExecuting
    ) {
      return;
    }

    const trimmedCommand = commandInput.trim();

    try {
      setIsExecuting(true);

      // Create a result entry for the command
      const newResult: CommandResult = {
        command: trimmedCommand,
        id: `${Date.now()}_${Math.random()}`,
        status: "running",
        stderr: "",
        stdout: "",
        timestamp: new Date(),
      };
      setResults((prev) => [...prev, newResult]);

      // Parse command options
      const options: {
        sessionId?: string;
        cwd?: string;
        env?: Record<string, string>;
      } = {
        sessionId: sessionId || undefined,
      };

      if (commandOptions.cwd.trim()) {
        options.cwd = commandOptions.cwd.trim();
      }

      if (commandOptions.env.trim()) {
        const env: Record<string, string> = {};
        commandOptions.env.split(",").forEach((pair) => {
          const [key, value] = pair.split("=");
          if (key && value) env[key.trim()] = value.trim();
        });
        options.env = env;
      }

      // Execute the command
      console.log(
        "Executing command:",
        trimmedCommand,
        "with options:",
        options
      );
      const result = await client.execute(trimmedCommand, [], options);
      console.log("Result:", result);

      // Update the result with the response
      setResults((prev) => {
        const updated = [...prev];
        const lastResult = updated[updated.length - 1];
        if (lastResult && lastResult.command === trimmedCommand) {
          lastResult.status = result.success ? "completed" : "error";
          lastResult.exitCode = result.exitCode;
          lastResult.stdout = result.stdout;
          lastResult.stderr = result.stderr;
        }
        return updated;
      });

      setCommandInput("");

      // Refocus the input for better UX
      setTimeout(() => {
        commandInputRef.current?.focus();
      }, 0);
    } catch (error: any) {
      console.error("Failed to execute command:", error);
      setResults((prev) => {
        const updated = [...prev];
        const lastResult = updated[updated.length - 1];
        if (lastResult && lastResult.command === trimmedCommand) {
          lastResult.status = "error";
          lastResult.stderr += `\nError: ${error.message || error}`;
        }
        return updated;
      });

      // Refocus the input even on error
      setTimeout(() => {
        commandInputRef.current?.focus();
      }, 100);
    } finally {
      setIsExecuting(false);
    }
  };

  const executeStreamingCommand = async () => {
    if (
      !client ||
      connectionStatus !== "connected" ||
      !commandInput.trim() ||
      isExecuting
    ) {
      return;
    }

    const trimmedCommand = commandInput.trim();

    try {
      setIsExecuting(true);

      // Create a result entry for the command
      const newResult: CommandResult = {
        command: trimmedCommand,
        id: `${Date.now()}_${Math.random()}`,
        status: "running",
        stderr: "",
        stdout: "",
        timestamp: new Date(),
      };
      setResults((prev) => [...prev, newResult]);

      // Parse command options (same as regular execute)
      const options: {
        sessionId?: string;
        cwd?: string;
        env?: Record<string, string>;
      } = {
        sessionId: sessionId || undefined,
      };

      if (commandOptions.cwd.trim()) {
        options.cwd = commandOptions.cwd.trim();
      }

      if (commandOptions.env.trim()) {
        const env: Record<string, string> = {};
        commandOptions.env.split(",").forEach((pair) => {
          const [key, value] = pair.split("=");
          if (key && value) env[key.trim()] = value.trim();
        });
        options.env = env;
      }

      // Execute the command with streaming
      console.log(
        "Executing streaming command:",
        trimmedCommand,
        "with options:",
        options
      );
      await client.executeStream(trimmedCommand, [], options);
      const commandParts = trimmedCommand.split(" ");
      const cmd = commandParts[0];
      const args = commandParts.slice(1);
      // Get the async generator
      const streamGenerator = client.execStream(cmd, args, options);
      // Iterate through the stream events
      for await (const event of streamGenerator) {
        console.log("Stream event:", event);
        // Update the result with streaming data
        setResults((prev) => {
          const updated = [...prev];
          const lastResult = updated[updated.length - 1];
          if (lastResult && lastResult.command === trimmedCommand) {
            if (event.type === "stdout") {
              lastResult.stdout += event.data || "";
            } else if (event.type === "stderr") {
              lastResult.stderr += event.data || "";
            } else if (event.type === "complete") {
              lastResult.status = event.exitCode === 0 ? "completed" : "error";
              lastResult.exitCode = event.exitCode;
            } else if (event.type === "error") {
              lastResult.status = "error";
              lastResult.stderr += `\nError: ${event.data || "Unknown error"}`;
            }
          }
          return updated;
        });
      }
      console.log("Streaming command completed");

      setCommandInput("");

      // Refocus the input for better UX
      setTimeout(() => {
        commandInputRef.current?.focus();
      }, 0);
    } catch (error: any) {
      console.error("Failed to execute streaming command:", error);
      setResults((prev) => {
        const updated = [...prev];
        const lastResult = updated[updated.length - 1];
        if (lastResult && lastResult.command === trimmedCommand) {
          lastResult.status = "error";
          lastResult.stderr += `\nError: ${error.message || error}`;
        }
        return updated;
      });

      // Refocus the input even on error
      setTimeout(() => {
        commandInputRef.current?.focus();
      }, 100);
    } finally {
      setIsExecuting(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      executeCommand();
    }
  };

  const clearResults = () => {
    setResults([]);
  };

  const getStatusColor = (status: CommandResult["status"]) => {
    switch (status) {
      case "running":
        return "text-blue-500";
      case "completed":
        return "text-green-500";
      case "error":
        return "text-red-500";
      default:
        return "text-gray-500";
    }
  };

  const getStatusIcon = (status: CommandResult["status"]) => {
    switch (status) {
      case "running":
        return "⏳";
      case "completed":
        return "✅";
      case "error":
        return "❌";
      default:
        return "⏳";
    }
  };

  return (
    <div className="sandbox-tester-container">
      <div className="header">
        <h1>Cloudflare Sandbox Notebook</h1>
        <div className={`connection-status ${connectionStatus}`}>
          {connectionStatus === "connected"
            ? `Ready`
            : connectionStatus === "connecting"
            ? "Initializing..."
            : "Disconnected"}
        </div>
      </div>

      <div className="tab-navigation">
        <button
          className={`tab-button ${activeTab === "commands" ? "active" : ""}`}
          onClick={() => setActiveTab("commands")}
        >
          📟 Commands
        </button>
        <button
          className={`tab-button ${activeTab === "processes" ? "active" : ""}`}
          onClick={() => setActiveTab("processes")}
        >
          ⚙️ Processes
        </button>
        <button
          className={`tab-button ${activeTab === "ports" ? "active" : ""}`}
          onClick={() => setActiveTab("ports")}
        >
          🌐 Ports
        </button>
        <button
          className={`tab-button ${activeTab === "streaming" ? "active" : ""}`}
          onClick={() => setActiveTab("streaming")}
        >
          📡 Streaming
        </button>
        <button
          className={`tab-button ${activeTab === "files" ? "active" : ""}`}
          onClick={() => setActiveTab("files")}
        >
          📁 Files
        </button>
        <button
          className={`tab-button ${activeTab === "notebook" ? "active" : ""}`}
          onClick={() => setActiveTab("notebook")}
        >
          📓 Notebook
        </button>
        <button
          className={`tab-button ${activeTab === "examples" ? "active" : ""}`}
          onClick={() => setActiveTab("examples")}
        >
          🧪 Examples
        </button>
      </div>

      <div className="tab-content-area">
        {activeTab === "commands" && (
          <div className="commands-tab">
            <div className="command-bar">
              <span className="command-prompt">$</span>
              <input
                ref={commandInputRef}
                type="text"
                className="command-input"
                value={commandInput}
                onChange={(e) => setCommandInput(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Enter command (e.g., ls -la)"
                disabled={isExecuting}
              />
              <div className="action-buttons">
                <button
                  type="button"
                  onClick={executeCommand}
                  disabled={!commandInput.trim() || isExecuting}
                  className="btn btn-execute"
                >
                  {isExecuting ? "Executing..." : "Execute"}
                </button>
                <button
                  type="button"
                  onClick={executeStreamingCommand}
                  disabled={
                    connectionStatus !== "connected" ||
                    !commandInput.trim() ||
                    isExecuting
                  }
                  className="btn btn-stream"
                  title="Execute with real-time streaming output"
                >
                  {isExecuting ? "Streaming..." : "Stream"}
                </button>
                <button type="button" onClick={clearResults} className="btn">
                  Clear
                </button>
              </div>
            </div>

            {/* Command Options */}
            <div className="command-options">
              <div className="option-group">
                <input
                  type="text"
                  placeholder="Working Directory (optional)"
                  value={commandOptions.cwd}
                  onChange={(e) =>
                    setCommandOptions((prev) => ({
                      ...prev,
                      cwd: e.target.value,
                    }))
                  }
                  className="option-input"
                  disabled={isExecuting}
                />
                <input
                  type="text"
                  placeholder="Environment (KEY1=val1,KEY2=val2)"
                  value={commandOptions.env}
                  onChange={(e) =>
                    setCommandOptions((prev) => ({
                      ...prev,
                      env: e.target.value,
                    }))
                  }
                  className="option-input"
                  disabled={isExecuting}
                />
              </div>
            </div>

            <div className="results-container" ref={resultsEndRef}>
              {results.length === 0 ? (
                <div
                  style={{
                    color: "#8b949e",
                    padding: "2rem",
                    textAlign: "center",
                  }}
                >
                  No commands executed yet. Try running a command above.
                </div>
              ) : (
                <div>
                  {results.map((result) => (
                    <div key={result.id} className="command-result">
                      <div className="result-header">
                        <span className="status-icon">
                          {getStatusIcon(result.status)}
                        </span>
                        <div className="command-line">
                          $ <span>{result.command}</span>
                        </div>
                        {result.status !== "running" &&
                          result.exitCode !== undefined && (
                            <span className="exit-code">
                              (exit: {result.exitCode})
                            </span>
                          )}
                        <span className="timestamp">
                          {result.timestamp.toLocaleTimeString()}
                        </span>
                      </div>

                      {result.stdout && (
                        <div className="stdout-output">
                          <pre>{result.stdout}</pre>
                        </div>
                      )}

                      {result.stderr && (
                        <div className="stderr-output">
                          <pre>{result.stderr}</pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="help-section">
              <h3>Example Commands</h3>
              <div className="help-grid">
                <div className="help-item">
                  <span className="help-command">ls</span> - List files
                </div>
                <div className="help-item">
                  <span className="help-command">pwd</span> - Print working
                  directory
                </div>
                <div className="help-item">
                  <span className="help-command">echo</span> - Print text
                </div>
                <div className="help-item">
                  <span className="help-command">cat</span> - Display file
                  contents
                </div>
                <div className="help-item">
                  <span className="help-command">whoami</span> - Show current
                  user
                </div>
                <div className="help-item">
                  <span className="help-command">date</span> - Show current
                  date/time
                </div>
              </div>
              <div className="help-note">
                <strong>Note:</strong> Use the "Stream" button for commands that
                produce real-time output (like <code>top</code> or{" "}
                <code>tail -f</code>).
              </div>
            </div>
          </div>
        )}

        {activeTab === "processes" && (
          <ProcessManagementTab
            client={client}
            connectionStatus={connectionStatus}
            sessionId={sessionId}
          />
        )}

        {activeTab === "ports" && (
          <PortManagementTab
            client={client}
            connectionStatus={connectionStatus}
            sessionId={sessionId}
          />
        )}

        {activeTab === "streaming" && (
          <StreamingTab
            client={client}
            connectionStatus={connectionStatus}
            sessionId={sessionId}
          />
        )}

        {activeTab === "files" && (
          <FilesTab client={client} connectionStatus={connectionStatus} />
        )}

        {activeTab === "notebook" && (
          <NotebookTab client={client} connectionStatus={connectionStatus} />
        )}
        {activeTab === "examples" && (
          <ExamplesTab client={client} connectionStatus={connectionStatus} />
        )}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<SandboxTester />);
