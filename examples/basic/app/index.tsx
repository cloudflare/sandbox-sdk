import type React from "react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

// Simple API client to replace direct HttpClient usage
class SandboxApiClient {
  private baseUrl: string;
  private onCommandComplete?: (success: boolean, exitCode: number, stdout: string, stderr: string, command: string) => void;
  private onCommandStart?: (command: string) => void;
  private onError?: (error: string, command?: string) => void;

  constructor(options: {
    baseUrl?: string;
    onCommandComplete?: (success: boolean, exitCode: number, stdout: string, stderr: string, command: string) => void;
    onCommandStart?: (command: string) => void;
    onError?: (error: string, command?: string) => void;
  } = {}) {
    this.baseUrl = options.baseUrl || window.location.origin;
    this.onCommandComplete = options.onCommandComplete;
    this.onCommandStart = options.onCommandStart;
    this.onError = options.onError;
  }

  private async doFetch(url: string, options: RequestInit): Promise<any> {
    const response = await fetch(`${this.baseUrl}${url}`, {
      headers: {
        'Content-Type': 'application/json',
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
      const result = await this.doFetch('/api/execute', {
        method: 'POST',
        body: JSON.stringify({
          command: `${command} ${args.join(' ')}`,
          ...options,
        }),
      });

      if (this.onCommandComplete) {
        this.onCommandComplete(result.success, result.exitCode, result.stdout, result.stderr, result.command);
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
    return this.doFetch('/api/process/list', {
      method: 'GET',
    });
  }

  async startProcess(command: string, args: string[], options: any = {}) {
    return this.doFetch('/api/process/start', {
      method: 'POST',
      body: JSON.stringify({
        command,
        args,
        ...options,
      }),
    });
  }

  async killProcess(processId: string) {
    return this.doFetch(`/api/process/${processId}`, {
      method: 'DELETE',
    });
  }

  async killAllProcesses() {
    return this.doFetch('/api/process/kill-all', {
      method: 'DELETE',
    });
  }

  async getProcess(processId: string) {
    return this.doFetch(`/api/process/${processId}`, {
      method: 'GET',
    });
  }

  async getProcessLogs(processId: string) {
    return this.doFetch(`/api/process/${processId}/logs`, {
      method: 'GET',
    });
  }

  async exposePort(port: number, options: any = {}) {
    return this.doFetch('/api/expose-port', {
      method: 'POST',
      body: JSON.stringify({
        port,
        ...options,
      }),
    });
  }

  async unexposePort(port: number) {
    return this.doFetch('/api/unexpose-port', {
      method: 'POST',
      body: JSON.stringify({ port }),
    });
  }

  async getExposedPorts() {
    return this.doFetch('/api/exposed-ports', {
      method: 'GET',
    });
  }

  async *streamProcessLogs(processId: string): AsyncGenerator<any> {
    const response = await fetch(`${this.baseUrl}/api/process/${processId}/stream`, {
      headers: {
        'Accept': 'text/event-stream',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = ''; // Buffer for incomplete lines

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Add chunk to buffer
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events
        while (true) {
          const eventEnd = buffer.indexOf('\n\n');
          if (eventEnd === -1) break; // No complete event yet

          const eventData = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);

          // Parse the SSE event
          const lines = eventData.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const event = JSON.parse(line.substring(6));
                yield event;
              } catch (e) {
                console.warn('Failed to parse SSE event:', line, e);
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
    return this.doFetch('/api/write', {
      method: 'POST',
      body: JSON.stringify({
        path,
        content,
        ...options,
      }),
    });
  }

  async *execStream(command: string, args: string[], options: any = {}): AsyncGenerator<any> {
    const response = await fetch(`${this.baseUrl}/api/execute/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({
        command: `${command} ${args.join(' ')}`,
        ...options,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = ''; // Buffer for incomplete lines

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Add chunk to buffer
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events
        while (true) {
          const eventEnd = buffer.indexOf('\n\n');
          if (eventEnd === -1) break; // No complete event yet

          const eventData = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);

          // Parse the SSE event
          const lines = eventData.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const event = JSON.parse(line.substring(6));
                yield event;
              } catch (e) {
                console.warn('Failed to parse SSE event:', line, e);
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
    return this.doFetch('/api/ping', {
      method: 'GET',
    });
  }

  async createSession(sessionId?: string) {
    return this.doFetch('/api/session/create', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
  }

  async clearSession(sessionId: string) {
    return this.doFetch(`/api/session/clear/${sessionId}`, {
      method: 'POST',
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

type TabType = 'commands' | 'processes' | 'ports' | 'streaming';

interface ProcessInfo {
  id: string;
  pid?: number;
  command: string;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'killed' | 'error';
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
  sessionId
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
    processId: ""
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
    if (!client || connectionStatus !== "connected" || !processCommand.trim()) return;

    try {
      setIsStartingProcess(true);

      const options: any = {};
      if (processOptions.processId.trim()) options.processId = processOptions.processId.trim();
      if (sessionId) options.sessionId = sessionId;
      if (processOptions.timeout.trim()) options.timeout = parseInt(processOptions.timeout.trim());
      if (processOptions.cwd.trim()) options.cwd = processOptions.cwd.trim();

      // Parse environment variables
      if (processOptions.env.trim()) {
        const env: Record<string, string> = {};
        processOptions.env.split(',').forEach(pair => {
          const [key, value] = pair.split('=');
          if (key && value) env[key.trim()] = value.trim();
        });
        options.env = env;
      }

      const response = await client.startProcess(processCommand.trim(), options);
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

  const getStatusColor = (status: ProcessInfo['status']) => {
    switch (status) {
      case 'starting':
        return 'text-yellow-500';
      case 'running':
        return 'text-blue-500';
      case 'completed':
        return 'text-green-500';
      case 'failed':
      case 'error':
        return 'text-red-500';
      case 'killed':
        return 'text-orange-500';
      default:
        return 'text-gray-500';
    }
  };

  const getStatusIcon = (status: ProcessInfo['status']) => {
    switch (status) {
      case 'starting':
        return '⏳';
      case 'running':
        return '🟢';
      case 'completed':
        return '✅';
      case 'failed':
      case 'error':
        return '❌';
      case 'killed':
        return '🔶';
      default:
        return '⏳';
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
              onChange={(e) => setProcessOptions(prev => ({...prev, processId: e.target.value}))}
              className="process-input"
            />
            <input
              type="text"
              placeholder="Working Directory (optional)"
              value={processOptions.cwd}
              onChange={(e) => setProcessOptions(prev => ({...prev, cwd: e.target.value}))}
              className="process-input"
            />
          </div>

          <div className="form-row">
            <input
              type="text"
              placeholder="Timeout (ms, optional)"
              value={processOptions.timeout}
              onChange={(e) => setProcessOptions(prev => ({...prev, timeout: e.target.value}))}
              className="process-input"
            />
            <input
              type="text"
              placeholder="Environment (KEY1=val1,KEY2=val2)"
              value={processOptions.env}
              onChange={(e) => setProcessOptions(prev => ({...prev, env: e.target.value}))}
              className="process-input"
            />
          </div>

          <button
            onClick={startProcess}
            disabled={!processCommand.trim() || isStartingProcess || connectionStatus !== "connected"}
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
                setProcessOptions(prev => ({...prev, processId: "bun-server"}));
              }}
              className="btn btn-template"
            >
              🟨 Bun Server
            </button>
            <button
              onClick={() => {
                setProcessCommand("node -e \"setInterval(() => console.log('Heartbeat:', new Date().toISOString()), 2000)\"");
                setProcessOptions(prev => ({...prev, processId: "heartbeat"}));
              }}
              className="btn btn-template"
            >
              💓 Heartbeat
            </button>
            <button
              onClick={() => {
                setProcessCommand("tail -f /var/log/messages");
                setProcessOptions(prev => ({...prev, processId: "log-watcher"}));
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
                  <span className="status-icon">{getStatusIcon(process.status)}</span>
                  <span className={getStatusColor(process.status)}>{process.status}</span>
                </div>
                <div className="process-id">{process.id}</div>
                <div className="process-command">
                  {process.command}
                </div>
                <div className="process-pid">{process.pid || 'N/A'}</div>
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
                  {process.status === 'running' && (
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
              <pre className="logs-output stdout-logs">{processLogs.stdout}</pre>
            </div>
          )}

          {processLogs.stderr && (
            <div className="logs-section">
              <h4>STDERR:</h4>
              <pre className="logs-output stderr-logs">{processLogs.stderr}</pre>
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
  sessionId
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
    if (!client || connectionStatus !== "connected" || !portNumber.trim()) return;

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
        sessionId
      });

      // Wait a moment for server to start
      await new Promise(resolve => setTimeout(resolve, 2000));

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
        sessionId
      });

      // Wait a moment for server to start
      await new Promise(resolve => setTimeout(resolve, 2000));

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
        sessionId
      });

      // Wait a moment for server to start
      await new Promise(resolve => setTimeout(resolve, 2000));

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
            disabled={!portNumber.trim() || isExposing || connectionStatus !== "connected"}
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
            These templates will create a server file, start it as a background process, and expose the port automatically.
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
                    onClick={() => window.open(port.url, '_blank')}
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
            <strong>Background Processes:</strong> Use the "Processes" tab to start servers, then expose their ports here
          </li>
          <li>
            <strong>Server Templates:</strong> Click the template buttons above for instant server setup
          </li>
          <li>
            <strong>Preview URLs:</strong> All exposed ports get unique preview URLs that work from anywhere
          </li>
          <li>
            <strong>Port Management:</strong> Unexpose ports when done to free up resources
          </li>
        </ul>
      </div>
    </div>
  );
}

interface StreamEvent {
  id: string;
  type: 'start' | 'stdout' | 'stderr' | 'complete' | 'error';
  timestamp: string;
  data?: string;
  command?: string;
  exitCode?: number;
  error?: Error;
}

interface LogStreamEvent {
  id: string;
  type: 'stdout' | 'stderr' | 'status' | 'error';
  timestamp: string;
  data: string;
  processId: string;
  sessionId?: string;
}

interface ActiveStream {
  id: string;
  type: 'command' | 'process-logs';
  title: string;
  command?: string;
  processId?: string;
  isActive: boolean;
  events: (StreamEvent | LogStreamEvent)[];
  startTime: Date;
}

function StreamingTab({
  client,
  connectionStatus,
  sessionId
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
    if (!client || connectionStatus !== "connected" || !commandInput.trim() || isStreaming) return;

    const streamId = `cmd_${Date.now()}`;
    const command = commandInput.trim();

    setIsStreaming(true);
    setCommandInput("");

    // Add stream to active streams
    const newStream: ActiveStream = {
      id: streamId,
      type: 'command',
      title: `Command: ${command}`,
      command: command,
      isActive: true,
      events: [],
      startTime: new Date()
    };

    setActiveStreams(prev => [...prev, newStream]);

    try {
      // Use the new execStream AsyncIterable method
      const commandParts = command.split(' ');
      const cmd = commandParts[0];
      const args = commandParts.slice(1);
      const streamIterable = client.execStream(cmd, args, {
        sessionId: sessionId || undefined,
        signal: new AbortController().signal
      });

      for await (const event of streamIterable) {
        const streamEvent: StreamEvent = {
          id: `${streamId}_${Date.now()}_${Math.random()}`,
          type: event.type as 'start' | 'stdout' | 'stderr' | 'complete' | 'error',
          timestamp: event.timestamp,
          data: event.data,
          command: event.command,
          exitCode: event.exitCode,
          error: event.error
        };

        setActiveStreams(prev => prev.map(stream =>
          stream.id === streamId
            ? {
                ...stream,
                events: [...stream.events, streamEvent],
                isActive: event.type !== 'complete' && event.type !== 'error'
              }
            : stream
        ));

        // Break on completion or error
        if (event.type === 'complete' || event.type === 'error') {
          break;
        }
      }
    } catch (error) {
      console.error("Streaming error:", error);

      const errorEvent: StreamEvent = {
        id: `${streamId}_error_${Date.now()}`,
        type: 'error',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error : new Error(String(error))
      };

      setActiveStreams(prev => prev.map(stream =>
        stream.id === streamId
          ? {
              ...stream,
              events: [...stream.events, errorEvent],
              isActive: false
            }
          : stream
      ));
    } finally {
      setIsStreaming(false);
    }
  };

  // Start process log streaming using streamProcessLogs (AsyncIterable)
  const startProcessLogStream = async (selectedProcessId: string) => {
    if (!client || connectionStatus !== "connected" || !selectedProcessId.trim()) return;

    const streamId = `logs_${selectedProcessId}_${Date.now()}`;

    // Add stream to active streams
    const newStream: ActiveStream = {
      id: streamId,
      type: 'process-logs',
      title: `Process Logs: ${selectedProcessId}`,
      processId: selectedProcessId,
      isActive: true,
      events: [],
      startTime: new Date()
    };

    setActiveStreams(prev => [...prev, newStream]);

    try {
      // Use the new streamProcessLogs AsyncIterable method
      const logStreamIterable = client.streamProcessLogs(selectedProcessId);

      for await (const logEvent of logStreamIterable) {
        const streamEvent: LogStreamEvent = {
          id: `${streamId}_${Date.now()}_${Math.random()}`,
          type: logEvent.type as 'stdout' | 'stderr' | 'status' | 'error',
          timestamp: logEvent.timestamp,
          data: logEvent.data,
          processId: logEvent.processId,
          sessionId: logEvent.sessionId
        };

        setActiveStreams(prev => prev.map(stream =>
          stream.id === streamId
            ? { ...stream, events: [...stream.events, streamEvent] }
            : stream
        ));
      }
    } catch (error) {
      console.error("Log streaming error:", error);

      const errorEvent: LogStreamEvent = {
        id: `${streamId}_error_${Date.now()}`,
        type: 'error',
        timestamp: new Date().toISOString(),
        data: `Error: ${error instanceof Error ? error.message : String(error)}`,
        processId: selectedProcessId
      };

      setActiveStreams(prev => prev.map(stream =>
        stream.id === streamId
          ? {
              ...stream,
              events: [...stream.events, errorEvent],
              isActive: false
            }
          : stream
      ));
    }
  };

  // Stop a stream
  const stopStream = (streamId: string) => {
    setActiveStreams(prev => prev.map(stream =>
      stream.id === streamId
        ? { ...stream, isActive: false }
        : stream
    ));
  };

  // Clear a stream
  const clearStream = (streamId: string) => {
    setActiveStreams(prev => prev.filter(stream => stream.id !== streamId));
  };

  // Clear all streams
  const clearAllStreams = () => {
    setActiveStreams([]);
  };

  // Get event color
  const getEventColor = (type: string) => {
    switch (type) {
      case 'start':
        return 'text-blue-500';
      case 'stdout':
        return 'text-green-500';
      case 'stderr':
        return 'text-red-500';
      case 'complete':
        return 'text-green-500';
      case 'error':
        return 'text-red-500';
      case 'status':
        return 'text-yellow-500';
      default:
        return 'text-gray-500';
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
          Test the new <code>execStream()</code> AsyncIterable method for real-time command output.
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
                if (e.key === 'Enter') {
                  startCommandStream();
                }
              }}
            />
            <button
              onClick={startCommandStream}
              disabled={!commandInput.trim() || isStreaming || connectionStatus !== "connected"}
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
              onClick={() => setCommandInput("find / -name '*.txt' 2>/dev/null | head -20")}
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
          Test the new <code>streamProcessLogs()</code> AsyncIterable method for real-time process log monitoring.
        </p>

        {processes.length === 0 ? (
          <div className="no-processes-message">
            No background processes running. Start some processes in the "Processes" tab first!
          </div>
        ) : (
          <div className="process-selector">
            <h4>Select Process to Stream:</h4>
            <div className="process-buttons">
              {processes.filter(p => p.status === 'running').map(process => (
                <button
                  key={process.id}
                  onClick={() => startProcessLogStream(process.id)}
                  className="btn btn-template"
                  disabled={activeStreams.some(s => s.processId === process.id)}
                >
                  📋 {process.id} ({process.command})
                  {activeStreams.some(s => s.processId === process.id) && ' ✅'}
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
            No active streams. Start a command stream or process log stream above!
          </div>
        ) : (
          <div className="streams-grid">
            {activeStreams.map(stream => (
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
                      {stream.events.slice(-50).map(event => (
                        <div key={event.id} className="stream-event">
                          <div className="event-header">
                            <span className={`event-type ${getEventColor(event.type)}`}>
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
            <strong>AsyncIterable Pattern:</strong> Uses modern JavaScript async iterators for clean streaming
          </li>
          <li>
            <strong>Multiple Streams:</strong> Monitor multiple commands and process logs simultaneously
          </li>
          <li>
            <strong>Real-time Updates:</strong> Events appear immediately as they happen
          </li>
          <li>
            <strong>Event Filtering:</strong> Different colors and types for stdout, stderr, status, etc.
          </li>
          <li>
            <strong>Stream Management:</strong> Start, stop, and clear individual or all streams
          </li>
        </ul>
      </div>
    </div>
  );
}

function SandboxTester() {
  const [activeTab, setActiveTab] = useState<TabType>('commands');
  const [client, setClient] = useState<SandboxApiClient | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [commandInput, setCommandInput] = useState("");
  const [results, setResults] = useState<CommandResult[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const resultsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new results are added
  useEffect(() => {
    if (activeTab === 'commands') {
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
        command: string,
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
        const newResult: CommandResult = {
          command,
          id: Date.now().toString(),
          status: "running",
          stderr: "",
          stdout: "",
          timestamp: new Date(),
        };
        setResults((prev) => [...prev, newResult]);
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

        // Test connection with ping
        await httpClient.ping();
        console.log("Server is reachable");

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
    if (!client || connectionStatus !== "connected" || !commandInput.trim() || isExecuting) {
      return;
    }

    const trimmedCommand = commandInput.trim();

    try {
      setIsExecuting(true);

      // Create a result entry for the command
      const newResult: CommandResult = {
        command: trimmedCommand,
        id: Date.now().toString(),
        status: "running",
        stderr: "",
        stdout: "",
        timestamp: new Date(),
      };
      setResults((prev) => [...prev, newResult]);

      // Execute the command
      console.log("Executing command:", trimmedCommand);
      const result = await client.execute(
        trimmedCommand,
        [],
        { sessionId: sessionId || undefined }
      );
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
    } finally {
      setIsExecuting(false);
    }
  };

  const executeStreamingCommand = async () => {
    if (!client || connectionStatus !== "connected" || !commandInput.trim() || isExecuting) {
      return;
    }

    const trimmedCommand = commandInput.trim();

    try {
      setIsExecuting(true);

      // Create a result entry for the command
      const newResult: CommandResult = {
        command: trimmedCommand,
        id: Date.now().toString(),
        status: "running",
        stderr: "",
        stdout: "",
        timestamp: new Date(),
      };
      setResults((prev) => [...prev, newResult]);

      // Execute the command with streaming
      console.log("Executing streaming command:", trimmedCommand);
      await client.executeStream(trimmedCommand, [], { sessionId: sessionId || undefined });
      console.log("Streaming command completed");

      setCommandInput("");
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
        <h1>Sandbox SDK Tester</h1>
        <div
          className={`connection-status ${connectionStatus}`}
        >
          {connectionStatus === "connected"
            ? `Connected (${sessionId})`
            : connectionStatus === "connecting"
            ? "Connecting..."
            : "Disconnected"}
        </div>
      </div>

      <div className="tab-navigation">
        <button
          className={`tab-button ${activeTab === 'commands' ? 'active' : ''}`}
          onClick={() => setActiveTab('commands')}
        >
          📟 Commands
        </button>
        <button
          className={`tab-button ${activeTab === 'processes' ? 'active' : ''}`}
          onClick={() => setActiveTab('processes')}
        >
          ⚙️ Processes
        </button>
        <button
          className={`tab-button ${activeTab === 'ports' ? 'active' : ''}`}
          onClick={() => setActiveTab('ports')}
        >
          🌐 Ports
        </button>
        <button
          className={`tab-button ${activeTab === 'streaming' ? 'active' : ''}`}
          onClick={() => setActiveTab('streaming')}
        >
          📡 Streaming
        </button>
      </div>

      <div className="tab-content-area">
        {activeTab === 'commands' && (
          <div className="commands-tab">
            <div className="command-bar">
        <span className="command-prompt">$</span>
        <input
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
            disabled={connectionStatus !== "connected" || !commandInput.trim() || isExecuting}
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

      <div className="results-container" ref={resultsEndRef}>
        {results.length === 0 ? (
          <div
            style={{ color: "#8b949e", padding: "2rem", textAlign: "center" }}
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
                    ${" "}
                    <span>
                      {result.command}
                    </span>
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
                  <span className="help-command">pwd</span> - Print working directory
                </div>
                <div className="help-item">
                  <span className="help-command">echo</span> - Print text
                </div>
                <div className="help-item">
                  <span className="help-command">cat</span> - Display file contents
                </div>
                <div className="help-item">
                  <span className="help-command">whoami</span> - Show current user
                </div>
                <div className="help-item">
                  <span className="help-command">date</span> - Show current date/time
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

        {activeTab === 'processes' && (
          <ProcessManagementTab client={client} connectionStatus={connectionStatus} sessionId={sessionId} />
        )}

        {activeTab === 'ports' && (
          <PortManagementTab client={client} connectionStatus={connectionStatus} sessionId={sessionId} />
        )}

        {activeTab === 'streaming' && (
          <StreamingTab client={client} connectionStatus={connectionStatus} sessionId={sessionId} />
        )}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<SandboxTester />);
