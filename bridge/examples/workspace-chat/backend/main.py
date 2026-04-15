"""Workspace Chat backend — Starlette server with OpenAI Agents SDK + Cloudflare Sandbox."""

from __future__ import annotations

import io
import mimetypes
import json
import logging
import os
import uuid
from pathlib import Path, PurePosixPath
from contextlib import asynccontextmanager
from typing import Any

import uvicorn
from openai.types.responses import (
    ResponseFunctionCallArgumentsDeltaEvent,
    ResponseReasoningSummaryTextDeltaEvent,
    ResponseTextDeltaEvent,
)
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from agents import Runner
from agents.extensions.sandbox.cloudflare import (
    CloudflareSandboxClient,
    CloudflareSandboxClientOptions,
    CloudflareSandboxSessionState,
)
from agents.run import RunConfig
from agents.sandbox import SandboxAgent, SandboxRunConfig, WorkspaceReadNotFoundError
from agents.sandbox.capabilities import Filesystem, Shell

logger = logging.getLogger(__name__)

MODEL = "gpt-5.4"
WORKSPACE_ROOT = "/workspace"
SESSION_FILE = Path(__file__).resolve().parent / ".sandbox-session.json"
HISTORY_FILE = Path(__file__).resolve().parent / ".chat-history.json"

# ---------------------------------------------------------------------------
# Sandbox session (module-level, created at startup)
# ---------------------------------------------------------------------------

_sandbox_client: CloudflareSandboxClient | None = None
_sandbox_session: Any = None


def _save_session_state() -> None:
    """Persist the current sandbox session state to a local file."""
    if _sandbox_session is None:
        return
    inner = _sandbox_session._inner
    state_data = inner.state.model_dump(mode="json")
    SESSION_FILE.write_text(json.dumps(state_data, indent=2))
    logger.info("Session state saved to %s", SESSION_FILE)


def _load_session_state() -> CloudflareSandboxSessionState | None:
    """Load a previously saved session state, or return None."""
    if not SESSION_FILE.exists():
        return None
    try:
        data = json.loads(SESSION_FILE.read_text())
        return CloudflareSandboxSessionState.model_validate(data)
    except Exception:
        logger.warning("Failed to load saved session state, starting fresh", exc_info=True)
        return None


async def _start_sandbox() -> None:
    global _sandbox_client, _sandbox_session
    worker_url = os.environ.get("CLOUDFLARE_SANDBOX_WORKER_URL", "")
    if not worker_url:
        raise RuntimeError("CLOUDFLARE_SANDBOX_WORKER_URL is not set")

    _sandbox_client = CloudflareSandboxClient()

    # Try to restore a previous session
    saved_state = _load_session_state()
    if saved_state is not None:
        try:
            logger.info("Restoring sandbox session %s …", saved_state.sandbox_id)
            _sandbox_session = await _sandbox_client.resume(saved_state)
            await _sandbox_session.start()
            logger.info("Sandbox session restored")
            return
        except Exception:
            logger.warning("Could not restore session, creating a new one", exc_info=True)
            SESSION_FILE.unlink(missing_ok=True)

    # Create a fresh session
    options = CloudflareSandboxClientOptions(worker_url=worker_url)
    _sandbox_session = await _sandbox_client.create(options=options)
    await _sandbox_session.start()
    _save_session_state()
    logger.info("Sandbox session started")


async def _stop_sandbox() -> None:
    """Save session state and disconnect without destroying the sandbox."""
    global _sandbox_client, _sandbox_session
    if _sandbox_session is not None:
        _save_session_state()
    _sandbox_session = None
    _sandbox_client = None


async def _reset_sandbox() -> None:
    """Destroy the current sandbox, clear saved state, and start a fresh one."""
    global _sandbox_client, _sandbox_session
    # Shut down the existing session
    if _sandbox_session is not None and _sandbox_client is not None:
        try:
            await _sandbox_client.delete(_sandbox_session)
        except Exception:
            logger.warning("Could not delete old sandbox", exc_info=True)
    _sandbox_session = None
    SESSION_FILE.unlink(missing_ok=True)
    HISTORY_FILE.unlink(missing_ok=True)
    # Start fresh — if this fails, the app is left without a session
    # and _get_session will raise until a successful restart or retry.
    await _start_sandbox()


def _get_session():
    if _sandbox_session is None:
        raise RuntimeError(
            "Sandbox session not initialized. "
            "If you just reset, the new sandbox may have failed to start — check the backend logs."
        )
    return _sandbox_session


# ---------------------------------------------------------------------------
# Path safety
# ---------------------------------------------------------------------------


def _safe_path(user_path: str) -> str:
    """Resolve a user-provided path to an absolute path under WORKSPACE_ROOT.

    Accepts both workspace-relative paths (e.g. 'reports/file.html') and
    absolute paths that already include /workspace (e.g. '/workspace/reports/file.html').
    Raises ValueError on traversal attempts.
    """
    cleaned = PurePosixPath("/" + user_path.lstrip("/")).as_posix()
    # If the path already starts with /workspace, use it directly;
    # otherwise prepend WORKSPACE_ROOT.
    if cleaned.startswith(WORKSPACE_ROOT + "/") or cleaned == WORKSPACE_ROOT:
        raw = cleaned
    else:
        raw = PurePosixPath(WORKSPACE_ROOT + cleaned).as_posix()
    # Resolve .. and . segments
    parts: list[str] = []
    for seg in raw.split("/"):
        if seg == "" or seg == ".":
            continue
        if seg == "..":
            if parts:
                parts.pop()
        else:
            parts.append(seg)
    resolved = "/" + "/".join(parts)
    if not (resolved.startswith(WORKSPACE_ROOT + "/") or resolved == WORKSPACE_ROOT):
        raise ValueError(f"Path escapes workspace root: {user_path}")
    return resolved


# ---------------------------------------------------------------------------
# Agent definition
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """\
You are a helpful coding assistant with access to a persistent virtual filesystem.
You have an apply_patch tool for creating and editing files, a view_image tool for
inspecting images, and a shell capability for running commands via exec_command.
When the user asks you to create files or projects, use apply_patch to write them.
When showing file contents, prefer reading them with exec_command (e.g. `cat <path>`).
After making changes, briefly summarize what you did.

When the user asks to download or preview a file, provide a markdown link to \
/artifacts/<workspace-path> (e.g. [download](/artifacts/workspace/output.zip)). \
All sandbox files live under /workspace, so every artifact link starts with \
/artifacts/workspace/. Browser-friendly types (HTML, images, PDF) open inline; \
other types trigger a download.
""".strip()


def _build_agent() -> SandboxAgent:
    return SandboxAgent(
        name="Workspace Assistant",
        model=MODEL,
        instructions=SYSTEM_PROMPT,
        capabilities=[Shell(), Filesystem()],
    )


# ---------------------------------------------------------------------------
# AI SDK Data Stream Protocol helpers
# ---------------------------------------------------------------------------


def _sse_event(data: dict | str) -> str:
    """Format a single SSE data line."""
    payload = data if isinstance(data, str) else json.dumps(data)
    return f"data: {payload}\n\n"


async def _stream_agent_response(prompt: str, history: list[dict]):
    """Run the agent and yield SSE events in AI SDK UI Message Stream format."""
    session = _get_session()
    agent = _build_agent()

    run_config = RunConfig(
        sandbox=SandboxRunConfig(session=session),
        workflow_name="workspace-chat",
        tracing_disabled=True,
    )

    # Build input from history + current prompt
    input_messages = []
    for msg in history:
        role = msg.get("role", "user")
        # Extract text from parts if present
        parts = msg.get("parts", [])
        text_parts = [p["text"] for p in parts if p.get("type") == "text"]
        content = "".join(text_parts) if text_parts else msg.get("content", "")
        if content:
            input_messages.append({"role": role, "content": content})

    if prompt:
        input_messages.append({"role": "user", "content": prompt})

    result = Runner.run_streamed(agent, input_messages, run_config=run_config)

    message_id = f"msg_{uuid.uuid4().hex}"
    text_id = f"text_{uuid.uuid4().hex}"

    # Message start
    yield _sse_event({"type": "start", "messageId": message_id})
    yield _sse_event({"type": "start-step"})

    text_started = False
    reasoning_started = False
    reasoning_id = f"reasoning_{uuid.uuid4().hex}"
    active_tool_call_id: str | None = None
    async for event in result.stream_events():
        # --- Raw model events (text deltas, tool arg deltas) ---
        if event.type == "raw_response_event":
            data = event.data
            if isinstance(data, ResponseReasoningSummaryTextDeltaEvent):
                if text_started:
                    yield _sse_event({"type": "text-end", "id": text_id})
                    text_started = False
                    text_id = f"text_{uuid.uuid4().hex}"
                if not reasoning_started:
                    yield _sse_event({"type": "reasoning-start", "id": reasoning_id})
                    reasoning_started = True
                yield _sse_event({"type": "reasoning-delta", "id": reasoning_id, "delta": data.delta})
                continue

            if isinstance(data, ResponseTextDeltaEvent):
                if reasoning_started:
                    yield _sse_event({"type": "reasoning-end", "id": reasoning_id})
                    reasoning_started = False
                    reasoning_id = f"reasoning_{uuid.uuid4().hex}"
                if not text_started:
                    yield _sse_event({"type": "text-start", "id": text_id})
                    text_started = True
                yield _sse_event({"type": "text-delta", "id": text_id, "delta": data.delta})
                continue

            if isinstance(data, ResponseFunctionCallArgumentsDeltaEvent):
                if active_tool_call_id:
                    yield _sse_event(
                        {
                            "type": "tool-input-delta",
                            "toolCallId": active_tool_call_id,
                            "inputTextDelta": data.delta,
                        }
                    )
                continue

        # --- Run item events (tool calls, tool outputs) ---
        if event.type == "run_item_stream_event":
            if event.name == "tool_called":
                # Close any open text or reasoning block
                if text_started:
                    yield _sse_event({"type": "text-end", "id": text_id})
                    text_started = False
                    text_id = f"text_{uuid.uuid4().hex}"
                if reasoning_started:
                    yield _sse_event({"type": "reasoning-end", "id": reasoning_id})
                    reasoning_started = False
                    reasoning_id = f"reasoning_{uuid.uuid4().hex}"

                raw = event.item.raw_item
                if isinstance(raw, dict):
                    call_id = raw.get("call_id") or raw.get("id") or f"call_{uuid.uuid4().hex}"
                    tool_name = raw.get("name") or raw.get("type") or "unknown"
                    arguments = raw.get("arguments", "{}")
                else:
                    call_id = (
                        getattr(raw, "call_id", None)
                        or getattr(raw, "id", None)
                        or f"call_{uuid.uuid4().hex}"
                    )
                    tool_name = (
                        getattr(raw, "name", None) or getattr(raw, "type", None) or "unknown"
                    )
                    arguments = getattr(raw, "arguments", "{}")

                active_tool_call_id = call_id

                yield _sse_event(
                    {
                        "type": "tool-input-start",
                        "toolCallId": call_id,
                        "toolName": tool_name,
                    }
                )

                # Emit the complete input
                try:
                    parsed_args = json.loads(arguments) if isinstance(arguments, str) else arguments
                except (json.JSONDecodeError, TypeError):
                    parsed_args = {"raw": str(arguments)}

                yield _sse_event(
                    {
                        "type": "tool-input-available",
                        "toolCallId": call_id,
                        "toolName": tool_name,
                        "input": parsed_args,
                    }
                )

            elif event.name == "tool_output":
                raw = event.item.raw_item
                if isinstance(raw, dict):
                    call_id = raw.get("call_id") or raw.get("id") or active_tool_call_id or ""
                    output = raw.get("output", "")
                else:
                    call_id = (
                        getattr(raw, "call_id", None)
                        or getattr(raw, "id", None)
                        or active_tool_call_id
                        or ""
                    )
                    output = getattr(raw, "output", "")

                # Try to parse output as JSON for structured display
                try:
                    if isinstance(output, str):
                        parsed_output = json.loads(output)
                    else:
                        parsed_output = output
                except (json.JSONDecodeError, TypeError):
                    parsed_output = output

                yield _sse_event(
                    {
                        "type": "tool-output-available",
                        "toolCallId": call_id,
                        "output": parsed_output,
                    }
                )

                # Step boundary for multi-step tool use
                yield _sse_event({"type": "finish-step"})
                yield _sse_event({"type": "start-step"})
                active_tool_call_id = None

    # Close any open text or reasoning block
    if text_started:
        yield _sse_event({"type": "text-end", "id": text_id})
    if reasoning_started:
        yield _sse_event({"type": "reasoning-end", "id": reasoning_id})

    # Finish
    yield _sse_event({"type": "finish-step"})
    yield _sse_event({"type": "finish"})
    yield "data: [DONE]\n\n"


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------


async def chat_endpoint(request: Request) -> Response:
    """POST /api/chat — streaming agent response."""
    body = await request.json()
    messages = body.get("messages", [])

    # Extract the latest user message
    prompt = ""
    history = []
    for msg in messages:
        parts = msg.get("parts", [])
        text_parts = [p["text"] for p in parts if p.get("type") == "text"]
        content = "".join(text_parts) if text_parts else msg.get("content", "")
        if msg.get("role") == "user":
            prompt = content
        history.append(msg)

    # Remove the last message from history since it's the prompt
    if history and history[-1].get("role") == "user":
        history = history[:-1]

    async def event_stream():
        try:
            async for chunk in _stream_agent_response(prompt, history):
                yield chunk
        except Exception as e:
            logger.exception("Error in chat stream")
            yield _sse_event({"type": "error", "errorText": str(e)})
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        content=event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "x-vercel-ai-ui-message-stream": "v1",
        },
    )


async def list_endpoint(request: Request) -> JSONResponse:
    """GET /api/list/{path} — list directory contents."""
    path = request.path_params.get("path", "/")
    if not path.startswith("/"):
        path = "/" + path

    try:
        safe = _safe_path(path)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=403)

    session = _get_session()
    result = await session.exec(
        "find",
        safe,
        "-maxdepth",
        "1",
        "-mindepth",
        "1",
        "-printf",
        "%y %s %f\\n",
        shell=False,
    )

    entries = []
    if result.ok():
        for line in result.stdout.decode().splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split(" ", 2)
            if len(parts) < 3:
                continue
            ftype, size, name = parts
            entry_type = "directory" if ftype == "d" else "file"
            entry_path = PurePosixPath(safe) / name
            display_path = "/" + str(entry_path).removeprefix(WORKSPACE_ROOT).lstrip("/")
            entries.append(
                {"name": name, "type": entry_type, "size": int(size), "path": display_path}
            )

    return JSONResponse(entries)


async def read_file_endpoint(request: Request) -> Response:
    """GET /api/files/{path} — read file content."""
    path = request.path_params.get("path", "")
    if not path.startswith("/"):
        path = "/" + path

    try:
        safe = _safe_path(path)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=403)

    session = _get_session()
    result = await session.exec("cat", "--", safe, shell=False)
    if not result.ok():
        return JSONResponse({"error": f"File not found: {path}"}, status_code=404)

    return Response(
        content=result.stdout.decode("utf-8", errors="replace"),
        media_type="text/plain",
    )


async def delete_file_endpoint(request: Request) -> JSONResponse:
    """DELETE /api/files/{path} — delete a file."""
    path = request.path_params.get("path", "")
    if not path.startswith("/"):
        path = "/" + path

    try:
        safe = _safe_path(path)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=403)

    session = _get_session()
    result = await session.exec("rm", "-f", "--", safe, shell=False)
    return JSONResponse({"path": path, "deleted": result.ok()})


async def workspace_info_endpoint(request: Request) -> JSONResponse:
    """GET /api/workspace/info — workspace statistics."""
    session = _get_session()
    file_count = 0
    dir_count = 0
    total_bytes = 0
    try:
        file_result = await session.exec("find", WORKSPACE_ROOT, "-type", "f", shell=False)
        file_count = len(file_result.stdout.decode().strip().splitlines()) if file_result.ok() else 0

        dir_result = await session.exec(
            "find", WORKSPACE_ROOT, "-mindepth", "1", "-type", "d", shell=False
        )
        dir_count = len(dir_result.stdout.decode().strip().splitlines()) if dir_result.ok() else 0

        du_result = await session.exec("du", "-sb", WORKSPACE_ROOT, shell=False)
        if du_result.ok():
            parts = du_result.stdout.decode().strip().split()
            if parts:
                try:
                    total_bytes = int(parts[0])
                except ValueError:
                    pass
    except Exception:
        pass

    return JSONResponse(
        {"fileCount": file_count, "directoryCount": dir_count, "totalBytes": total_bytes}
    )



async def file_tree_endpoint(request: Request) -> JSONResponse:
    """GET /api/files-tree — recursive flat listing of all files in the workspace."""
    session = _get_session()
    entries: list[dict[str, object]] = []
    try:
        result = await session.exec(
            "find", WORKSPACE_ROOT, "-type", "f", "-printf", "%s\t%p\n",
            shell=False,
        )
        if result.ok():
            for line in result.stdout.decode("utf-8", errors="replace").strip().splitlines():
                parts = line.split("\t", 1)
                if len(parts) == 2:
                    size_str, full_path = parts
                    display_path = "/" + full_path.removeprefix(WORKSPACE_ROOT).lstrip("/")
                    try:
                        entries.append({"path": display_path, "size": int(size_str)})
                    except ValueError:
                        entries.append({"path": display_path, "size": 0})
    except (ExecTimeoutError, TimeoutError, Exception):
        pass
    entries.sort(key=lambda e: str(e["path"]))
    return JSONResponse(entries)


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

async def root_endpoint(request: Request) -> Response:
    return Response(
        content=(
            "Workspace Chat backend is running.\n\n"
            "  Frontend: http://localhost:5173\n"
            "  API base: http://localhost:8000/api/\n\n"
            "Available endpoints:\n"
            "  POST /api/chat\n"
            "  POST /api/reset\n"
            "  GET  /api/list[/<path>]\n"
            "  GET  /api/files/<path>\n"
            "  GET  /api/workspace/info\n"
            "  GET  /api/files-tree\n"
            "  GET  /artifacts/<path>\n"
            "  POST /api/upload\n"
        ),
        media_type="text/plain",
    )


# Content types that browsers can render inline
_INLINE_TYPES = {
    "text/html", "text/plain", "text/css", "text/javascript",
    "application/json", "application/pdf",
    "image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp",
    "audio/mpeg", "audio/ogg", "video/mp4", "video/webm",
}


async def artifact_endpoint(request: Request) -> Response:
    """GET /artifacts/{path} — serve a sandbox file for download or preview."""
    path = request.path_params.get("path", "")
    if not path.startswith("/"):
        path = "/" + path

    try:
        safe = _safe_path(path)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=403)

    session = _get_session()
    try:
        file_obj = await session.read(safe)
    except (WorkspaceReadNotFoundError, FileNotFoundError, Exception):
        return JSONResponse({"error": f"File not found: {path}"}, status_code=404)

    data = file_obj.read()
    content_type, _ = mimetypes.guess_type(safe)
    content_type = content_type or "application/octet-stream"

    filename = PurePosixPath(safe).name
    if content_type in _INLINE_TYPES:
        disposition = "inline"
    else:
        disposition = f'attachment; filename="{filename}"'

    return Response(
        content=data,
        media_type=content_type,
        headers={"Content-Disposition": disposition},
    )



async def history_get_endpoint(request: Request) -> JSONResponse:
    """GET /api/history — return saved chat messages."""
    if HISTORY_FILE.exists():
        try:
            return JSONResponse(json.loads(HISTORY_FILE.read_text()))
        except Exception:
            pass
    return JSONResponse([])


async def history_put_endpoint(request: Request) -> JSONResponse:
    """PUT /api/history — persist chat messages."""
    body = await request.json()
    HISTORY_FILE.write_text(json.dumps(body, indent=2))
    return JSONResponse({"ok": True})


async def reset_endpoint(request: Request) -> JSONResponse:
    """POST /api/reset — destroy sandbox, clear history, start fresh."""
    try:
        await _reset_sandbox()
        return JSONResponse({"ok": True})
    except Exception as e:
        logger.exception("Reset failed — sandbox session may be unavailable until backend restart")
        return JSONResponse({"error": str(e)}, status_code=502)

MAX_UPLOAD_BYTES = 32 * 1024 * 1024  # 32 MiB — matches bridge PUT /file/* limit


async def upload_endpoint(request: Request) -> JSONResponse:
    """POST /api/upload — upload files into the sandbox workspace."""
    form = await request.form()
    uploaded: list[dict[str, object]] = []
    session = _get_session()

    for key in form:
        upload = form[key]
        if not hasattr(upload, "read"):
            continue
        filename = getattr(upload, "filename", None) or key
        # Reject path traversal and absolute paths
        if ".." in filename or "/" in filename or "\\" in filename:
            return JSONResponse(
                {"error": f"invalid filename: {filename}"}, status_code=400
            )
        content = await upload.read()
        if len(content) > MAX_UPLOAD_BYTES:
            return JSONResponse(
                {"error": f"{filename} exceeds the {MAX_UPLOAD_BYTES}-byte limit"},
                status_code=413,
            )
        safe = f"/workspace/uploads/{filename}"
        # Ensure the uploads directory exists
        await session.exec("mkdir", "-p", "/workspace/uploads", shell=False)
        await session.write(Path(safe), io.BytesIO(content))
        uploaded.append({"path": f"/workspace/uploads/{filename}", "size": len(content)})

    return JSONResponse({"uploaded": uploaded})

routes = [
    Route("/", root_endpoint, methods=["GET"]),
    Route("/api/chat", chat_endpoint, methods=["POST"]),
    Route("/api/reset", reset_endpoint, methods=["POST"]),
    Route("/api/upload", upload_endpoint, methods=["POST"]),
    Route("/api/list/{path:path}", list_endpoint, methods=["GET"]),
    Route("/api/list", list_endpoint, methods=["GET"], name="list_root"),
    Route("/api/files/{path:path}", read_file_endpoint, methods=["GET"]),
    Route("/api/files/{path:path}", delete_file_endpoint, methods=["DELETE"]),
    Route("/api/workspace/info", workspace_info_endpoint, methods=["GET"]),
    Route("/api/files-tree", file_tree_endpoint, methods=["GET"]),
    Route("/artifacts/{path:path}", artifact_endpoint, methods=["GET"]),
    Route("/api/history", history_get_endpoint, methods=["GET"]),
    Route("/api/history", history_put_endpoint, methods=["PUT"]),
]

async def _lifespan(app: Starlette):
    await _start_sandbox()
    yield
    await _stop_sandbox()


app = Starlette(
    routes=routes,
    middleware=[
        Middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["*"],
            allow_headers=["*"],
        )
    ],
    lifespan=_lifespan,
)

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
