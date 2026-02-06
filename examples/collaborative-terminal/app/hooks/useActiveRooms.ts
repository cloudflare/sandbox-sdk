import { useEffect, useRef, useState } from 'react';
import type { ActiveRoom, RegistryMessage } from '../types';

interface UseActiveRoomsReturn {
  rooms: ActiveRoom[];
  isLoading: boolean;
}

function sortRooms(rooms: ActiveRoom[]): ActiveRoom[] {
  return [...rooms].sort((a, b) => {
    if (b.userCount !== a.userCount) return b.userCount - a.userCount;
    return b.createdAt - a.createdAt;
  });
}

export function useActiveRooms(): UseActiveRoomsReturn {
  const [rooms, setRooms] = useState<ActiveRoom[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let disposed = false;

    function connect() {
      if (disposed) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/rooms`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data) as RegistryMessage;
        if (message.type === 'rooms') {
          setRooms(sortRooms(message.rooms));
          setIsLoading(false);
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        reconnectTimeout.current = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  return { rooms, isLoading };
}
