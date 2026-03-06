const server = Bun.serve({
  port: 8080,

  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response('WebSocket server running', { status: 200 });
  },

  websocket: {
    open(ws) {
      console.log('Client connected');
    },

    message(ws, message) {
      console.log(`Received: ${message}`);
      if (message === 'ping') {
        ws.send('pong');
        console.log('Sent: pong');
      } else if (message === 'pong') {
        ws.send('ping');
        console.log('Sent: ping');
      }
    },

    close(ws) {
      console.log('Client disconnected');
    }
  }
});

console.log(`WebSocket server listening on port ${server.port}`);
