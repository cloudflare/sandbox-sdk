import { getSandbox, Sandbox } from '@cloudflare/sandbox';
import { createRequestHandler } from 'react-router';
import { RoomRegistry } from './registry';
import { Room } from './room';

export { Sandbox, Room, RoomRegistry };

declare module 'react-router' {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const reactHandler = createRequestHandler(
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE
);

const IGNORED_PATHS = [
  '/sw.js',
  '/service-worker.js',
  '/manifest.json',
  '/robots.txt'
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (IGNORED_PATHS.includes(url.pathname)) {
      return new Response(null, { status: 404 });
    }

    if (url.pathname === '/api/room' && request.method === 'POST') {
      const roomId = crypto.randomUUID().slice(0, 8);
      return Response.json({ roomId });
    }

    if (url.pathname.startsWith('/api/room/') && request.method === 'DELETE') {
      const roomId = url.pathname.split('/')[3];
      if (!roomId) {
        return new Response('Room ID required', { status: 400 });
      }
      const id = env.Room.idFromName(roomId);
      const room = env.Room.get(id);
      return room.fetch(request);
    }

    if (url.pathname.startsWith('/ws/room/')) {
      const roomId = url.pathname.split('/')[3];
      if (!roomId) {
        return new Response('Room ID required', { status: 400 });
      }

      const id = env.Room.idFromName(roomId);
      const room = env.Room.get(id);

      const roomUrl = new URL(request.url);
      roomUrl.searchParams.set('roomId', roomId);

      return room.fetch(new Request(roomUrl.toString(), request));
    }

    if (url.pathname.startsWith('/ws/terminal/')) {
      const sessionId = url.pathname.split('/')[3];
      if (!sessionId) {
        return new Response('Session ID required', { status: 400 });
      }

      try {
        const sandbox = getSandbox(env.Sandbox, 'shared-terminal');
        const session = await sandbox.getSession(sessionId);
        return await session.terminal(request);
      } catch (err) {
        console.error('Terminal connection error:', err);
        return new Response(
          `Terminal error: ${err instanceof Error ? err.message : 'Unknown error'}`,
          { status: 500 }
        );
      }
    }

    if (url.pathname === '/api/rooms' && request.method === 'GET') {
      const id = env.RoomRegistry.idFromName('global');
      const registry = env.RoomRegistry.get(id);
      const rooms = await registry.getActiveRooms();
      return Response.json({ rooms });
    }

    if (url.pathname === '/ws/rooms') {
      const id = env.RoomRegistry.idFromName('global');
      const registry = env.RoomRegistry.get(id);
      return registry.fetch(request);
    }

    return reactHandler(request, {
      cloudflare: { env, ctx }
    });
  }
} satisfies ExportedHandler<Env>;
