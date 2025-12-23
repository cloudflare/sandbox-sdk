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
 * - Each terminal room is backed by a single Sandbox Durable Object
 * - Users connect via WebSocket for commands and presence
 * - PTY I/O uses WebSocket connection to container for low latency
 */

import { getSandbox, Sandbox } from '@cloudflare/sandbox';

export { Sandbox };

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

// User info for presence
interface UserInfo {
  id: string;
  name: string;
  color: string;
}

// Connected WebSocket with user info
interface ConnectedClient {
  ws: WebSocket;
  info: UserInfo;
}

// Room state with container WebSocket for low-latency PTY I/O
interface RoomState {
  clients: Map<string, ConnectedClient>;
  ptyId: string | null;
  outputBuffer: string[];
  // WebSocket connection to container for PTY messages
  containerWs: WebSocket | null;
}

// Room registry
const rooms = new Map<string, RoomState>();

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

// Broadcast to all clients in a room
function broadcast(
  roomId: string,
  message: object,
  excludeUserId?: string
): void {
  const room = rooms.get(roomId);
  if (!room) return;

  const data = JSON.stringify(message);
  for (const [userId, client] of room.clients) {
    if (userId !== excludeUserId) {
      try {
        client.ws.send(data);
      } catch {
        // Client disconnected
      }
    }
  }
}

// Get user list for a room
function getUserList(roomId: string): UserInfo[] {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.clients.values()).map((c) => c.info);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // API: Create or join a terminal room
    if (url.pathname === '/api/room' && request.method === 'POST') {
      const body = (await request.json()) as { roomId?: string };
      const roomId = body.roomId || crypto.randomUUID().slice(0, 8);

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          clients: new Map(),
          ptyId: null,
          outputBuffer: [],
          containerWs: null
        });
      }

      return Response.json({
        roomId,
        joinUrl: `${url.origin}?room=${roomId}`
      });
    }

    // API: Get room info
    if (url.pathname.startsWith('/api/room/') && request.method === 'GET') {
      const roomId = url.pathname.split('/')[3];
      const room = rooms.get(roomId);

      if (!room) {
        return Response.json({ error: 'Room not found' }, { status: 404 });
      }

      return Response.json({
        roomId,
        users: getUserList(roomId),
        hasActivePty: room.ptyId !== null,
        ptyId: room.ptyId
      });
    }

    // WebSocket: Connect to terminal room
    if (url.pathname.startsWith('/ws/room/')) {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const roomId = url.pathname.split('/')[3];
      const userName =
        url.searchParams.get('name') ||
        `User-${Math.random().toString(36).slice(2, 6)}`;

      // Get or create room state
      let room = rooms.get(roomId);
      if (!room) {
        room = {
          clients: new Map(),
          ptyId: null,
          outputBuffer: [],
          containerWs: null
        };
        rooms.set(roomId, room);
      }

      // Create WebSocket pair
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      // Create user
      const userId = crypto.randomUUID();
      const userInfo: UserInfo = {
        id: userId,
        name: userName,
        color: randomColor()
      };

      // Add client to room
      room.clients.set(userId, { ws: server, info: userInfo });

      // Send initial state
      server.send(
        JSON.stringify({
          type: 'connected',
          userId,
          userName: userInfo.name,
          userColor: userInfo.color,
          users: getUserList(roomId),
          hasActivePty: room.ptyId !== null,
          ptyId: room.ptyId,
          history: room.outputBuffer.join('')
        })
      );

      // Notify others
      broadcast(
        roomId,
        {
          type: 'user_joined',
          user: userInfo,
          users: getUserList(roomId)
        },
        userId
      );

      // Handle messages
      server.addEventListener('message', async (event) => {
        try {
          const message = JSON.parse(event.data as string) as {
            type: string;
            data?: string;
            cols?: number;
            rows?: number;
          };

          // Get fresh sandbox reference
          const sandbox = getSandbox(env.Sandbox, `collab-terminal-${roomId}`);

          switch (message.type) {
            case 'start_pty':
              if (!room.ptyId) {
                try {
                  console.log('[Room] Creating PTY...');

                  // Nice zsh-style colored prompt
                  const PS1 =
                    '\\[\\e[38;5;39m\\]\\u\\[\\e[0m\\]@\\[\\e[38;5;208m\\]sandbox\\[\\e[0m\\] \\[\\e[38;5;41m\\]\\w\\[\\e[0m\\] \\[\\e[38;5;208m\\]❯\\[\\e[0m\\] ';

                  // Use createPty() which is available via RPC
                  const ptyInfo = await sandbox.createPty({
                    cols: message.cols || 80,
                    rows: message.rows || 24,
                    command: ['/bin/bash', '--norc', '--noprofile'],
                    cwd: '/home/user',
                    env: {
                      TERM: 'xterm-256color',
                      COLORTERM: 'truecolor',
                      LANG: 'en_US.UTF-8',
                      HOME: '/home/user',
                      USER: 'user',
                      PS1,
                      CLICOLOR: '1',
                      CLICOLOR_FORCE: '1',
                      FORCE_COLOR: '3',
                      LS_COLORS:
                        'di=1;34:ln=1;36:so=1;35:pi=33:ex=1;32:bd=1;33:cd=1;33:su=1;31:sg=1;31:tw=1:ow=1;34'
                    }
                  });

                  console.log('[Room] PTY created:', ptyInfo.id);
                  room.ptyId = ptyInfo.id;

                  // Establish WebSocket connection to container for low-latency PTY I/O
                  // Use fetch() with WebSocket upgrade - routes to container's /ws endpoint
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
                  room.containerWs = wsResponse.webSocket;
                  room.containerWs.accept();

                  // Forward PTY output from container to all browser clients
                  room.containerWs.addEventListener('message', (event) => {
                    try {
                      const msg = JSON.parse(event.data as string);
                      // Handle stream chunks from the PTY stream subscription
                      // The SSE data is JSON-encoded inside msg.data
                      if (msg.type === 'stream' && msg.data) {
                        const streamData = JSON.parse(msg.data);
                        if (streamData.type === 'pty_data' && streamData.data) {
                          // Buffer for history
                          room.outputBuffer.push(streamData.data);
                          // Keep buffer limited
                          if (room.outputBuffer.length > 1000) {
                            room.outputBuffer.shift();
                          }
                          broadcast(roomId, {
                            type: 'pty_output',
                            data: streamData.data
                          });
                        } else if (streamData.type === 'pty_exit') {
                          broadcast(roomId, {
                            type: 'pty_exit',
                            exitCode: streamData.exitCode
                          });
                          room.ptyId = null;
                          room.containerWs?.close();
                          room.containerWs = null;
                        }
                      }
                    } catch {
                      // Ignore parse errors
                    }
                  });

                  // Subscribe to PTY output stream via WebSocket protocol
                  // This sends a GET request to /api/pty/:id/stream which triggers SSE streaming over WS
                  const streamRequestId = `pty_stream_${ptyInfo.id}`;
                  room.containerWs.send(
                    JSON.stringify({
                      type: 'request',
                      id: streamRequestId,
                      method: 'GET',
                      path: `/api/pty/${ptyInfo.id}/stream`,
                      headers: { Accept: 'text/event-stream' }
                    })
                  );

                  // Tell all clients PTY started (no stream URL needed - output comes via WebSocket)
                  broadcast(roomId, {
                    type: 'pty_started',
                    ptyId: ptyInfo.id
                  });
                } catch (error) {
                  console.error('[Room] PTY create error:', error);
                  server.send(
                    JSON.stringify({
                      type: 'error',
                      message:
                        error instanceof Error
                          ? error.message
                          : 'Failed to create PTY'
                    })
                  );
                }
              } else {
                // PTY already exists - notify client
                server.send(
                  JSON.stringify({
                    type: 'pty_started',
                    ptyId: room.ptyId
                  })
                );
              }
              break;

            case 'pty_input':
              // Send PTY input via WebSocket for low latency (fire-and-forget)
              if (room.ptyId && room.containerWs && message.data) {
                room.containerWs.send(
                  JSON.stringify({
                    type: 'pty_input',
                    ptyId: room.ptyId,
                    data: message.data
                  })
                );
                broadcast(
                  roomId,
                  { type: 'user_typing', user: userInfo },
                  userId
                );
              }
              break;

            case 'pty_resize':
              // Send PTY resize via WebSocket for low latency (fire-and-forget)
              if (
                room.ptyId &&
                room.containerWs &&
                message.cols &&
                message.rows
              ) {
                room.containerWs.send(
                  JSON.stringify({
                    type: 'pty_resize',
                    ptyId: room.ptyId,
                    cols: message.cols,
                    rows: message.rows
                  })
                );
              }
              break;
          }
        } catch (error) {
          console.error('[Room] Message error:', error);
        }
      });

      // Handle disconnect
      server.addEventListener('close', () => {
        room.clients.delete(userId);
        broadcast(roomId, {
          type: 'user_left',
          userId,
          users: getUserList(roomId)
        });

        // Clean up empty rooms
        if (room.clients.size === 0) {
          setTimeout(() => {
            const currentRoom = rooms.get(roomId);
            if (currentRoom && currentRoom.clients.size === 0) {
              // Close container WebSocket when room is empty
              currentRoom.containerWs?.close();
              rooms.delete(roomId);
            }
          }, 30000);
        }
      });

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    // Serve static files
    return new Response('Not found', { status: 404 });
  }
};
