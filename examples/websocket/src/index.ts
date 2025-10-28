/**
 * WebSocket Example for Cloudflare Sandbox SDK
 */

import {
  connect,
  createWebSocketHandler,
  getSandbox,
  parseSSEStream,
  Sandbox,
  SandboxWebSocket,
  type LogEvent
} from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

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
        return handleCodeExecutionWebSocket(request, env);
      case "/ws/process":
        return handleProcessStreamWebSocket(request, env);
      case "/ws/terminal":
        return handleTerminalWebSocket(request, env);
      case "/ws/protected":
        return handleProtectedWebSocket(request, env);
      case "/ws/container":
        return handleContainerWebSocket(request, env);
      default:
        return new Response("Unknown WebSocket endpoint", { status: 404 });
    }
  },
};

/**
 * Example 1: Basic Echo Server
 * Demonstrates basic WebSocket handling with sandbox execution using createWebSocketHandler
 */
async function handleEchoWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  // Use the createWebSocketHandler helper for automatic setup
  const { response, websocket: ws, sandbox, sandboxId } = await createWebSocketHandler(
    request,
    env.Sandbox as any as DurableObjectNamespace,
    {
      sandboxId: new URL(request.url).searchParams.get("id") || "echo-sandbox",
      onReady: (ws, sandboxId) => {
        // Send welcome message when connection is ready
        ws.send({
          type: "connected",
          message: "Echo server connected",
          sandboxId,
        });
      },
      onMessage: async (ws, message) => {
        switch (message.type) {
          case "echo":
            // Simple echo back
            ws.send({
              type: "echo",
              data: message.data,
              timestamp: Date.now(),
            });
            break;

          case "execute":
            // Execute a command in the sandbox and echo the result
            const result = await sandbox.exec(message.command);
            ws.send({
              type: "result",
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
            });
            break;

          case "ping":
            ws.send({ type: "pong" });
            break;

          default:
            ws.sendError("Unknown message type");
        }
      },
      onClose: () => {
        console.log("WebSocket closed");
      },
    }
  );

  return response;
}

/**
 * Example 2: Real-Time Code Execution
 * Executes Python/JavaScript code using basic shell execution
 */
async function handleCodeExecutionWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  const { response, websocket: ws, sandbox } = await createWebSocketHandler(
    request,
    env.Sandbox as any as DurableObjectNamespace,
    {
      sandboxId: new URL(request.url).searchParams.get("id") || "code-interpreter",
      onReady: (ws) => {
        ws.sendReady("Code interpreter ready");
      },
      onMessage: async (ws, message) => {
        if (message.type === "execute") {
          const { code, language = "python", sessionId } = message;

          // Send acknowledgment
          ws.send({
            type: "executing",
            sessionId,
          });

          try {
            // Write code to a temporary file and execute it
            const filename = `/tmp/code_${Date.now()}.${language === "javascript" ? "js" : "py"}`;
            await sandbox.writeFile(filename, code);

            // Execute the code
            const command = language === "javascript"
              ? `node ${filename}`
              : `python3 ${filename}`;

            const result = await sandbox.exec(command);

            // Send output
            if (result.stdout) {
              ws.sendOutput("stdout", result.stdout);
            }
            if (result.stderr) {
              ws.sendOutput("stderr", result.stderr);
            }

            // Send final result
            ws.send({
              type: "result",
              sessionId,
              exitCode: result.exitCode,
              success: result.exitCode === 0,
            });

            // Clean up
            await sandbox.exec(`rm -f ${filename}`);
          } catch (error: any) {
            ws.sendError(error);
          }
        } else if (message.type === "reset") {
          // Clean up any temporary files
          await sandbox.exec("rm -f /tmp/code_*.py /tmp/code_*.js").catch(() => {});
          ws.send({
            type: "reset",
            message: "Context reset",
          });
        }
      },
    }
  );

  return response;
}

/**
 * Example 3: Process Output Streaming
 * Starts a long-running process and streams its output using createWebSocketHandler
 */
async function handleProcessStreamWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  let currentProcess: any = null;

  const { response, websocket: ws, sandbox } = await createWebSocketHandler(
    request,
    env.Sandbox as any as DurableObjectNamespace,
    {
      sandboxId: new URL(request.url).searchParams.get("id") || "process-stream",
      onReady: (ws) => {
        ws.sendReady("Process streamer ready");
      },
      onMessage: async (ws, message) => {
        if (message.type === "start") {
          const { command, args = [] } = message;

          // Build full command string
          const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;

          // Start the process using the built-in helper
          currentProcess = await ws.startProcessWithStreaming(fullCommand);

          ws.send({
            type: "started",
            pid: currentProcess.pid,
          });

          // Stream logs in the background (handled by startProcessWithStreaming)
          // But we need to listen for completion
          (async () => {
            try {
              const logStream = await sandbox.streamProcessLogs(currentProcess.id);

              for await (const event of parseSSEStream<LogEvent>(logStream)) {
                if (event.type === "stdout" || event.type === "stderr") {
                  ws.sendOutput(event.type, event.data, currentProcess.pid);
                }
              }

              // Process completed
              ws.send({
                type: "completed",
                pid: currentProcess.pid,
              });
            } catch (error: any) {
              ws.sendError(error);
            }
          })();
        } else if (message.type === "kill" && currentProcess) {
          await sandbox.killProcess(currentProcess.id);
          ws.send({
            type: "killed",
            pid: currentProcess.pid,
          });
          currentProcess = null;
        }
      },
      onClose: async () => {
        if (currentProcess) {
          try {
            await sandbox.killProcess(currentProcess.id);
          } catch {
            // Process might already be done
          }
        }
      },
    }
  );

  return response;
}

/**
 * Example 4: Interactive Terminal
 * Provides a full interactive shell session using createWebSocketHandler
 */
async function handleTerminalWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  let shell: any = null;

  const { response, websocket: ws, sandbox } = await createWebSocketHandler(
    request,
    env.Sandbox as any as DurableObjectNamespace,
    {
      sandboxId: new URL(request.url).searchParams.get("id") || "terminal-session",
      onReady: async (ws) => {
        // Start an interactive bash shell
        shell = await sandbox.startProcess("/bin/bash -i", {
          env: {
            TERM: "xterm-256color",
            PS1: "\\[\\033[01;32m\\]sandbox\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]$ ",
          },
        });

        ws.send({
          type: "ready",
          pid: shell.pid,
          message: "Terminal connected",
        });

        // Stream shell output to client
        (async () => {
          try {
            const logStream = await sandbox.streamProcessLogs(shell.id);

            for await (const event of parseSSEStream<LogEvent>(logStream)) {
              if (event.type === "stdout") {
                // Send raw output for terminal rendering
                ws.raw.send(event.data);
              }
            }

            // Shell exited
            ws.send({
              type: "exit",
              message: "Shell process exited",
            });
            ws.close(1000, "Shell exited");
          } catch (error: any) {
            ws.sendError(error);
            ws.close(1011, "Error");
          }
        })();
      },
      onMessage: async (ws, message, event) => {
        const input = event.data as string;

        // Handle special commands
        if (input.startsWith("{")) {
          const command = JSON.parse(input);

          if (command.type === "resize") {
            // Handle terminal resize (would need TTY support)
            // For now, just acknowledge
            ws.send({
              type: "resized",
              rows: command.rows,
              cols: command.cols,
            });
          }
        } else {
          // Regular input - send to shell stdin
          // Note: This requires implementing sendToProcess in the sandbox
          // await sandbox.sendToProcess(shell.pid, input);

          // For now, we'll use a workaround by executing each line
          if (input.includes('\n')) {
            const result = await sandbox.exec(input.trim());
            ws.raw.send(result.stdout + result.stderr);
          }
        }
      },
      onClose: async () => {
        if (shell) {
          try {
            await sandbox.killProcess(shell.id);
          } catch {
            // Process might already be done
          }
        }
      },
    }
  );

  return response;
}

/**
 * Example 5: Protected WebSocket with Rate Limiting & Timeouts
 */
async function handleProtectedWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  const { response, websocket: ws, sandbox, sandboxId } = await createWebSocketHandler(
    request,
    env.Sandbox as any as DurableObjectNamespace,
    {
      sandboxId: new URL(request.url).searchParams.get("id") || "protected-session",
      // Configure rate limiting
      rateLimit: {
        maxMessages: 100,
        windowMs: 60000, // 1 minute
        maxMessageSize: 1024 * 1024, // 1MB
      },
      // Configure connection timeouts
      timeout: {
        idleTimeout: 300000, // 5 minutes
        maxConnectionTime: 1800000, // 30 minutes
        heartbeatInterval: 30000, // 30 seconds
      },
      onReady: (ws, sandboxId) => {
        // Send welcome with limits info
        ws.send({
          type: "connected",
          message: "Protected WebSocket connected",
          sandboxId,
          limits: {
            maxMessages: 100,
            windowMs: 60000,
            maxMessageSize: 1024 * 1024,
            idleTimeout: 300000,
            maxConnectionTime: 1800000,
          },
        });
      },
      onMessage: async (ws, message) => {
        switch (message.type) {
          case "echo":
            ws.send({
              type: "echo",
              data: message.data,
              timestamp: Date.now(),
            });
            break;

          case "execute":
            const result = await sandbox.exec(message.command);
            ws.send({
              type: "result",
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
            });
            break;

          case "status":
            ws.send({
              type: "status",
              connected: true,
              sandboxId,
            });
            break;

          default:
            ws.sendError("Unknown message type");
        }
      },
      onRateLimitExceeded: (ws) => {
        console.log("Rate limit exceeded for protected WebSocket");
      },
      onClose: () => {
        console.log("Protected WebSocket closed");
      },
    }
  );

  return response;
}

/**
 * Example 6: Connect to WebSocket Server Inside Container
 * Demonstrates using connect() to proxy to a WebSocket server running in the container
 *
 * This example shows how to connect to a WebSocket server that's running inside
 * the sandbox container. We use connect(sandbox, request, port) to route the incoming
 * WebSocket request to port 8080 where our Node.js WebSocket server is listening.
 */
async function handleContainerWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  const sandboxId = new URL(request.url).searchParams.get("id") || "container-ws";

  // Get sandbox instance using getSandbox helper
  const sandbox = getSandbox(env.Sandbox, sandboxId);

  // Create a simple Node.js WebSocket echo server
  // Using Node.js because it should be available in the container
  const serverScript = `
const http = require('http');
const crypto = require('crypto');

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('WebSocket server running');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\\r\\n' +
    'Upgrade: websocket\\r\\n' +
    'Connection: Upgrade\\r\\n' +
    'Sec-WebSocket-Accept: ' + acceptKey + '\\r\\n\\r\\n'
  );

  socket.on('data', (data) => {
    // Simple echo - parse WebSocket frame and echo back
    if (data[0] === 0x81) {
      const len = data[1] & 127;
      const maskStart = 2;
      const dataStart = maskStart + 4;
      const mask = data.slice(maskStart, dataStart);
      const payload = data.slice(dataStart, dataStart + len);

      // Unmask the payload
      const decoded = Buffer.alloc(len);
      for (let i = 0; i < len; i++) {
        decoded[i] = payload[i] ^ mask[i % 4];
      }

      // Echo back (server doesn't mask)
      const response = Buffer.alloc(2 + len);
      response[0] = 0x81; // Text frame
      response[1] = len;
      decoded.copy(response, 2);
      socket.write(response);
    }
  });

  socket.on('close', () => {
    console.log('WebSocket closed');
  });
});

server.listen(8080, '0.0.0.0', () => {
  console.log('WebSocket server listening on port 8080');
});
`;

  // Write the server script
  await sandbox.writeFile('/tmp/ws_server.js', serverScript);

  // Start the server using startProcess (better for long-running processes)
  try {
    await sandbox.startProcess('node /tmp/ws_server.js', {
      processId: 'ws-server-8080'
    });
    console.log('WebSocket server process started');
  } catch (error: any) {
    // Server might already be running, that's okay
    if (!error.message?.includes('already exists')) {
      console.error('Failed to start WebSocket server:', error);
      throw error;
    }
    console.log('WebSocket server already running');
  }

  // Give the server time to start and begin listening
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Check if the process is still running
  try {
    const processes = await sandbox.listProcesses();
    const serverProcess = processes.find(p => p.id === 'ws-server-8080');

    if (!serverProcess || serverProcess.status !== 'running') {
      console.error('WebSocket server process not running:', serverProcess);
      return new Response('WebSocket server failed to start', { status: 503 });
    }

    console.log('WebSocket server process is running:', serverProcess);
  } catch (e) {
    console.error('Failed to check process status:', e);
  }

  // Use connect() to route the incoming WebSocket to port 8080
  // This is a convenient helper that uses switchPort internally
  console.log('Using connect(sandbox, request, 8080) to route WebSocket...');

  try {
    const response = await connect(sandbox, request, 8080);

    console.log('connect() returned status:', response.status);
    console.log('Response headers:', Object.fromEntries(response.headers));

    return response;
  } catch (error: any) {
    console.error('connect() failed:', error);
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    return new Response(`Failed to connect to container WebSocket: ${error.message}`, {
      status: 500
    });
  }
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
    .error { color: #f48771; }
    .success { color: #4ec9b0; }
  </style>
</head>
<body>
  <h1>Sandbox SDK WebSocket Examples</h1>

  <div style="background: #2d2d30; border: 2px solid #4ec9b0; border-radius: 8px; padding: 20px; margin: 20px 0;">
    <h3 style="margin-top: 0; color: #4ec9b0;">Two WebSocket Communication Methods</h3>

    <div style="margin: 15px 0;">
      <p style="color: #4ec9b0; font-weight: bold; margin: 5px 0;">
        <code>createWebSocketHandler()</code> - DO <--> Client with Sandbox Operations
      </p>
      <p style="color: #d4d4d4; margin: 5px 0 5px 25px; font-size: 0.9em;">
        Use this when you want to communicate between the Durable Object and the client,
        performing sandbox operations (run code, start processes, execute commands).
        The DO handles messages and interacts with the sandbox.
      </p>
      <p style="color: #888; margin: 5px 0 5px 25px; font-size: 0.85em;">
        <strong>Examples:</strong> Echo Server, Code Execution, Process Streaming
      </p>
    </div>

    <div style="margin: 15px 0;">
      <p style="color: #ce9178; font-weight: bold; margin: 5px 0;">
        <code>connect(sandbox, request, port)</code> - Route Client -> Container Service
      </p>
      <p style="color: #d4d4d4; margin: 5px 0 5px 25px; font-size: 0.9em;">
        Use this when you have a WebSocket server running inside the container
        (e.g., a Node.js app on port 8080) and want to route incoming client
        WebSocket connections directly to it.
      </p>
      <p style="color: #888; margin: 5px 0 5px 25px; font-size: 0.85em;">
        <strong>Example:</strong> Container WebSocket (routes to Node.js WebSocket server on port 8080)
      </p>
    </div>
  </div>

  <div class="example">
    <h2>1. Echo Server</h2>
    <p style="color: #4ec9b0; font-size: 0.85em; margin: 5px 0; font-weight: bold;">
       Method: <code>createWebSocketHandler()</code> - DO <--> Client with Sandbox Operations
    </p>
    <div id="echo-status" class="status disconnected">Disconnected</div>
    <input type="text" id="echo-input" placeholder="Enter message to echo">
    <button onclick="echoConnect()">Connect</button>
    <button onclick="echoSend()">Send</button>
    <button onclick="echoExecute()">Execute Command</button>
    <button onclick="echoDisconnect()">Disconnect</button>
    <div class="output" id="echo-output"></div>
  </div>

  <div class="example">
    <h2>2. Code Execution</h2>
    <p style="color: #4ec9b0; font-size: 0.85em; margin: 5px 0; font-weight: bold;">
      Method: <code>createWebSocketHandler()</code> - DO <--> Client with Sandbox Operations
    </p>
    <div id="code-status" class="status disconnected">Disconnected</div>
    <textarea id="code-input" rows="6" placeholder="Enter Python code...">import time
for i in range(5):
    print(f'Count: {i}')
    time.sleep(0.5)
print('Done!')</textarea>
    <button onclick="codeConnect()">Connect</button>
    <button onclick="codeExecute()">Execute</button>
    <button onclick="codeReset()">Reset Context</button>
    <button onclick="codeDisconnect()">Disconnect</button>
    <div class="output" id="code-output"></div>
  </div>

  <div class="example">
    <h2>3. Process Streaming</h2>
    <p style="color: #4ec9b0; font-size: 0.85em; margin: 5px 0; font-weight: bold;">
      Method: <code>createWebSocketHandler()</code> - DO <--> Client with Sandbox Operations
    </p>
    <div id="process-status" class="status disconnected">Disconnected</div>
    <input type="text" id="process-cmd" placeholder="Command to run" value="ping -c 5 cloudflare.com">
    <button onclick="processConnect()">Connect</button>
    <button onclick="processStart()">Start Process</button>
    <button onclick="processKill()">Kill Process</button>
    <button onclick="processDisconnect()">Disconnect</button>
    <div class="output" id="process-output"></div>
  </div>

  <div class="example">
    <h2>4. Container WebSocket</h2>
    <p style="color: #ce9178; font-size: 0.85em; margin: 5px 0; font-weight: bold;">
      Method: <code>connect(sandbox, request, port)</code> - Route Client -> Container Service
    </p>
    <p style="color: #d4d4d4; font-size: 0.85em; margin: 5px 0;">
      Routes WebSocket to a Node.js server running on port 8080 inside the container
    </p>
    <div id="container-status" class="status disconnected">Disconnected</div>
    <input type="text" id="container-input" placeholder="Enter message to send">
    <button onclick="containerConnect()">Connect</button>
    <button onclick="containerSend()">Send Message</button>
    <button onclick="containerDisconnect()">Disconnect</button>
    <div class="output" id="container-output"></div>
  </div>

  <script>
    // WebSocket connections
    let echoWs = null;
    let codeWs = null;
    let processWs = null;
    let containerWs = null;

    // Echo Server
    function echoConnect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      echoWs = new WebSocket(protocol + '//' + location.host + '/ws/echo?id=echo-' + Date.now());

      echoWs.onopen = () => {
        document.getElementById('echo-status').textContent = 'Connected';
        document.getElementById('echo-status').className = 'status connected';
        logEcho({ type: 'info', message: 'Connected to echo server' });
      };

      echoWs.onmessage = (event) => {
        logEcho(JSON.parse(event.data));
      };

      echoWs.onclose = () => {
        document.getElementById('echo-status').textContent = 'Disconnected';
        document.getElementById('echo-status').className = 'status disconnected';
        logEcho({ type: 'info', message: 'Disconnected' });
      };
    }

    function echoSend() {
      if (!echoWs) return alert('Not connected');
      const input = document.getElementById('echo-input');
      echoWs.send(JSON.stringify({ type: 'echo', data: input.value }));
      input.value = '';
    }

    function echoExecute() {
      if (!echoWs) return alert('Not connected');
      const cmd = prompt('Enter command:', 'echo "Hello from sandbox"');
      if (cmd) {
        echoWs.send(JSON.stringify({ type: 'execute', command: cmd }));
      }
    }

    function echoDisconnect() {
      if (echoWs) {
        echoWs.close();
        echoWs = null;
      }
    }

    function logEcho(data) {
      const output = document.getElementById('echo-output');
      output.textContent += JSON.stringify(data, null, 2) + '\\n\\n';
      output.scrollTop = output.scrollHeight;
    }

    // Code Execution
    function codeConnect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      codeWs = new WebSocket(protocol + '//' + location.host + '/ws/code?id=code-' + Date.now());

      codeWs.onopen = () => {
        document.getElementById('code-status').textContent = 'Connected';
        document.getElementById('code-status').className = 'status connected';
      };

      codeWs.onmessage = (event) => {
        const data = JSON.parse(event.data);
        logCode(data);
      };

      codeWs.onclose = () => {
        document.getElementById('code-status').textContent = 'Disconnected';
        document.getElementById('code-status').className = 'status disconnected';
      };
    }

    function codeExecute() {
      if (!codeWs) return alert('Not connected');
      const code = document.getElementById('code-input').value;
      const sessionId = 'session-' + Date.now();
      codeWs.send(JSON.stringify({ type: 'execute', code, sessionId }));
      logCode({ type: 'info', message: 'Executing...' });
    }

    function codeReset() {
      if (!codeWs) return alert('Not connected');
      codeWs.send(JSON.stringify({ type: 'reset' }));
    }

    function codeDisconnect() {
      if (codeWs) {
        codeWs.close();
        codeWs = null;
      }
    }

    function logCode(data) {
      const output = document.getElementById('code-output');
      if (data.type === 'stdout' || data.type === 'stderr') {
        output.textContent += data.data;
      } else {
        output.textContent += JSON.stringify(data, null, 2) + '\\n';
      }
      output.scrollTop = output.scrollHeight;
    }

    // Process Streaming
    function processConnect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      processWs = new WebSocket(protocol + '//' + location.host + '/ws/process?id=proc-' + Date.now());

      processWs.onopen = () => {
        document.getElementById('process-status').textContent = 'Connected';
        document.getElementById('process-status').className = 'status connected';
      };

      processWs.onmessage = (event) => {
        const data = JSON.parse(event.data);
        logProcess(data);
      };

      processWs.onclose = () => {
        document.getElementById('process-status').textContent = 'Disconnected';
        document.getElementById('process-status').className = 'status disconnected';
      };
    }

    function processStart() {
      if (!processWs) return alert('Not connected');
      const cmd = document.getElementById('process-cmd').value.split(' ');
      processWs.send(JSON.stringify({
        type: 'start',
        command: cmd[0],
        args: cmd.slice(1)
      }));
    }

    function processKill() {
      if (!processWs) return alert('Not connected');
      processWs.send(JSON.stringify({ type: 'kill' }));
    }

    function processDisconnect() {
      if (processWs) {
        processWs.close();
        processWs = null;
      }
    }

    function logProcess(data) {
      const output = document.getElementById('process-output');
      if (data.type === 'stdout' || data.type === 'stderr') {
        output.textContent += data.data;
      } else {
        output.textContent += JSON.stringify(data, null, 2) + '\\n';
      }
      output.scrollTop = output.scrollHeight;
    }

    // Container WebSocket (using sandbox.connect)
    function containerConnect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = protocol + '//' + location.host + '/ws/container?id=container-' + Date.now();

      logContainer({ type: 'info', message: 'Connecting to: ' + url });
      containerWs = new WebSocket(url);

      containerWs.onopen = () => {
        console.log('Container WebSocket opened');
        document.getElementById('container-status').textContent = 'Connected';
        document.getElementById('container-status').className = 'status connected';
        logContainer({ type: 'info', message: 'Connected to container WebSocket server (via connect on port 8080)' });
      };

      containerWs.onmessage = (event) => {
        console.log('Container WebSocket message:', event.data);
        logContainer({ type: 'received', message: event.data });
      };

      containerWs.onclose = (event) => {
        console.log('Container WebSocket closed:', event.code, event.reason);
        document.getElementById('container-status').textContent = 'Disconnected';
        document.getElementById('container-status').className = 'status disconnected';
        logContainer({ type: 'info', message: 'Disconnected: ' + event.code + ' ' + event.reason });
      };

      containerWs.onerror = (error) => {
        console.error('Container WebSocket error:', error);
        logContainer({ type: 'error', message: 'WebSocket error occurred - check console' });
      };
    }

    function containerSend() {
      if (!containerWs) return alert('Not connected');
      const input = document.getElementById('container-input');
      const message = input.value;
      containerWs.send(message);
      logContainer({ type: 'sent', message: message });
      input.value = '';
    }

    function containerDisconnect() {
      if (containerWs) {
        containerWs.close();
        containerWs = null;
      }
    }

    function logContainer(data) {
      const output = document.getElementById('container-output');
      output.textContent += JSON.stringify(data, null, 2) + '\\n\\n';
      output.scrollTop = output.scrollHeight;
    }
  </script>
</body>
</html>`;
}

export { Sandbox };
