export interface User {
  id: string;
  name: string;
  color: string;
}

export interface RoomInfo {
  roomId: string;
  sessionId: string;
}

export type ClientMessage = { type: 'typing' };

export type ServerMessage =
  | {
      type: 'connected';
      userId: string;
      user: User;
      users: User[];
      room: RoomInfo;
    }
  | { type: 'user_joined'; user: User; users: User[] }
  | { type: 'user_left'; userId: string; users: User[] }
  | { type: 'user_typing'; userId: string }
  | { type: 'room_deleted' }
  | { type: 'error'; message: string };

export interface ActiveRoom {
  roomId: string;
  userCount: number;
  createdAt: number;
}

export type RegistryMessage = { type: 'rooms'; rooms: ActiveRoom[] };
