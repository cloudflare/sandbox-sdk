# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = [
#     "openai-agents[cloudflare]",
#     "rich",
# ]
#
# [tool.uv.sources]
# openai-agents = { git = "ssh://git@github.com/OpenAI-Early-Access/openai-agents-python-preview.git", rev = "public-main" }
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

from openai.types.responses import ResponseTextDeltaEvent
from rich.console import Console

from agents import Runner, RunResultStreaming
from agents.extensions.sandbox.cloudflare import (
    CloudflareSandboxClient,
    CloudflareSandboxClientOptions,
)
from agents.run import RunConfig
from agents.sandbox import SandboxAgent, SandboxRunConfig
from agents.sandbox.capabilities import Filesystem, Shell
from agents.sandbox.session import SandboxSession
from agents.stream_events import RawResponsesStreamEvent, RunItemStreamEvent

MODEL = "gpt-5.4"

INSTRUCTIONS = """\
You are an expert JavaScript / TypeScript developer working inside a sandbox.
The sandbox has bun, node, and npm available on the PATH.
Your workspace is mounted at /workspace.

When the user gives you a coding task:

1. Implement the solution inside /workspace.
2. Test that it works by running it (e.g. `bun run`, `node`, or `npm test`).
3. Use apply_patch to create or edit files. IMPORTANT: Stay within /workspace.
4. Use exec_command to run commands.
5. If an image was provided as a visual reference, use view_image to inspect it
   before you start coding. The image path will be mentioned in the task prompt.
6. IMPORTANT: Copy **only the relevant generated files** into /workspace/output/.
   - If the deliverable is a single file, copy it directly.
   - If there are multiple files, bundle them into /workspace/output/result.zip
     using a command like `cd /workspace && zip -r output/result.zip <files>`.
7. Confirm what you placed in /workspace/output/ and briefly explain how to use it.

IMPORTANT: Always create the output directory first: `mkdir -p /workspace/output`.
""".strip()


# ---------------------------------------------------------------------------
# Streaming helpers
# ---------------------------------------------------------------------------

console = Console(highlight=False)


async def _print_stream(result: RunResultStreaming) -> None:
    """Print streamed text deltas and tool-call banners."""
    in_text = False

    async for event in result.stream_events():
        if isinstance(event, RawResponsesStreamEvent):
            if isinstance(event.data, ResponseTextDeltaEvent):
                if not in_text:
                    console.print("assistant> ", end="", style="bold")
                    in_text = True
                console.print(event.data.delta, end="", highlight=False)

        elif isinstance(event, RunItemStreamEvent):
            if in_text:
                console.print()
                in_text = False

            if event.item.type == "tool_call_item":
                name = getattr(event.item, "tool_name", None) or ""
                label = f"  [dim]\\[{name}][/dim]" if name else "  [dim]Working\u2026[/dim]"
                console.print(label)

    if in_text:
        console.print()

# ---------------------------------------------------------------------------
# Sandbox file extraction
# ---------------------------------------------------------------------------


async def _copy_sandbox_output(session: SandboxSession, output_dir: Path) -> list[Path]:
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
        console.print(
            f"[yellow]⚠[/yellow]  Could not list sandbox output (exit {ls_result.exit_code}): {stderr}",
            stderr=True,
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
        console.print(
            "[red]Error:[/red] CLOUDFLARE_SANDBOX_WORKER_URL is not set. Check your .env file.",
            stderr=True,
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
            await session.mkdir("/workspace/output")

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

            console.print(f"\U0001f680 Sending task to sandbox agent ({MODEL})\u2026")
            result = Runner.run_streamed(agent, prompt, run_config=run_config)
            await _print_stream(result)

            # --- extract output files ---
            copied = await _copy_sandbox_output(session, output_dir)
            if copied:
                console.print(
                    f"\n[green]✅[/green] Copied {len(copied)} file(s) to {output_dir}:"
                )
                for path in copied:
                    console.print(f"   {path}")
            else:
                console.print(
                    "\n[yellow]⚠[/yellow]  Agent did not produce any output files. Perhaps check your prompt?"
                )
    finally:
        await client.delete(session)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run a one-shot JavaScript coding task in a Cloudflare Sandbox."
    )
    parser.add_argument(
        "prompt",
        help="Coding task for the agent.",
        default="Write me a Python script that produces a Haiku about cheese",
    )
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
        console.print(f"[red]Error:[/red] image not found: {image_path}", stderr=True)
        sys.exit(1)

    asyncio.run(run(args.prompt, Path(args.output).resolve(), image=image_path))


if __name__ == "__main__":
    main()
