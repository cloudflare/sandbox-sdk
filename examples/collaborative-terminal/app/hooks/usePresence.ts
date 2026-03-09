import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionState, RoomInfo, ServerMessage, User } from '../types';

interface UsePresenceOptions {
  roomId: string;
  userName: string;
  onRoomDeleted?: () => void;
}
interface UsePresenceReturn {
  state: ConnectionState;
  currentUser: User | null;
  users: User[];
  room: RoomInfo | null;
  typingUsers: Set<string>;
  sendTyping: () => void;
}
export function usePresence({
  roomId,
  userName,
  onRoomDeleted
}: UsePresenceOptions): UsePresenceReturn {
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const onRoomDeletedRef = useRef(onRoomDeleted);
  onRoomDeletedRef.current = onRoomDeleted;
  const typingTimeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );
  useEffect(() => {
    setState('connecting');
    const params = new URLSearchParams({ name: userName });
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/ws/room/${roomId}?${params}`
    );
    wsRef.current = ws;
    ws.onopen = () => {
      setState('connected');
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      switch (message.type) {
        case 'connected':
          setCurrentUser(message.user);
          setUsers(message.users);
          setRoom(message.room);
          break;
        case 'user_joined':
          setUsers(message.users);
          break;
        case 'user_left':
          setUsers(message.users);
          setTypingUsers((prev) => {
            const next = new Set(prev);
            next.delete(message.userId);
            return next;
          });
          break;
        case 'user_typing': {
          const userId = message.userId;
          setTypingUsers((prev) => new Set(prev).add(userId));
          const existingTimeout = typingTimeouts.current.get(userId);
          if (existingTimeout) clearTimeout(existingTimeout);
          const timeout = setTimeout(() => {
            setTypingUsers((prev) => {
              const next = new Set(prev);
              next.delete(userId);
              return next;
            });
            typingTimeouts.current.delete(userId);
          }, 2000);
          typingTimeouts.current.set(userId, timeout);
          break;
        }
        case 'room_deleted':
          onRoomDeletedRef.current?.();
          break;
        case 'error':
          console.error('Presence error:', message.message);
          break;
      }
    };
    ws.onclose = () => {
      setState('disconnected');
    };
    ws.onerror = () => {
      setState('disconnected');
    };
    return () => {
      ws.close();
      wsRef.current = null;
      for (const timeout of typingTimeouts.current.values()) {
        clearTimeout(timeout);
      }
      typingTimeouts.current.clear();
    };
  }, [roomId, userName]);
  const sendTyping = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'typing' }));
    }
  }, []);
  return {
    state,
    currentUser,
    users,
    room,
    typingUsers,
    sendTyping
  };
}
