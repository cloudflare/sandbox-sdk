# Collaborative Terminal

Real-time terminal sharing powered by Cloudflare Sandbox. Like Google Docs, but for your shell.

Participants in the same room intentionally share one sandbox terminal and see the same input, output, presence, and typing indicators in real time. Treat a room as a shared workspace. Do not use rooms or sessions as boundaries between independent users or accounts.

## Features

- **Shared terminal**: Every participant sees the same PTY output as it happens
- **Room system**: Create rooms, share links, browse and join active rooms
- **Presence**: See who is in the room with colored avatars and typing indicators
- **Room workspaces**: Each room gets its own sandbox, with its own files and processes
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

**Terminal connection**: The browser connects directly to the sandbox container's PTY through a WebSocket that the SDK proxies transparently. Terminal I/O does not use a JSON protocol — raw bytes flow between xterm.js and the container's PTY via `SandboxAddon`.

**Room connection**: A separate WebSocket to the Room DO handles presence (joins, leaves, typing indicators). This keeps the collaboration layer decoupled from terminal I/O.

## How It Works

### Server side

The Worker routes requests to the appropriate Durable Object:

```typescript
// Terminal: proxy WebSocket directly to the room sandbox terminal
const sandbox = getSandbox(env.Sandbox, `room-${roomId}`);
return sandbox.terminal(request, { id: `room-${roomId}` });
```

Each room maps to a sandbox ID (`room-${roomId}`), so room workspaces do not share a filesystem, processes, or environment variables. In production, derive sandbox IDs from the authenticated user or a user-owned workspace.

Because an active room uses its own sandbox container, the `containers[].max_instances` value in `wrangler.jsonc` must be at least the number of simultaneously active rooms you intend to support. Increase it before deployment when serving more rooms concurrently.

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
sandboxAddon.connect({ sandboxId: sessionId, sessionId });
```

## Getting Started

### Prerequisites

- Node.js 22+
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
