# Collaborative Terminal

**Google Docs for Bash** - A multi-user terminal where multiple people can see the same PTY output in real-time and take turns sending commands.

This example demonstrates:

- **PTY Support**: Using the Sandbox SDK's PTY API for interactive terminal sessions
- **WebSocket Streaming**: Real-time output broadcast to all connected users
- **Collaborative Workflows**: Multiple users sharing a single terminal session
- **Presence Indicators**: See who's connected and who's typing

## Features

- Create terminal rooms that others can join via shareable link
- Real-time terminal output synchronized across all participants
- User presence list with colored indicators
- "Typing" indicators showing who's sending commands
- Terminal history buffering so new users see previous output
- Automatic cleanup when all users disconnect

## Architecture

```
┌──────────────┐     WebSocket     ┌─────────────────┐     PTY API    ┌───────────┐
│   Browser    │◄──────────────────►  Cloudflare     │◄──────────────►│  Sandbox  │
│   (xterm)    │                   │     Worker      │                │ Container │
└──────────────┘                   └─────────────────┘                └───────────┘
       │                                   │
       │                                   │
       ▼                                   ▼
  User Input                         Broadcast PTY
  ─────────►                         output to all
                                     connected users
```

## Getting Started

### Prerequisites

- Node.js 20+
- Docker (for local development)
- Cloudflare account with container access (beta)

### Important: PTY Support Required

This example requires PTY (pseudo-terminal) support which is available in sandbox image version **0.7.0 or later**. If using an older image, you'll need to build a local image with PTY support:

```bash
# From the monorepo root
cd ../..
docker build -f packages/sandbox/Dockerfile --target default -t sandbox-local .

# Then update examples/collaborative-terminal/Dockerfile to use:
# FROM sandbox-local
```

### Installation

```bash
cd examples/collaborative-terminal
npm install
```

### Development

```bash
npm run dev
```

This starts a local development server. Open http://localhost:5173 to access the app.

### Deploy

```bash
npm run deploy
```

## Usage

1. **Create a Room**: Click "Create New Room" to start a new terminal session
2. **Share the Link**: Click "Copy Link" to share the room with others
3. **Join a Room**: Enter a room ID to join an existing session
4. **Start Terminal**: Click "Start Terminal Session" to launch bash
5. **Collaborate**: All connected users see the same terminal output and can send commands

## How It Works

### Backend (Worker)

The Cloudflare Worker manages:

1. **Room State**: Tracks connected users and active PTY sessions per room
2. **WebSocket Connections**: Handles real-time communication with clients
3. **PTY Lifecycle**: Creates/destroys PTY sessions via the Sandbox SDK
4. **Output Broadcasting**: Forwards PTY output to all connected WebSocket clients

```typescript
// Create PTY and subscribe to output
const pty = await sandbox.pty.create({
  cols: 80,
  rows: 24,
  command: ['/bin/bash']
});

pty.onData((data) => {
  // Broadcast to all connected users
  broadcast(roomId, { type: 'pty_output', data });
});
```

### Frontend (React + xterm.js)

The React app provides:

1. **Terminal Rendering**: Uses xterm.js for terminal emulation
2. **WebSocket Client**: Connects to the worker for real-time updates
3. **User Management**: Displays connected users with presence indicators
4. **Input Handling**: Forwards keystrokes to the shared PTY

```typescript
// Handle terminal input
term.onData((data) => {
  ws.send(JSON.stringify({ type: 'pty_input', data }));
});

// Handle PTY output from server
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'pty_output') {
    term.write(msg.data);
  }
};
```

## API Reference

### WebSocket Messages

**Client → Server:**

| Type         | Description        | Fields         |
| ------------ | ------------------ | -------------- |
| `start_pty`  | Create PTY session | `cols`, `rows` |
| `pty_input`  | Send input to PTY  | `data`         |
| `pty_resize` | Resize terminal    | `cols`, `rows` |

**Server → Client:**

| Type          | Description         | Fields                       |
| ------------- | ------------------- | ---------------------------- |
| `connected`   | Initial connection  | `userId`, `users`, `history` |
| `user_joined` | User joined room    | `user`, `users`              |
| `user_left`   | User left room      | `userId`, `users`            |
| `pty_started` | PTY session created | `ptyId`                      |
| `pty_output`  | Terminal output     | `data`                       |
| `pty_exit`    | PTY session ended   | `exitCode`                   |
| `user_typing` | User sent input     | `user`                       |

## Customization Ideas

- **Access Control**: Add authentication to restrict who can join/type
- **Command History**: Store and replay command history
- **Multiple Terminals**: Support multiple PTY sessions per room
- **Recording**: Record sessions for playback
- **Chat**: Add a sidebar chat for discussion
