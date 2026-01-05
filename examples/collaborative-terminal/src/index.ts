/**
 * Collaborative Terminal - "Google Docs for Bash"
 *
 * This example demonstrates how to build a multi-user terminal where:
 * - Multiple users can connect to the same PTY session
 * - Everyone sees the same terminal output in real-time
 * - Users can take turns sending commands
 * - Presence indicators show who's connected
 *
 * Architecture:
 * - A separate Room Durable Object manages collaboration/presence
 * - The Room DO uses getSandbox() to interact with a shared Sandbox
 * - PTY I/O uses WebSocket connection to container for low latency
 */

import { getSandbox, Sandbox } from '@cloudflare/sandbox';

// Re-export Sandbox for wrangler
export { Sandbox };

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  Room: DurableObjectNamespace;
}

// User info for presence
interface UserInfo {
  id: string;
  name: string;
  color: string;
}

// Client connection
interface ClientConnection {
  ws: WebSocket;
  info: UserInfo;
}

// Generate random user color
function randomColor(): string {
  const colors = [
    '#FF6B6B',
    '#4ECDC4',
    '#45B7D1',
    '#96CEB4',
    '#FFEAA7',
    '#DDA0DD',
    '#98D8C8',
    '#F7DC6F',
    '#BB8FCE',
    '#85C1E9'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

// Room Durable Object - handles collaboration/presence separately from Sandbox
export class Room implements DurableObject {
  private clients: Map<string, ClientConnection> = new Map();
  private ptyId: string | null = null;
  private outputBuffer: string[] = [];
  private containerWs: WebSocket | null = null;
  private roomId: string = '';
  private env: Env;

  constructor(
    private ctx: DurableObjectState,
    env: Env
  ) {
    this.env = env;
  }

  // Get all connected users
  private getConnectedUsers(): UserInfo[] {
    return Array.from(this.clients.values()).map((c) => c.info);
  }

  // Broadcast to all connected WebSockets
  private broadcast(message: object, excludeUserId?: string): void {
    const data = JSON.stringify(message);
    for (const [userId, client] of this.clients) {
      if (userId !== excludeUserId) {
        try {
          client.ws.send(data);
        } catch {
          // Client disconnected
        }
      }
    }
  }

  // Handle PTY start
  private async startPty(
    ws: WebSocket,
    cols: number,
    rows: number
  ): Promise<void> {
    if (this.ptyId) {
      // PTY already exists
      ws.send(JSON.stringify({ type: 'pty_started', ptyId: this.ptyId }));
      return;
    }

    try {
      console.log(`[Room ${this.roomId}] Creating PTY...`);

      // Get sandbox instance using helper
      const sandbox = getSandbox(this.env.Sandbox, `shared-sandbox`);

      // Colored prompt
      const PS1 =
        '\\[\\e[38;5;39m\\]\\u\\[\\e[0m\\]@\\[\\e[38;5;208m\\]sandbox\\[\\e[0m\\] \\[\\e[38;5;41m\\]\\w\\[\\e[0m\\] \\[\\e[38;5;208m\\]❯\\[\\e[0m\\] ';

      // Create PTY session
      // Use --norc --noprofile but run with 'set -m' to enable job control for Ctrl+C
      const ptyInfo = await sandbox.createPty({
        cols: cols || 80,
        rows: rows || 24,
        command: ['/bin/bash', '--norc', '--noprofile'],
        cwd: '/home/user',
        env: {
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          LANG: 'en_US.UTF-8',
          HOME: '/home/user',
          USER: 'user',
          PS1,
          ROOM_ID: this.roomId,
          CLICOLOR: '1',
          CLICOLOR_FORCE: '1',
          FORCE_COLOR: '3',
          LS_COLORS:
            'di=1;34:ln=1;36:so=1;35:pi=33:ex=1;32:bd=1;33:cd=1;33:su=1:sg=1:tw=1:ow=1;34',
          // Enable job control
          BASH_ENV: ''
        }
      });

      console.log(`[Room ${this.roomId}] PTY created: ${ptyInfo.id}`);
      this.ptyId = ptyInfo.id;

      // Establish WebSocket connection to container for PTY streaming
      console.log(`[Room ${this.roomId}] Connecting to container WebSocket...`);
      const wsRequest = new Request('http://container/ws', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade'
        }
      });
      const wsResponse = await sandbox.fetch(wsRequest);

      if (!wsResponse.webSocket) {
        throw new Error(
          'Failed to establish WebSocket connection to container'
        );
      }
      this.containerWs = wsResponse.webSocket;
      this.containerWs.accept();
      console.log(`[Room ${this.roomId}] Container WebSocket connected`);

      // Forward PTY output to all browser clients
      this.containerWs.addEventListener('message', (wsEvent) => {
        try {
          const containerMsg = JSON.parse(wsEvent.data as string);
          if (containerMsg.type === 'stream' && containerMsg.data) {
            const streamData = JSON.parse(containerMsg.data);
            if (streamData.type === 'pty_data' && streamData.data) {
              this.outputBuffer.push(streamData.data);
              if (this.outputBuffer.length > 1000) {
                this.outputBuffer.shift();
              }
              this.broadcast({ type: 'pty_output', data: streamData.data });
            } else if (streamData.type === 'pty_exit') {
              this.broadcast({
                type: 'pty_exit',
                exitCode: streamData.exitCode
              });
              this.ptyId = null;
              this.containerWs?.close();
              this.containerWs = null;
            }
          }
        } catch (e) {
          console.error(
            `[Room ${this.roomId}] Container message parse error:`,
            e
          );
        }
      });

      this.containerWs.addEventListener('error', (e) => {
        console.error(`[Room ${this.roomId}] Container WS error:`, e);
      });

      this.containerWs.addEventListener('close', () => {
        console.log(`[Room ${this.roomId}] Container WS closed`);
        this.containerWs = null;
      });

      // Subscribe to PTY output stream
      this.containerWs.send(
        JSON.stringify({
          type: 'request',
          id: `pty_stream_${ptyInfo.id}`,
          method: 'GET',
          path: `/api/pty/${ptyInfo.id}/stream`,
          headers: { Accept: 'text/event-stream' }
        })
      );

      // Broadcast pty_started to all clients
      console.log(`[Room ${this.roomId}] Broadcasting pty_started`);
      this.broadcast({ type: 'pty_started', ptyId: ptyInfo.id });
    } catch (error) {
      console.error(`[Room ${this.roomId}] PTY create error:`, error);
      ws.send(
        JSON.stringify({
          type: 'error',
          message:
            error instanceof Error ? error.message : 'Failed to create PTY'
        })
      );
    }
  }

  // Handle client message
  private handleClientMessage(
    userId: string,
    ws: WebSocket,
    data: string
  ): void {
    const client = this.clients.get(userId);
    if (!client) return;

    try {
      const msg = JSON.parse(data) as {
        type: string;
        data?: string;
        cols?: number;
        rows?: number;
      };

      console.log(
        `[Room ${this.roomId}] Client message: ${msg.type}`,
        msg.type === 'pty_input' ? `data length: ${msg.data?.length}` : ''
      );

      switch (msg.type) {
        case 'start_pty':
          this.startPty(ws, msg.cols || 80, msg.rows || 24);
          break;

        case 'pty_input':
          if (this.ptyId && this.containerWs && msg.data) {
            // Debug: log control characters
            if (msg.data.charCodeAt(0) < 32) {
              console.log(
                `[Room ${this.roomId}] Sending control char to container: ${msg.data.charCodeAt(0)} (0x${msg.data.charCodeAt(0).toString(16)})`
              );
            }
            this.containerWs.send(
              JSON.stringify({
                type: 'pty_input',
                ptyId: this.ptyId,
                data: msg.data
              })
            );
            this.broadcast({ type: 'user_typing', user: client.info }, userId);
          } else {
            console.log(
              `[Room ${this.roomId}] Cannot send pty_input: ptyId=${this.ptyId}, containerWs=${!!this.containerWs}, data=${!!msg.data}`
            );
          }
          break;

        case 'pty_resize':
          if (this.ptyId && this.containerWs && msg.cols && msg.rows) {
            this.containerWs.send(
              JSON.stringify({
                type: 'pty_resize',
                ptyId: this.ptyId,
                cols: msg.cols,
                rows: msg.rows
              })
            );
          }
          break;
      }
    } catch (error) {
      console.error(`[Room ${this.roomId}] Message error:`, error);
    }
  }

  // Handle client disconnect
  private handleClientDisconnect(userId: string): void {
    this.clients.delete(userId);
    this.broadcast({
      type: 'user_left',
      userId,
      users: this.getConnectedUsers()
    });
  }

  // Handle incoming requests
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const userName =
        url.searchParams.get('name') ||
        `User-${Math.random().toString(36).slice(2, 6)}`;
      this.roomId = url.searchParams.get('roomId') || 'default';

      // Create WebSocket pair
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      // Create user info
      const userId = crypto.randomUUID();
      const userInfo: UserInfo = {
        id: userId,
        name: userName,
        color: randomColor()
      };

      // Store client
      this.clients.set(userId, { ws: server, info: userInfo });

      // Set up event handlers
      server.addEventListener('message', (event) => {
        this.handleClientMessage(userId, server, event.data as string);
      });

      server.addEventListener('close', () => {
        this.handleClientDisconnect(userId);
      });

      server.addEventListener('error', () => {
        this.handleClientDisconnect(userId);
      });

      // Send initial state
      server.send(
        JSON.stringify({
          type: 'connected',
          userId,
          userName: userInfo.name,
          userColor: userInfo.color,
          users: this.getConnectedUsers(),
          hasActivePty: this.ptyId !== null,
          ptyId: this.ptyId,
          history: this.outputBuffer.join('')
        })
      );

      // Notify others
      this.broadcast(
        {
          type: 'user_joined',
          user: userInfo,
          users: this.getConnectedUsers()
        },
        userId
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // API: Create a new room
    if (url.pathname === '/api/room' && request.method === 'POST') {
      const roomId = crypto.randomUUID().slice(0, 8);
      return Response.json({
        roomId,
        joinUrl: `${url.origin}?room=${roomId}`
      });
    }

    // WebSocket: Connect to terminal room
    if (url.pathname.startsWith('/ws/room/')) {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const roomId = url.pathname.split('/')[3];
      const userName = url.searchParams.get('name') || 'Anonymous';

      // Get Room DO for this room
      const id = env.Room.idFromName(`room-${roomId}`);
      const room = env.Room.get(id);

      // Forward WebSocket request to Room DO
      const wsUrl = new URL(request.url);
      wsUrl.searchParams.set('roomId', roomId);
      wsUrl.searchParams.set('name', userName);

      return room.fetch(new Request(wsUrl.toString(), request));
    }

    // Serve static files (handled by assets binding)
    return new Response('Not found', { status: 404 });
  }
};
