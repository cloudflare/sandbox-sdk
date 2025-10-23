/**
 * WebSocket Example for Cloudflare Sandbox SDK
 *
 * This example demonstrates various WebSocket patterns:
 * 1. Basic echo server
 * 2. Real-time code execution
 * 3. Process streaming
 * 4. Interactive terminal
 *
 * IMPORTANT: This example shows Worker → DO → Container WebSocket communication.
 * For connecting to WebSocket servers INSIDE the container, use sandbox.connect()
 * instead of containerFetch. See WEBSOCKET_FIX.md for details.
 *
 * These examples include optional rate limiting and timeout management.
 * Uncomment the rate limiting sections to enable protection.
 */

import { getSandbox, parseSSEStream, Sandbox, type LogEvent } from "@cloudflare/sandbox";

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
      default:
        return new Response("Unknown WebSocket endpoint", { status: 404 });
    }
  },
};

/**
 * Example 1: Basic Echo Server
 * Demonstrates basic WebSocket handling with sandbox execution
 */
async function handleEchoWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  // Get sandbox instance
  const sandboxId = new URL(request.url).searchParams.get("id") || "echo-sandbox";
  const sandbox = getSandbox(env.Sandbox, sandboxId);

  // Accept the connection
  server.accept();

  // Send welcome message
  server.send(
    JSON.stringify({
      type: "connected",
      message: "Echo server connected",
      sandboxId,
    })
  );

  // Handle incoming messages
  server.addEventListener("message", async (event) => {
    try {
      const message = JSON.parse(event.data as string);

      switch (message.type) {
        case "echo":
          // Simple echo back
          server.send(
            JSON.stringify({
              type: "echo",
              data: message.data,
              timestamp: Date.now(),
            })
          );
          break;

        case "execute":
          // Execute a command in the sandbox and echo the result
          const result = await sandbox.exec(message.command);
          server.send(
            JSON.stringify({
              type: "result",
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
            })
          );
          break;

        case "ping":
          server.send(JSON.stringify({ type: "pong" }));
          break;

        default:
          server.send(
            JSON.stringify({
              type: "error",
              message: "Unknown message type",
            })
          );
      }
    } catch (error: any) {
      server.send(
        JSON.stringify({
          type: "error",
          message: error.message,
        })
      );
    }
  });

  server.addEventListener("close", () => {
    console.log("WebSocket closed");
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

/**
 * Example 2: Real-Time Code Execution
 * Executes Python/JavaScript code and streams output
 */
async function handleCodeExecutionWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  const sandboxId =
    new URL(request.url).searchParams.get("id") || "code-interpreter";
  const sandbox = getSandbox(env.Sandbox, sandboxId);

  server.accept();

  // Create persistent code context
  let context: any = null;

  server.send(
    JSON.stringify({
      type: "ready",
      message: "Code interpreter ready",
    })
  );

  server.addEventListener("message", async (event) => {
    try {
      const message = JSON.parse(event.data as string);

      if (message.type === "execute") {
        const { code, language = "python", sessionId } = message;

        // Send acknowledgment
        server.send(
          JSON.stringify({
            type: "executing",
            sessionId,
          })
        );

        // Create context if needed
        if (!context) {
          context = await sandbox.createCodeContext({ language });
        }

        // Execute with streaming callbacks
        const execution = await sandbox.runCode(code, {
          context,
          onStdout: (output) => {
            server.send(
              JSON.stringify({
                type: "stdout",
                data: output.text,
                sessionId,
              })
            );
          },
          onStderr: (output) => {
            server.send(
              JSON.stringify({
                type: "stderr",
                data: output.text,
                sessionId,
              })
            );
          },
        });

        // Send final results
        server.send(
          JSON.stringify({
            type: "result",
            sessionId,
            results: execution.results,
            error: execution.error,
            logs: execution.logs,
          })
        );
      } else if (message.type === "reset") {
        // Reset the code context
        context = null;
        server.send(
          JSON.stringify({
            type: "reset",
            message: "Context reset",
          })
        );
      }
    } catch (error: any) {
      server.send(
        JSON.stringify({
          type: "error",
          message: error.message,
        })
      );
    }
  });

  server.addEventListener("close", async () => {
    // Clean up context
    if (context && context.cleanup) {
      await context.cleanup();
    }
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

/**
 * Example 3: Process Output Streaming
 * Starts a long-running process and streams its output
 */
async function handleProcessStreamWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  const sandboxId =
    new URL(request.url).searchParams.get("id") || "process-stream";
  const sandbox = getSandbox(env.Sandbox, sandboxId);

  server.accept();

  let currentProcess: any = null;

  server.send(
    JSON.stringify({
      type: "ready",
      message: "Process streamer ready",
    })
  );

  server.addEventListener("message", async (event) => {
    try {
      const message = JSON.parse(event.data as string);

      if (message.type === "start") {
        const { command, args = [] } = message;

        // Build full command string
        const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;

        // Start the process
        currentProcess = await sandbox.startProcess(fullCommand);

        server.send(
          JSON.stringify({
            type: "started",
            pid: currentProcess.pid,
          })
        );

        // Stream logs in the background
        (async () => {
          try {
            const logStream = await sandbox.streamProcessLogs(currentProcess.id);

            for await (const event of parseSSEStream<LogEvent>(logStream)) {
              if (event.type === "stdout" || event.type === "stderr") {
                server.send(
                  JSON.stringify({
                    type: event.type,
                    data: event.data,
                    pid: currentProcess.pid,
                  })
                );
              }
            }

            // Process completed
            server.send(
              JSON.stringify({
                type: "completed",
                pid: currentProcess.pid,
              })
            );
          } catch (error: any) {
            server.send(
              JSON.stringify({
                type: "error",
                message: error.message,
              })
            );
          }
        })();
      } else if (message.type === "kill" && currentProcess) {
        await sandbox.killProcess(currentProcess.id);
        server.send(
          JSON.stringify({
            type: "killed",
            pid: currentProcess.pid,
          })
        );
        currentProcess = null;
      }
    } catch (error: any) {
      server.send(
        JSON.stringify({
          type: "error",
          message: error.message,
        })
      );
    }
  });

  server.addEventListener("close", async () => {
    if (currentProcess) {
      try {
        await sandbox.killProcess(currentProcess.id);
      } catch {
        // Process might already be done
      }
    }
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

/**
 * Example 4: Interactive Terminal
 * Provides a full interactive shell session
 */
async function handleTerminalWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  const sandboxId =
    new URL(request.url).searchParams.get("id") || "terminal-session";
  const sandbox = getSandbox(env.Sandbox, sandboxId);

  server.accept();

  // Start an interactive bash shell
  const shell = await sandbox.startProcess("/bin/bash -i", {
    env: {
      TERM: "xterm-256color",
      PS1: "\\[\\033[01;32m\\]sandbox\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]$ ",
    },
  });

  server.send(
    JSON.stringify({
      type: "ready",
      pid: shell.pid,
      message: "Terminal connected",
    })
  );

  // Stream shell output to client
  (async () => {
    try {
      const logStream = await sandbox.streamProcessLogs(shell.id);

      for await (const event of parseSSEStream<LogEvent>(logStream)) {
        if (event.type === "stdout") {
          // Send raw output for terminal rendering
          server.send(event.data);
        }
      }

      // Shell exited
      server.send(
        JSON.stringify({
          type: "exit",
          message: "Shell process exited",
        })
      );
      server.close(1000, "Shell exited");
    } catch (error: any) {
      server.send(
        JSON.stringify({
          type: "error",
          message: error.message,
        })
      );
      server.close(1011, "Error");
    }
  })();

  // Send client input to shell
  server.addEventListener("message", async (event) => {
    try {
      const input = event.data as string;

      // Handle special commands
      if (input.startsWith("{")) {
        const command = JSON.parse(input);

        if (command.type === "resize") {
          // Handle terminal resize (would need TTY support)
          // For now, just acknowledge
          server.send(
            JSON.stringify({
              type: "resized",
              rows: command.rows,
              cols: command.cols,
            })
          );
        }
      } else {
        // Regular input - send to shell stdin
        // Note: This requires implementing sendToProcess in the sandbox
        // await sandbox.sendToProcess(shell.pid, input);

        // For now, we'll use a workaround by executing each line
        if (input.includes('\n')) {
          const result = await sandbox.exec(input.trim());
          server.send(result.stdout + result.stderr);
        }
      }
    } catch (error: any) {
      server.send(
        JSON.stringify({
          type: "error",
          message: error.message,
        })
      );
    }
  });

  server.addEventListener("close", async () => {
    try {
      await sandbox.killProcess(shell.id);
    } catch {
      // Process might already be done
    }
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

/**
 * Example 5: Protected WebSocket with Rate Limiting & Timeouts
 * Demonstrates production-ready WebSocket with security features
 */
async function handleProtectedWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  const sandboxId =
    new URL(request.url).searchParams.get("id") || "protected-session";
  const sandbox = getSandbox(env.Sandbox, sandboxId);

  server.accept();

  // Rate limiting state (in production, store this in Durable Object storage)
  const rateLimitState = {
    messages: [] as number[],
    maxMessages: 100,
    windowMs: 60000, // 1 minute
    maxMessageSize: 1024 * 1024, // 1MB
  };

  // Timeout state
  let idleTimeout: number;
  let maxConnectionTimeout: number;
  let heartbeatInterval: number;
  let lastActivity = Date.now();

  // Heartbeat mechanism
  heartbeatInterval = setInterval(() => {
    const timeSinceActivity = Date.now() - lastActivity;
    if (timeSinceActivity > 300000) {
      // 5 minutes idle
      server.close(1000, "Idle timeout");
      clearAllTimers();
      return;
    }
    try {
      server.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
    } catch (error) {
      console.error("Failed to send heartbeat:", error);
    }
  }, 30000); // Ping every 30 seconds

  // Max connection time
  maxConnectionTimeout = setTimeout(() => {
    server.send(
      JSON.stringify({ type: "info", message: "Maximum connection time reached" })
    );
    server.close(1000, "Maximum connection time reached");
    clearAllTimers();
  }, 1800000); // 30 minutes

  // Idle timeout reset function
  const resetIdleTimeout = () => {
    lastActivity = Date.now();
    if (idleTimeout) clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => {
      server.close(1000, "Idle timeout");
      clearAllTimers();
    }, 300000); // 5 minutes
  };

  // Initial idle timeout
  resetIdleTimeout();

  // Send welcome with limits info
  server.send(
    JSON.stringify({
      type: "connected",
      message: "Protected WebSocket connected",
      sandboxId,
      limits: {
        maxMessages: rateLimitState.maxMessages,
        windowMs: rateLimitState.windowMs,
        maxMessageSize: rateLimitState.maxMessageSize,
        idleTimeout: 300000,
        maxConnectionTime: 1800000,
      },
    })
  );

  // Handle incoming messages
  server.addEventListener("message", async (event) => {
    try {
      // Reset idle timer on activity
      resetIdleTimeout();

      // Rate limiting check
      const now = Date.now();
      const messageSize = new Blob([event.data as string]).size;

      // Check message size
      if (messageSize > rateLimitState.maxMessageSize) {
        server.send(
          JSON.stringify({
            type: "error",
            code: "RATE_LIMIT_EXCEEDED",
            message: `Message size ${messageSize} exceeds limit of ${rateLimitState.maxMessageSize} bytes`,
          })
        );
        return;
      }

      // Clean old timestamps
      rateLimitState.messages = rateLimitState.messages.filter(
        (timestamp) => now - timestamp < rateLimitState.windowMs
      );

      // Check rate limit
      if (rateLimitState.messages.length >= rateLimitState.maxMessages) {
        server.send(
          JSON.stringify({
            type: "error",
            code: "RATE_LIMIT_EXCEEDED",
            message: `Rate limit exceeded: ${rateLimitState.maxMessages} messages per ${rateLimitState.windowMs}ms`,
            remaining: 0,
          })
        );
        return;
      }

      // Record this message
      rateLimitState.messages.push(now);

      const message = JSON.parse(event.data as string);

      // Handle pong for heartbeat
      if (message.type === "pong") {
        return; // Just acknowledge, don't process
      }

      // Send rate limit info with response
      const remaining = rateLimitState.maxMessages - rateLimitState.messages.length;

      switch (message.type) {
        case "echo":
          server.send(
            JSON.stringify({
              type: "echo",
              data: message.data,
              rateLimit: { remaining },
              timestamp: Date.now(),
            })
          );
          break;

        case "execute":
          const result = await sandbox.exec(message.command);
          server.send(
            JSON.stringify({
              type: "result",
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              rateLimit: { remaining },
            })
          );
          break;

        case "status":
          server.send(
            JSON.stringify({
              type: "status",
              connected: true,
              sandboxId,
              rateLimit: {
                messagesInWindow: rateLimitState.messages.length,
                maxMessages: rateLimitState.maxMessages,
                remaining,
              },
              timeout: {
                timeSinceActivity: Date.now() - lastActivity,
                idleTimeoutRemaining: Math.max(0, 300000 - (Date.now() - lastActivity)),
              },
            })
          );
          break;

        default:
          server.send(
            JSON.stringify({
              type: "error",
              message: "Unknown message type",
            })
          );
      }
    } catch (error: any) {
      server.send(
        JSON.stringify({
          type: "error",
          message: error.message,
        })
      );
    }
  });

  function clearAllTimers() {
    if (idleTimeout) clearTimeout(idleTimeout);
    if (maxConnectionTimeout) clearTimeout(maxConnectionTimeout);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
  }

  server.addEventListener("close", () => {
    console.log("Protected WebSocket closed");
    clearAllTimers();
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
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

  <div class="example">
    <h2>1. Echo Server</h2>
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
    <div id="process-status" class="status disconnected">Disconnected</div>
    <input type="text" id="process-cmd" placeholder="Command to run" value="ping -c 5 cloudflare.com">
    <button onclick="processConnect()">Connect</button>
    <button onclick="processStart()">Start Process</button>
    <button onclick="processKill()">Kill Process</button>
    <button onclick="processDisconnect()">Disconnect</button>
    <div class="output" id="process-output"></div>
  </div>

  <script>
    // WebSocket connections
    let echoWs = null;
    let codeWs = null;
    let processWs = null;

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
  </script>
</body>
</html>`;
}

export { Sandbox };
