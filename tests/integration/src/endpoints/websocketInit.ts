import type { Sandbox } from '@cloudflare/sandbox';
import { errorResponse, jsonResponse } from '../http';

// Minimal WebSocket echo server script using Bun
const ECHO_SERVER_SCRIPT = `
const port = 8080;

Bun.serve({
  port,
  fetch(req, server) {
    const upgradeHeader = req.headers.get("Upgrade");
    if (upgradeHeader === "websocket") {
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }
    return new Response("WebSocket server running on port " + port, { status: 200 });
  },
  websocket: {
    open(ws) {
      console.log("WebSocket connection opened");
    },
    message(ws, message) {
      // Echo the message back
      ws.send(message);
    },
    close(ws) {
      console.log("WebSocket connection closed");
    },
  },
});

console.log("WebSocket echo server listening on port " + port);
`.trim();

export async function initializeWebSocketServer(sandbox: Sandbox<unknown>) {
  try {
    const processId = 'ws-echo-8080';

    // Check if server is already running
    const processes = await sandbox.listProcesses();
    const existingProcess = processes.find((p) => p.id === processId);

    if (existingProcess) {
      return jsonResponse({
        message: 'WebSocket server already running',
        port: 8080,
        processId
      });
    }

    // Write the echo server script
    await sandbox.writeFile('/tmp/ws-echo.ts', ECHO_SERVER_SCRIPT);

    // Start the server as a background process
    await sandbox.startProcess('bun run /tmp/ws-echo.ts', {
      processId,
      cwd: '/tmp'
    });

    // Give the server a moment to start
    await new Promise((resolve) => setTimeout(resolve, 500));

    return jsonResponse({
      message: 'WebSocket echo server initialized',
      port: 8080,
      processId,
      endpoint: '/ws/echo'
    });
  } catch (error: any) {
    console.error('Failed to initialize WebSocket server:', error);
    return errorResponse(
      `Failed to initialize WebSocket server: ${error.message}`,
      500
    );
  }
}
