# Collaborative Terminal

Real-time terminal sharing powered by Cloudflare Sandbox. Like Google Docs, but for your shell.

Multiple users join a room, share a single sandbox terminal, and see each other's input in real-time with presence indicators and typing notifications.

## Features

- **Shared terminal**: Every participant sees the same PTY output as it happens
- **Room system**: Create rooms, share links, browse and join active rooms
- **Presence**: See who's in the room with colored avatars and typing indicators
- **Session isolation**: Each room gets its own sandbox session so rooms don't interfere
- **Live room list**: Homepage updates in real-time as rooms are created or emptied

## Architecture

The example uses three Durable Objects working together:

```
Browser (xterm.js + SandboxAddon)
    |
    |-- /ws/room/:id ----> Room DO         Presence, user list, typing
    |
    \-- /ws/terminal/:sessionId
            |
            v
        Sandbox DO <---> Container PTY    Direct WebSocket passthrough
            |
RoomRegistry DO                           Tracks active rooms globally
```

**Terminal connection**: The browser connects directly to the sandbox container's PTY through a WebSocket that the SDK proxies transparently. There's no JSON protocol for terminal I/O — raw bytes flow between xterm.js and the container's PTY via `SandboxAddon`.

**Room connection**: A separate WebSocket to the Room DO handles presence (joins, leaves, typing indicators). This keeps the collaboration layer decoupled from terminal I/O.

## How It Works

### Server side

The Worker routes requests to the appropriate Durable Object:

```typescript
// Terminal: proxy WebSocket directly to a sandbox session's PTY
const sandbox = getSandbox(env.Sandbox, 'shared-terminal');
const session = await sandbox.getSession(sessionId);
return session.terminal(request);
```

Each room maps to a session ID (`room-${roomId}`), so different rooms get isolated shell environments within the same sandbox container.

### Client side

The terminal component uses `SandboxAddon` from `@cloudflare/sandbox/xterm` to handle the WebSocket connection, resize events, and reconnection:

```typescript
import { SandboxAddon } from '@cloudflare/sandbox/xterm';

const sandboxAddon = new SandboxAddon({
  getWebSocketUrl: ({ origin, sessionId }) =>
    `${origin}/ws/terminal/${sessionId}`,
  onStateChange: (state) => setState(state)
});

terminal.loadAddon(sandboxAddon);
sandboxAddon.connect({ sandboxId: 'shared-terminal', sessionId });
```

## Getting Started

### Prerequisites

- Node.js 20+
- Docker (for local development)
- Cloudflare account with container access

### Install and run

```bash
npm install
npm run dev
```

Open http://localhost:5173, create a room, and share the link.

### Deploy

```bash
npm run deploy
```

After first deployment, wait 2-3 minutes for container provisioning before making requests.

## Project Structure

```
workers/
  app.ts            Main Worker — routes requests, creates rooms
  room.ts           Room DO — manages connected users and presence
  registry.ts       RoomRegistry DO — tracks active rooms globally
  types/protocol.ts WebSocket message types for the room protocol

app/
  routes/home.tsx       Homepage with room creation and active room list
  routes/room.tsx       Room page with terminal, sidebar, and presence
  components/
    Terminal.client.tsx xterm.js setup with SandboxAddon
    UserAvatars.tsx     Colored avatar circles with typing indicators
  hooks/
    usePresence.ts      WebSocket hook for room presence state
    useActiveRooms.ts   WebSocket hook for live room list from registry
```
