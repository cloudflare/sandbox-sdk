import { DurableObject } from 'cloudflare:workers';
import type { ActiveRoom, RegistryMessage } from './types/protocol';

export class RoomRegistry extends DurableObject<Env> {
  private rooms = new Map<string, ActiveRoom>();
  private subscribers = new Set<WebSocket>();

  async updateRoom(roomId: string, userCount: number): Promise<void> {
    const existing = this.rooms.get(roomId);
    this.rooms.set(roomId, {
      roomId,
      userCount,
      createdAt: existing?.createdAt ?? Date.now()
    });
    this.broadcastRoomList();
  }

  async unregisterRoom(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
    this.broadcastRoomList();
  }

  async getActiveRooms(): Promise<ActiveRoom[]> {
    return Array.from(this.rooms.values());
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    this.subscribers.add(server);

    const message: RegistryMessage = {
      type: 'rooms',
      rooms: Array.from(this.rooms.values())
    };
    server.send(JSON.stringify(message));

    server.addEventListener('close', () => {
      this.subscribers.delete(server);
    });

    server.addEventListener('error', () => {
      this.subscribers.delete(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcastRoomList(): void {
    const message: RegistryMessage = {
      type: 'rooms',
      rooms: Array.from(this.rooms.values())
    };
    const data = JSON.stringify(message);

    for (const ws of this.subscribers) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        } else {
          this.subscribers.delete(ws);
        }
      } catch {
        this.subscribers.delete(ws);
      }
    }
  }
}
