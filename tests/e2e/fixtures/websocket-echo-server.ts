/**
 * Simple WebSocket Echo Server for E2E Testing
 *
 * This server echoes back any messages it receives.
 * Used to validate WebSocket routing through the sandbox infrastructure.
 *
 * Usage: bun run websocket-echo-server.ts <port>
 */

import type { Server, ServerWebSocket } from 'bun';

const port = parseInt(process.argv[2] || '8080', 10);

Bun.serve<undefined>({
  port,
  fetch(req: Request, server: Server<undefined>) {
    // Upgrade HTTP request to WebSocket
    if (server.upgrade(req)) {
      return; // Successfully upgraded
    }
    return new Response('Expected WebSocket', { status: 400 });
  },
  websocket: {
    message(ws: ServerWebSocket<undefined>, message: string | Buffer) {
      // Echo the message back
      ws.send(message);
    },
    open(ws: ServerWebSocket<undefined>) {
      console.log('WebSocket client connected');
    },
    close(ws: ServerWebSocket<undefined>) {
      console.log('WebSocket client disconnected');
    }
  }
});

console.log(`WebSocket echo server listening on port ${port}`);
