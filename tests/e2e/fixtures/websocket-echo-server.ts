/**
 * Simple WebSocket Echo Server for E2E Testing
 *
 * This server echoes back any messages it receives.
 * Used to validate WebSocket routing through the sandbox infrastructure.
 *
 * Usage: bun run websocket-echo-server.ts <port>
 */

const port = parseInt(process.argv[2] || '8080', 10);

Bun.serve({
  port,
  fetch(req, server) {
    // Upgrade HTTP request to WebSocket
    if (server.upgrade(req)) {
      return; // Successfully upgraded
    }
    return new Response('Expected WebSocket', { status: 400 });
  },
  websocket: {
    message(ws, message) {
      // Echo the message back
      ws.send(message);
    },
    open(ws) {
      console.log('WebSocket client connected');
    },
    close(ws) {
      console.log('WebSocket client disconnected');
    },
  },
});

console.log(`WebSocket echo server listening on port ${port}`);
