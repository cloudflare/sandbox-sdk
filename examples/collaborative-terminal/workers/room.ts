import { DurableObject } from 'cloudflare:workers';
import type {
  ClientMessage,
  RoomInfo,
  ServerMessage,
  User
} from './types/protocol';

const USER_COLORS = [
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#f43f5e'
];

interface Client {
  socket: WebSocket;
  user: User;
}

export class Room extends DurableObject<Env> {
  private clients = new Map<string, Client>();
  private roomId = '';
  private sessionId = '';

  private getUsers(): User[] {
    return Array.from(this.clients.values()).map((c) => c.user);
  }

  private getRoomInfo(): RoomInfo {
    return { roomId: this.roomId, sessionId: this.sessionId };
  }

  private broadcast(message: ServerMessage, excludeUserId?: string): void {
    const data = JSON.stringify(message);
    for (const [id, client] of this.clients) {
      if (id !== excludeUserId && client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(data);
      }
    }
  }

  private pickColor(): string {
    const usedColors = new Set(
      Array.from(this.clients.values()).map((c) => c.user.color)
    );
    const available = USER_COLORS.filter((c) => !usedColors.has(c));
    const pool = available.length > 0 ? available : USER_COLORS;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private handleClientMessage(userId: string, data: string): void {
    try {
      const message = JSON.parse(data) as ClientMessage;

      if (message.type === 'typing') {
        this.broadcast({ type: 'user_typing', userId }, userId);
      }
    } catch {}
  }

  private handleClientDisconnect(userId: string): void {
    const client = this.clients.get(userId);
    if (!client) return;

    this.clients.delete(userId);
    this.broadcast({
      type: 'user_left',
      userId,
      users: this.getUsers()
    });
    this.ctx.waitUntil(this.notifyRegistry());
  }

  private async notifyRegistry(): Promise<void> {
    const id = this.env.RoomRegistry.idFromName('global');
    const registry = this.env.RoomRegistry.get(id);

    if (this.clients.size > 0) {
      await registry.updateRoom(this.roomId, this.clients.size);
    } else {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }

  async alarm(): Promise<void> {
    if (this.clients.size === 0) {
      const id = this.env.RoomRegistry.idFromName('global');
      const registry = this.env.RoomRegistry.get(id);
      await registry.unregisterRoom(this.roomId);
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'DELETE') {
      this.broadcast({ type: 'room_deleted' });
      for (const [, client] of this.clients) {
        client.socket.close(1000, 'Room deleted');
      }
      this.clients.clear();
      await this.ctx.storage.deleteAlarm();
      const id = this.env.RoomRegistry.idFromName('global');
      const registry = this.env.RoomRegistry.get(id);
      await registry.unregisterRoom(this.roomId);
      return new Response(null, { status: 204 });
    }

    const url = new URL(request.url);

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const roomId = url.searchParams.get('roomId') || '';
    const userName = url.searchParams.get('name') || 'Anonymous';

    if (!this.roomId) {
      this.roomId = roomId;
      this.sessionId = `room-${roomId}`;
    }

    const userId = crypto.randomUUID();
    const user: User = {
      id: userId,
      name: userName,
      color: this.pickColor()
    };

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    this.clients.set(userId, { socket: server, user });

    const connectedMessage: ServerMessage = {
      type: 'connected',
      userId,
      user,
      users: this.getUsers(),
      room: this.getRoomInfo()
    };
    server.send(JSON.stringify(connectedMessage));

    this.broadcast(
      { type: 'user_joined', user, users: this.getUsers() },
      userId
    );
    this.ctx.waitUntil(this.notifyRegistry());

    server.addEventListener('message', (event) => {
      this.handleClientMessage(userId, event.data as string);
    });

    server.addEventListener('close', () => {
      this.handleClientDisconnect(userId);
    });

    server.addEventListener('error', () => {
      this.handleClientDisconnect(userId);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
