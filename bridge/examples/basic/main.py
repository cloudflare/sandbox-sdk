# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = [
#     "openai-agents[cloudflare]",
# ]
# ///
"""One-shot JavaScript coding agent backed by a Cloudflare Sandbox.

Usage:
    uv run main.py "Create a hello world HTTP server using Bun.serve"
    uv run main.py --output ./results "Build a CLI tool that converts CSV to JSON"
    uv run main.py --image mockup.png "Build an HTML page that matches this mockup"
"""

from __future__ import annotations

import argparse
import asyncio
import io
import os
import sys
from pathlib import Path
from typing import cast

from openai.types.responses import (
    ResponseFunctionCallArgumentsDeltaEvent,
    ResponseTextDeltaEvent,
)

from agents import Runner
from agents.extensions.sandbox.cloudflare import (
    CloudflareSandboxClient,
    CloudflareSandboxClientOptions,
)
from agents.run import RunConfig
from agents.sandbox import SandboxAgent, SandboxRunConfig
from agents.sandbox.capabilities import Filesystem, Shell

MODEL = "gpt-5.4"

INSTRUCTIONS = """\
You are an expert JavaScript / TypeScript developer working inside a sandbox.
The sandbox has bun, node, and npm available on the PATH.
Your workspace is mounted at /workspace.

When the user gives you a coding task:

1. Implement the solution inside /workspace.
2. Test that it works by running it (e.g. `bun run`, `node`, or `npm test`).
3. Use apply_patch to create or edit files. Use exec_command to run commands.
4. If an image was provided as a visual reference, use view_image to inspect it
   before you start coding. The image path will be mentioned in the task prompt.
5. IMPORTANT: Copy **only the relevant generated files** into /workspace/output/.
   - If the deliverable is a single file, copy it directly.
   - If there are multiple files, bundle them into /workspace/output/result.zip
     using a command like `cd /workspace && zip -r output/result.zip <files>`.
6. Confirm what you placed in /workspace/output/ and briefly explain how to use it.

IMPORTANT: Always create the output directory first: `mkdir -p /workspace/output`.
""".strip()


# ---------------------------------------------------------------------------
# Streaming helpers
# ---------------------------------------------------------------------------


def _tool_call_name(raw_item: object) -> str:
    """Extract the tool name from a raw response item."""
    if isinstance(raw_item, dict):
        return cast(str, raw_item.get("name") or raw_item.get("type") or "")
    return cast(
        str, getattr(raw_item, "name", None) or getattr(raw_item, "type", None) or ""
    )


async def _print_stream(result) -> None:  # noqa: ANN001
    """Print streamed text deltas and tool-call activity to the console."""
    saw_text = False
    active_tool: str | None = None

    async for event in result.stream_events():
        # --- raw model events ---
        if event.type == "raw_response_event":
            data = event.data
            if isinstance(data, ResponseTextDeltaEvent):
                if active_tool is not None:
                    print()
                    active_tool = None
                if not saw_text:
                    print("\nassistant> ", end="", flush=True)
                    saw_text = True
                print(data.delta, end="", flush=True)
                continue
            if isinstance(data, ResponseFunctionCallArgumentsDeltaEvent):
                if saw_text:
                    print()
                    saw_text = False
                if active_tool is None:
                    active_tool = "tool"
                continue
            # tool-call completion frames
            event_type = getattr(data, "type", None)
            if event_type == "response.output_item.done" and active_tool is not None:
                active_tool = None
            continue

        # --- run-item events (tool calls / outputs) ---
        if event.type != "run_item_stream_event":
            continue

        if saw_text:
            print()
            saw_text = False
        if active_tool is not None:
            print()
            active_tool = None

        if event.name == "tool_called":
            name = _tool_call_name(event.item.raw_item)
            if name:
                print(f"  [tool] {name}")
        elif event.name == "tool_output":
            output_text = str(getattr(event.item, "output", ""))
            if len(output_text) > 200:
                output_text = output_text[:200] + "…"
            print(f"  [output] {output_text}")

    if saw_text:
        print()


# ---------------------------------------------------------------------------
# Sandbox file extraction
# ---------------------------------------------------------------------------


async def _copy_sandbox_output(session, output_dir: Path) -> list[Path]:
    """Read files from /workspace/output/ in the sandbox and write them locally."""
    output_dir.mkdir(parents=True, exist_ok=True)
    copied: list[Path] = []

    # List files via exec since the SandboxSession wrapper doesn't expose ls().
    ls_result = await session.exec(
        "find",
        "/workspace/output",
        "-maxdepth",
        "1",
        "-type",
        "f",
        shell=False,
    )
    if not ls_result.ok():
        stderr = ls_result.stderr.decode(errors="replace").strip()
        print(
            f"⚠  Could not list sandbox output (exit {ls_result.exit_code}): {stderr}",
            file=sys.stderr,
        )
        return copied

    filenames = [
        line.strip() for line in ls_result.stdout.decode().splitlines() if line.strip()
    ]

    for filepath in filenames:
        handle = await session.read(Path(filepath))
        try:
            payload = handle.read()
        finally:
            handle.close()

        local_path = output_dir / Path(filepath).name
        if isinstance(payload, str):
            local_path.write_text(payload, encoding="utf-8")
        else:
            local_path.write_bytes(bytes(payload))
        copied.append(local_path)

    return copied


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def run(prompt: str, output_dir: Path, image: Path | None = None) -> None:
    worker_url = os.environ.get("CLOUDFLARE_SANDBOX_WORKER_URL", "")
    if not worker_url:
        print(
            "Error: CLOUDFLARE_SANDBOX_WORKER_URL is not set. Check your .env file.",
            file=sys.stderr,
        )
        sys.exit(1)

    agent = SandboxAgent(
        name="JavaScript Developer",
        model=MODEL,
        instructions=INSTRUCTIONS,
        capabilities=[Shell(), Filesystem()],
    )

    client = CloudflareSandboxClient()
    options = CloudflareSandboxClientOptions(worker_url=worker_url)
    session = await client.create(manifest=agent.default_manifest, options=options)

    try:
        async with session:
            # Copy the image into the sandbox so the agent can inspect it.
            if image is not None:
                sandbox_image_path = f"/workspace/{image.name}"
                await session.write(
                    Path(sandbox_image_path),
                    io.BytesIO(image.read_bytes()),
                )
                prompt = (
                    f"An image has been provided at `{sandbox_image_path}` as a visual "
                    f"reference. Use view_image to inspect it before you start.\n\n"
                    f"{prompt}"
                )

            run_config = RunConfig(
                sandbox=SandboxRunConfig(session=session),
                workflow_name="basic-js-sandbox",
                tracing_disabled=True,
            )

            print(f"\U0001f680 Sending task to sandbox agent ({MODEL})\u2026")
            result = Runner.run_streamed(agent, prompt, run_config=run_config)
            await _print_stream(result)

            # --- extract output files ---
            copied = await _copy_sandbox_output(session, output_dir)
            if copied:
                print(f"\n\u2705 Copied {len(copied)} file(s) to {output_dir}:")
                for path in copied:
                    print(f"   {path}")
            else:
                print("\n\u26a0  Agent did not produce any output files.")
    finally:
        await client.delete(session)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run a one-shot JavaScript coding task in a Cloudflare Sandbox."
    )
    parser.add_argument("prompt", help="Coding task for the agent.")
    parser.add_argument(
        "--output",
        default=".",
        help="Directory to save output files (default: current directory).",
    )
    parser.add_argument(
        "--image",
        default=None,
        help="Path to a local image to upload as a visual reference (e.g. a mockup).",
    )
    args = parser.parse_args()

    image_path = Path(args.image).resolve() if args.image else None
    if image_path is not None and not image_path.is_file():
        print(f"Error: image not found: {image_path}", file=sys.stderr)
        sys.exit(1)

    asyncio.run(run(args.prompt, Path(args.output).resolve(), image=image_path))


if __name__ == "__main__":
    main()
