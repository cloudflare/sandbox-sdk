/**
 * WebSocket Example for Cloudflare Sandbox SDK
 *
 * This example demonstrates how to use connect() to route WebSocket requests
 * to WebSocket servers running inside sandbox containers.
 */

import { connect, getSandbox, Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Initialize servers endpoint (called on page load)
    if (pathname === "/api/init") {
      return handleInitServers(request, env);
    }

    // Check for WebSocket upgrade
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      // Serve a simple HTML page for testing
      if (pathname === "/") {
        return new Response(getTestHTML(), {
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response("Expected WebSocket", { status: 426 });
    }

    // Route to different WebSocket handlers
    switch (pathname) {
      case "/ws/echo":
        return handleEchoWebSocket(request, env);
      case "/ws/code":
        return handleCodeStreamingWebSocket(request, env);
      case "/ws/terminal":
        return handleTerminalWebSocket(request, env);
      default:
        return new Response("Unknown WebSocket endpoint", { status: 404 });
    }
  },
};

/**
 * Initialize all WebSocket servers on page load
 * This ensures servers are ready when users click "Connect"
 */
async function handleInitServers(request: Request, env: Env): Promise<Response> {
  const sandboxId = new URL(request.url).searchParams.get("id") || "demo-sandbox";
  const sandbox = getSandbox(env.Sandbox, sandboxId);

  try {
    // Check which servers are already running
    const processes = await sandbox.listProcesses();
    const runningServers = new Set(
      processes
        .filter(p => p.status === 'running')
        .map(p => p.id)
    );

    const serversToStart = [];

    // Echo server (port 8080)
    if (!runningServers.has('ws-echo-8080')) {
      const echoScript = `
const port = 8080;
Bun.serve({
  port,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response('Expected WebSocket', { status: 400 });
  },
  websocket: {
    message(ws, message) { ws.send(message); },
    open(ws) { console.log('Client connected'); },
    close(ws) { console.log('Client disconnected'); },
  },
});
console.log('Echo server listening on port ' + port);
`;
      await sandbox.writeFile('/tmp/echo-server.ts', echoScript);
      serversToStart.push(
        sandbox.startProcess('bun run /tmp/echo-server.ts', {
          processId: 'ws-echo-8080'
        })
      );
    }

    // Code server (port 8081)
    if (!runningServers.has('ws-code-8081')) {
      const codeScript = `
const port = 8081;
Bun.serve({
  port,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response('Expected WebSocket', { status: 400 });
  },
  websocket: {
    async message(ws, message) {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'execute') {
          const { code } = data;
          ws.send(JSON.stringify({ type: 'executing', timestamp: Date.now() }));
          const filename = '/tmp/code_' + Date.now() + '.py';
          await Bun.write(filename, code);
          const proc = Bun.spawn(['python3', filename], { stdout: 'pipe', stderr: 'pipe' });
          const reader = proc.stdout.getReader();
          const textDecoder = new TextDecoder();
          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = textDecoder.decode(value, { stream: true });
                if (text) ws.send(JSON.stringify({ type: 'stdout', data: text, timestamp: Date.now() }));
              }
            } catch (e) {}
          })();
          const stderrReader = proc.stderr.getReader();
          (async () => {
            try {
              while (true) {
                const { done, value } = await stderrReader.read();
                if (done) break;
                const text = textDecoder.decode(value, { stream: true });
                if (text) ws.send(JSON.stringify({ type: 'stderr', data: text, timestamp: Date.now() }));
              }
            } catch (e) {}
          })();
          const exitCode = await proc.exited;
          ws.send(JSON.stringify({ type: 'completed', exitCode, timestamp: Date.now() }));
          try { await Bun.spawn(['rm', '-f', filename]).exited; } catch (e) {}
        }
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', message: error.message || String(error), timestamp: Date.now() }));
      }
    },
    open(ws) {
      ws.send(JSON.stringify({ type: 'ready', message: 'Python code execution server ready', timestamp: Date.now() }));
    },
  },
});
console.log('Code streaming server listening on port ' + port);
`;
      await sandbox.writeFile('/tmp/code-server.ts', codeScript);
      serversToStart.push(
        sandbox.startProcess('bun run /tmp/code-server.ts', {
          processId: 'ws-code-8081'
        })
      );
    }

    // Terminal server (port 8082)
    if (!runningServers.has('ws-terminal-8082')) {
      const terminalScript = `
const port = 8082;
Bun.serve({
  port,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response('Expected WebSocket', { status: 400 });
  },
  websocket: {
    async message(ws, message) {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'command') {
          const { command } = data;
          ws.send(JSON.stringify({ type: 'executing', command, timestamp: Date.now() }));
          const proc = Bun.spawn(['sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          const exitCode = await proc.exited;
          ws.send(JSON.stringify({ type: 'result', stdout, stderr, exitCode, timestamp: Date.now() }));
        } else if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', message: error.message || String(error), timestamp: Date.now() }));
      }
    },
    open(ws) {
      ws.send(JSON.stringify({ type: 'ready', message: 'Terminal server ready', cwd: process.cwd(), timestamp: Date.now() }));
    },
  },
});
console.log('Terminal server listening on port ' + port);
`;
      await sandbox.writeFile('/tmp/terminal-server.ts', terminalScript);
      serversToStart.push(
        sandbox.startProcess('bun run /tmp/terminal-server.ts', {
          processId: 'ws-terminal-8082'
        })
      );
    }

    // Start all servers and track results
    const results = await Promise.allSettled(serversToStart);
    const failedCount = results.filter(r => r.status === "rejected").length;
    const succeededCount = results.filter(r => r.status === "fulfilled").length;

    return new Response(JSON.stringify({
      success: failedCount === 0,
      message: failedCount === 0 ? 'All servers initialized' : `${failedCount} server(s) failed to start`,
      serversStarted: succeededCount,
      serversFailed: failedCount,
      errors: failedCount > 0 ? results
        .filter(r => r.status === "rejected")
        .map(r => (r as PromiseRejectedResult).reason?.message || String((r as PromiseRejectedResult).reason))
        : undefined
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: failedCount > 0 ? 500 : 200
    });
  } catch (error: any) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Example 1: Basic Echo Server
 * Echoes back any message received
 */
async function handleEchoWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  const sandboxId = new URL(request.url).searchParams.get("id") || "demo-sandbox";
  const sandbox = getSandbox(env.Sandbox, sandboxId);

  // Server is pre-initialized on page load, just connect
  return await connect(sandbox, request, 8080);
}

/**
 * Example 2: Code Streaming Server
 * Executes code and streams output in real-time
 */
async function handleCodeStreamingWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  const sandboxId = new URL(request.url).searchParams.get("id") || "demo-sandbox";
  const sandbox = getSandbox(env.Sandbox, sandboxId);

  // Server is pre-initialized on page load, just connect
  return await connect(sandbox, request, 8081);
}

/**
 * Example 3: Interactive Terminal
 * Provides terminal-like command execution
 */
async function handleTerminalWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  const sandboxId = new URL(request.url).searchParams.get("id") || "demo-sandbox";
  const sandbox = getSandbox(env.Sandbox, sandboxId);

  // Server is pre-initialized on page load, just connect
  return await connect(sandbox, request, 8082);
}

/**
 * Simple HTML test page for WebSocket examples
 */
function getTestHTML(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Sandbox WebSocket Examples</title>
  <style>
    body {
      font-family: 'Courier New', monospace;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      background: #1e1e1e;
      color: #d4d4d4;
    }
    .example {
      border: 1px solid #3c3c3c;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
      background: #252526;
    }
    h1, h2 {
      color: #4ec9b0;
    }
    button {
      background: #0e639c;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 4px;
      cursor: pointer;
      margin: 5px;
    }
    button:hover {
      background: #1177bb;
    }
    button:disabled {
      background: #555;
      cursor: not-allowed;
    }
    textarea, input {
      width: 100%;
      padding: 10px;
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      background: #1e1e1e;
      color: #d4d4d4;
      font-family: 'Courier New', monospace;
      margin: 10px 0;
      box-sizing: border-box;
    }
    .output {
      background: #1e1e1e;
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      padding: 15px;
      margin: 10px 0;
      min-height: 100px;
      max-height: 400px;
      overflow-y: auto;
      white-space: pre-wrap;
      font-family: 'Courier New', monospace;
    }
    .status {
      padding: 5px 10px;
      border-radius: 4px;
      display: inline-block;
      margin: 5px 0;
    }
    .connected { background: #0e639c; }
    .disconnected { background: #f48771; }
    .info {
      background: #2d2d30;
      border: 2px solid #4ec9b0;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
    }
  </style>
</head>
<body>
  <h1>Sandbox SDK WebSocket Examples</h1>

  <div class="info">
    <h3 style="margin-top: 0; color: #4ec9b0;">WebSocket with connect()</h3>
    <p>
      All examples use <code>connect(sandbox, request, port)</code> to route incoming
      WebSocket requests to WebSocket servers running inside the container.
    </p>
    <p style="font-size: 0.85em; color: #888;">
      <span id="init-status"> Initializing servers...</span>
    </p>
  </div>

  <div class="example">
    <h2>1. Echo Server</h2>
    <p style="color: #888; font-size: 0.85em;">
      Simple echo - sends back any message you send to it
    </p>
    <div id="echo-status" class="status disconnected">Disconnected</div>
    <input type="text" id="echo-input" placeholder="Enter message to echo">
    <button onclick="echoConnect()">Connect</button>
    <button onclick="echoSend()">Send</button>
    <button onclick="echoDisconnect()">Disconnect</button>
    <button onclick="echoClear()">Clear</button>
    <div class="output" id="echo-output"></div>
  </div>

  <div class="example">
    <h2>2. Python Code Streaming</h2>
    <p style="color: #888; font-size: 0.85em;">
      Execute Python code with real-time streaming output
    </p>
    <div id="code-status" class="status disconnected">Disconnected</div>
    <textarea id="code-input" rows="8" placeholder="Enter Python code here...">import time
for i in range(5):
    print(f'Count: {i}')
    time.sleep(0.5)
print('Done!')</textarea>
    <button onclick="codeConnect()">Connect</button>
    <button onclick="codeExecute()">Execute</button>
    <button onclick="codeDisconnect()">Disconnect</button>
    <button onclick="codeClear()">Clear</button>
    <div class="output" id="code-output"></div>
  </div>

  <div class="example">
    <h2>3. Interactive Terminal</h2>
    <p style="color: #888; font-size: 0.85em;">
      Run shell commands and see results
    </p>
    <div id="terminal-status" class="status disconnected">Disconnected</div>
    <input type="text" id="terminal-input" placeholder="Enter command (e.g., ls -la)">
    <button onclick="terminalConnect()">Connect</button>
    <button onclick="terminalExecute()">Execute</button>
    <button onclick="terminalDisconnect()">Disconnect</button>
    <button onclick="terminalClear()">Clear</button>
    <div class="output" id="terminal-output"></div>
  </div>

  <script>
    let echoWs = null;
    let codeWs = null;
    let terminalWs = null;
    const sandboxId = 'demo-sandbox';

    // Initialize servers on page load
    (async () => {
      try {
        const response = await fetch('/api/init?id=' + sandboxId);
        const data = await response.json();
        const statusEl = document.getElementById('init-status');
        if (data.success) {
          statusEl.textContent = 'Servers ready! Click Connect to start.';
          statusEl.style.color = '#4ec9b0';
        } else {
          statusEl.textContent = 'Server init failed: ' + data.error;
          statusEl.style.color = '#f48771';
        }
      } catch (error) {
        document.getElementById('init-status').textContent = 'Init error: ' + error.message;
        document.getElementById('init-status').style.color = '#f48771';
      }
    })();

    // Echo Server
    function echoConnect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      echoWs = new WebSocket(protocol + '//' + location.host + '/ws/echo?id=' + sandboxId);

      echoWs.onopen = () => {
        document.getElementById('echo-status').textContent = 'Connected';
        document.getElementById('echo-status').className = 'status connected';
      };

      echoWs.onmessage = (event) => {
        logEcho('Received: ' + event.data);
      };

      echoWs.onclose = () => {
        document.getElementById('echo-status').textContent = 'Disconnected';
        document.getElementById('echo-status').className = 'status disconnected';
      };

      echoWs.onerror = () => {
        logEcho('Connection error - make sure servers are initialized');
      };
    }

    function echoSend() {
      if (!echoWs || echoWs.readyState !== WebSocket.OPEN) {
        alert('Not connected');
        return;
      }
      const input = document.getElementById('echo-input');
      const message = input.value;
      echoWs.send(message);
      logEcho('Sent: ' + message);
      input.value = '';
    }

    function echoDisconnect() {
      if (echoWs) {
        echoWs.close();
        echoWs = null;
      }
    }

    function echoClear() {
      document.getElementById('echo-output').textContent = '';
    }

    function logEcho(message) {
      const output = document.getElementById('echo-output');
      output.textContent += message + '\\n';
      output.scrollTop = output.scrollHeight;
    }

    // Code Streaming
    function codeConnect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      codeWs = new WebSocket(protocol + '//' + location.host + '/ws/code?id=' + sandboxId);

      codeWs.onopen = () => {
        document.getElementById('code-status').textContent = 'Connected';
        document.getElementById('code-status').className = 'status connected';
      };

      codeWs.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'ready') {
            logCode('[READY] ' + data.message + '\\n');
          } else if (data.type === 'executing') {
            logCode('[EXECUTING...]\\n');
          } else if (data.type === 'stdout') {
            logCode(data.data);
          } else if (data.type === 'stderr') {
            logCode('[STDERR] ' + data.data);
          } else if (data.type === 'completed') {
            logCode('\\n[COMPLETED] Exit code: ' + data.exitCode + '\\n');
          } else if (data.type === 'error') {
            logCode('[ERROR] ' + data.message + '\\n');
          }
        } catch (e) {
          logCode('Parse error: ' + event.data + '\\n');
        }
      };

      codeWs.onclose = () => {
        document.getElementById('code-status').textContent = 'Disconnected';
        document.getElementById('code-status').className = 'status disconnected';
      };

      codeWs.onerror = () => {
        logCode('Connection error - make sure servers are initialized\\n');
      };
    }

    function codeExecute() {
      if (!codeWs || codeWs.readyState !== WebSocket.OPEN) {
        alert('Not connected');
        return;
      }
      const code = document.getElementById('code-input').value;

      codeWs.send(JSON.stringify({
        type: 'execute',
        code: code
      }));
    }

    function codeDisconnect() {
      if (codeWs) {
        codeWs.close();
        codeWs = null;
      }
    }

    function codeClear() {
      document.getElementById('code-output').textContent = '';
    }

    function logCode(message) {
      const output = document.getElementById('code-output');
      output.textContent += message;
      output.scrollTop = output.scrollHeight;
    }

    // Terminal
    function terminalConnect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      terminalWs = new WebSocket(protocol + '//' + location.host + '/ws/terminal?id=' + sandboxId);

      terminalWs.onopen = () => {
        document.getElementById('terminal-status').textContent = 'Connected';
        document.getElementById('terminal-status').className = 'status connected';
      };

      terminalWs.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'ready') {
            logTerminal('[READY] ' + data.message);
            logTerminal('Working directory: ' + data.cwd + '\\n');
          } else if (data.type === 'executing') {
            logTerminal('$ ' + data.command);
          } else if (data.type === 'result') {
            if (data.stdout) logTerminal(data.stdout);
            if (data.stderr) logTerminal('[STDERR] ' + data.stderr);
            logTerminal('[Exit code: ' + data.exitCode + ']\\n');
          } else if (data.type === 'error') {
            logTerminal('[ERROR] ' + data.message);
          }
        } catch (e) {
          logTerminal('Parse error: ' + event.data);
        }
      };

      terminalWs.onclose = () => {
        document.getElementById('terminal-status').textContent = 'Disconnected';
        document.getElementById('terminal-status').className = 'status disconnected';
      };

      terminalWs.onerror = () => {
        logTerminal('Connection error - make sure servers are initialized\\n');
      };
    }

    function terminalExecute() {
      if (!terminalWs || terminalWs.readyState !== WebSocket.OPEN) {
        alert('Not connected');
        return;
      }
      const input = document.getElementById('terminal-input');
      const command = input.value;

      terminalWs.send(JSON.stringify({
        type: 'command',
        command: command
      }));

      input.value = '';
    }

    function terminalDisconnect() {
      if (terminalWs) {
        terminalWs.close();
        terminalWs = null;
      }
    }

    function terminalClear() {
      document.getElementById('terminal-output').textContent = '';
    }

    function logTerminal(message) {
      const output = document.getElementById('terminal-output');
      output.textContent += message + '\\n';
      output.scrollTop = output.scrollHeight;
    }

    // Allow Enter key to submit
    document.getElementById('echo-input').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') echoSend();
    });

    document.getElementById('terminal-input').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') terminalExecute();
    });
  </script>
</body>
</html>`;
}

export { Sandbox };
