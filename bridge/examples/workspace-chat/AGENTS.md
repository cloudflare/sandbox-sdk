# Agents — workspace-chat demo

This directory contains a two-process workspace chat demo: a Python backend
and a React frontend.

## Conventions

### Backend (`backend/`)

- **Framework**: Starlette (not FastAPI) served with uvicorn.
- **Dependencies**: managed via `uv` with `pyproject.toml`.
- **Formatting**: `uv run ruff format backend/` and `uv run ruff check --fix backend/`.
- **Credentials**: loaded from `.env` via `python-dotenv`. Never hard-code secrets.
- **Model**: uses `gpt-5.4`.
- **Sandbox**: uses `CloudflareSandboxClient` for the filesystem. A single
  session is created at startup and reused across requests.
- **Streaming**: implements the AI SDK Data Stream Protocol (SSE with
  `x-vercel-ai-ui-message-stream: v1` header).

### Frontend (`frontend/`)

- **Framework**: React 19 + Vite + TypeScript.
- **UI library**: `@cloudflare/kumo` components, `@phosphor-icons/react` icons.
- **Chat**: `useChat` from `@ai-sdk/react` (standard HTTP streaming).
- **Styling**: Tailwind CSS 4 + kumo theme.
- **Dev proxy**: Vite proxies `/api/*` to the Python backend at `localhost:8000`.
