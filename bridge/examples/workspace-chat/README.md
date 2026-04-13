# Workspace Chat

An AI chat agent with a persistent virtual filesystem, replicating the
[Cloudflare workspace-chat example](../vendor/agents/examples/workspace-chat/)
using the OpenAI Python Agents SDK with a Cloudflare Sandbox backend.

## What it shows

- **Structured file editing** — The agent uses the built-in `apply_patch` tool
  from the `Filesystem` capability to create and edit files
- **Persistent filesystem** — Files live in a Cloudflare Sandbox and survive
  across chat turns
- **File browser sidebar** — Browse workspace contents in real-time alongside
  the chat
- **Streaming responses** — Uses OpenAI `gpt-5.4` with streaming via the
  AI SDK Data Stream Protocol
- **Shell access** — The agent can run arbitrary shell commands in the sandbox
  via the `Shell` capability (bun, node, npm available)

## Architecture

```
workspace-chat/
  backend/     Python Starlette server + OpenAI Agents SDK
  frontend/    React + Vite + @cloudflare/kumo UI
```

The backend creates a Cloudflare Sandbox session at startup and keeps it alive.
The agent uses the `Shell` and `Filesystem` capabilities from the OpenAI Agents
SDK — `exec_command` for running shell commands and `apply_patch` for structured
file edits. The frontend uses `useChat` from `@ai-sdk/react` for streaming chat
and REST endpoints for the file browser sidebar.

## Prerequisites

- Python 3.12+
- [uv](https://docs.astral.sh/uv/)
- Node.js 18+
- An OpenAI API key with access to `gpt-5.4`
- A Cloudflare Sandbox worker URL and API key

## Quick start

```bash
cp backend/.env.example backend/.env
# edit backend/.env with your actual keys

script/start
```

This checks prerequisites, installs dependencies, and starts both servers
with interleaved output. The frontend is at `http://localhost:5173`.

### Manual setup

If you prefer to run the servers separately:

**Backend:**

```bash
cd backend
uv sync
uv run main.py    # http://localhost:8000
```

**Frontend:**

```bash
cd frontend
npm install
npm run dev       # http://localhost:5173
```

The Vite dev server proxies `/api/*` and `/artifacts/*` to the backend.

## Session persistence

The backend saves sandbox session state to `backend/.sandbox-session.json`.
When you restart the server, it reconnects to the same sandbox — files and
shell state survive across restarts.

To discard the session and start with a fresh sandbox:

```bash
script/clean
```

## Artifacts

The agent can provide download or preview links for sandbox files using the
`/artifacts/<path>` endpoint. Browser-friendly types (HTML, images, PDF) open
inline; other types trigger a download.

## Try these prompts

- "Create a hello world HTML page at /index.html"
- "Show me what files are in the workspace"
- "Create a Node.js project with package.json and src/index.ts"
- "Give me a download link for /index.html"
