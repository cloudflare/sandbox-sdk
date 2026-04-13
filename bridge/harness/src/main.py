"""Cloudflare Sandbox — Agent QA Test Harness.

Creates a SandboxAgent backed by CloudflareSandboxClient, runs it through seven
QA phases via prompted turns, then pauses for the user to stop/restart the
sandbox and verifies session restoration.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import uuid
from pathlib import Path
from typing import Any

import aiohttp

# Ensure aiohttp (and other stdlib ssl consumers) can verify TLS certs.
# In corp VPN environments the custom CA bundle is typically at the path
# referenced by NODE_EXTRA_CA_CERTS or REQUESTS_CA_BUNDLE.  Fall back to
# the system bundle, then certifi.
import certifi

_CA_CANDIDATES = [
    os.environ.get("REQUESTS_CA_BUNDLE", ""),
    os.environ.get("NODE_EXTRA_CA_CERTS", ""),
    "/etc/ssl/certs/ca-certificates.crt",
    certifi.where(),
]
for _ca in _CA_CANDIDATES:
    if _ca and os.path.isfile(_ca):
        os.environ["SSL_CERT_FILE"] = _ca
        break

from openai.types.responses import ResponseTextDeltaEvent

from agents import Runner, set_tracing_disabled
from agents.extensions.sandbox.cloudflare import (
    CloudflareSandboxClient,
    CloudflareSandboxClientOptions,
    CloudflareSandboxSessionState,
)
from agents.run import RunConfig
from agents.sandbox import Manifest, RemoteSnapshotSpec, SandboxAgent, SandboxRunConfig
from agents.sandbox.capabilities import ApplyPatch, Shell
from agents.sandbox.session import Dependencies

from config import Config

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROMPTS_DIR = Path(__file__).parent / "prompts"
SESSION_STATE_PATH = Path(__file__).parent / "session_state.json"
R2_SNAPSHOT_DEPENDENCY_KEY = "harness.r2_snapshot_client"
R2_SNAPSHOT_PREFIX = "cloudflare-sandbox-harness/snapshots"

# ---------------------------------------------------------------------------
# R2 snapshot client (S3-compatible) for RemoteSnapshot
# ---------------------------------------------------------------------------


class R2SnapshotClient:
    """S3-compatible snapshot client for Cloudflare R2."""

    def __init__(self, *, bucket: str, endpoint_url: str, access_key_id: str, secret_access_key: str, prefix: str) -> None:
        import boto3

        self._bucket = bucket
        self._prefix = prefix.rstrip("/")
        self._s3 = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
        )

    def upload(self, snapshot_id: str, data: io.IOBase) -> None:
        self._s3.upload_fileobj(data, self._bucket, self._object_key(snapshot_id))

    def download(self, snapshot_id: str) -> io.IOBase:
        buffer = io.BytesIO()
        self._s3.download_fileobj(self._bucket, self._object_key(snapshot_id), buffer)
        buffer.seek(0)
        return buffer

    def exists(self, snapshot_id: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            self._s3.head_object(Bucket=self._bucket, Key=self._object_key(snapshot_id))
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return False
            raise
        return True

    def _object_key(self, snapshot_id: str) -> str:
        return f"{self._prefix}/{snapshot_id}.tar"


# ---------------------------------------------------------------------------
# Developer instructions — frames the agent's QA role
# ---------------------------------------------------------------------------

DEVELOPER_INSTRUCTIONS = """\
You are a QA engineer testing a Cloudflare-backed sandbox environment.

For each phase the user sends you, execute every test described in the prompt
using the shell tool. Run each command, capture its output, and compare against
the expected result.

After each test, report **PASS** or **FAIL** with the observed vs expected
values. If a test fails, include the full command output for debugging.

At the end of each phase, print a Markdown summary table of all test results.

Important rules:
- Execute commands exactly as written unless you need to adapt for the sandbox
  environment (e.g. missing tools). If you adapt, explain why.
- Do not skip any test. If a test cannot run, report SKIP with a reason.
- Be precise about pass/fail criteria — match expected values exactly.
- For timing tests, just report the measured values (no pass/fail).
"""

# ---------------------------------------------------------------------------
# Resume verification prompt
# ---------------------------------------------------------------------------

RESUME_VERIFICATION_PROMPT = """\
The agent session has just been resumed from a serialized snapshot after a
pause. The sandbox workspace should have been restored.

Verify the following:

## Check 1 — Magic sentinel
Run: `cat /workspace/sentinel/magic.txt`
Compare the value to what was written in Phase 5.

## Check 2 — Timestamp sentinel
Run: `cat /workspace/sentinel/timestamp.txt`
Confirm the file exists and contains a timestamp (does not need to match current time).

## Check 3 — Structured JSON sentinel
Run: `python3 -c "import json; d=json.load(open('/workspace/sentinel/structured.json')); print(d)"`
Confirm the JSON parses and contains the expected fields including the magic value.

## Check 4 — File inventory
Run: `ls -la /workspace/sentinel/`
Confirm all five sentinel files exist.

## Check 5 — Workspace integrity
Run: `ls /workspace/batch | wc -l`
Expected: 500 (from Phase 2).

## Check 6 — Basic sandbox functionality
Run:
```
echo "post-resume-test"
pwd
whoami
```
Confirm the sandbox is functional.

## Report
Print a summary table of all checks with PASS/FAIL.
Then print: "Session restore verification complete."
"""


def _load_prompt(name: str, **kwargs: str) -> str:
    """Load a prompt from the prompts/ directory, applying format substitutions."""
    text = (PROMPTS_DIR / name).read_text(encoding="utf-8")
    if kwargs:
        text = text.replace("{magic_uuid}", kwargs.get("magic_uuid", ""))
    return text


# ---------------------------------------------------------------------------
# Bridge HTTP helpers for mount / unmount
# ---------------------------------------------------------------------------


async def _bridge_mount(
    config: Config,
    sandbox_id: str,
    bucket: str,
    mount_path: str,
) -> None:
    """Mount an R2 bucket into the sandbox via the bridge HTTP API."""
    url = f"{config.worker_url.rstrip('/')}/v1/sandbox/{sandbox_id}/mount"
    headers: dict[str, str] = {}
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"

    payload: dict[str, Any] = {
        "bucket": bucket,
        "mountPath": mount_path,
        "options": {
            "endpoint": config.r2_endpoint_url,
            "credentials": {
                "accessKeyId": config.r2_access_key_id,
                "secretAccessKey": config.r2_secret_access_key,
            },
        },
    }

    async with aiohttp.ClientSession(headers=headers) as http:
        async with http.post(url, json=payload) as resp:
            if resp.status != 200:
                body = await resp.text()
                raise RuntimeError(f"mount failed (HTTP {resp.status}): {body}")
            print(f"  ✓ Mounted bucket '{bucket}' at {mount_path}")


async def _bridge_unmount(
    config: Config,
    sandbox_id: str,
    mount_path: str,
) -> None:
    """Unmount a bucket from the sandbox via the bridge HTTP API."""
    url = f"{config.worker_url.rstrip('/')}/v1/sandbox/{sandbox_id}/unmount"
    headers: dict[str, str] = {}
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"

    payload = {"mountPath": mount_path}

    async with aiohttp.ClientSession(headers=headers) as http:
        async with http.post(url, json=payload) as resp:
            if resp.status != 200:
                body = await resp.text()
                raise RuntimeError(f"unmount failed (HTTP {resp.status}): {body}")
            print(f"  ✓ Unmounted {mount_path}")

async def run_turn(
    agent: SandboxAgent,
    prompt: str,
    run_config: RunConfig,
) -> None:
    """Run a single agent turn: stream text deltas and tool-call banners."""
    result = Runner.run_streamed(
        agent,
        prompt,
        run_config=run_config,
        max_turns=100,
    )
    saw_text = False

    async for event in result.stream_events():
        if event.type == "raw_response_event" and isinstance(
            event.data, ResponseTextDeltaEvent
        ):
            if not saw_text:
                saw_text = True
            print(event.data.delta, end="", flush=True)
            continue

        if event.type != "run_item_stream_event":
            continue

        if saw_text:
            print()
            saw_text = False

        if event.name == "tool_called":
            raw = event.item.raw_item
            name = ""
            if isinstance(raw, dict):
                name = raw.get("name", "") or raw.get("type", "")
            else:
                name = getattr(raw, "name", "") or getattr(raw, "type", "")
            print(f"  $ {name}")
        elif event.name == "tool_output":
            pass  # tool output is visible through the model's next response

    if saw_text:
        print()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Cloudflare Sandbox QA Harness")
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Skip phases 1-5 and resume from an existing session_state.json.",
    )
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    set_tracing_disabled(True)

    # ── Load configuration ──
    print("Loading config from .env …")
    config = Config.from_env()
    print("✓ Config valid:")
    config.print_summary()
    print()

    # ── Build agent ──
    agent = SandboxAgent(
        name="QA Sandbox Agent",
        model="gpt-5.2-codex",
        instructions="Follow the user's QA instructions precisely.",
        developer_instructions=DEVELOPER_INSTRUCTIONS,
        default_manifest=Manifest(root="/workspace"),
        capabilities=[Shell(), ApplyPatch()],
    )

    # ── Build R2 snapshot client and dependencies ──
    r2_client = R2SnapshotClient(
        bucket=config.r2_bucket,
        endpoint_url=config.r2_endpoint_url,
        access_key_id=config.r2_access_key_id,
        secret_access_key=config.r2_secret_access_key,
        prefix=R2_SNAPSHOT_PREFIX,
    )
    dependencies = Dependencies().bind_value(R2_SNAPSHOT_DEPENDENCY_KEY, r2_client)

    client = CloudflareSandboxClient(dependencies=dependencies)
    options = CloudflareSandboxClientOptions(
        worker_url=config.worker_url,
        api_key=config.api_key or None,
        exec_timeout_s=120.0,
        request_timeout_s=300.0,
    )

    if not args.resume:
        # Generate a unique magic value for the sentinel phase
        magic_uuid = str(uuid.uuid4())

        # ── Load prompts ──
        phase_prompts = [
            ("Phase 1: Basic Operations", _load_prompt("phase1_basic_ops.md")),
            ("Phase 2: Large File & Complex Data Stress", _load_prompt("phase2_stress_large.md")),
            ("Phase 3: PTY / Process Stress", _load_prompt("phase3_stress_pty.md")),
            ("Phase 4: Volume Stress", _load_prompt("phase4_stress_volume.md")),
            (
                "Phase 5: Pre-Pause Sentinel",
                _load_prompt("phase5_pre_pause.md", magic_uuid=magic_uuid),
            ),
        ]

        # ── Create a sandbox session with R2 remote snapshot ──
        snapshot_spec = RemoteSnapshotSpec(
            client_dependency_key=R2_SNAPSHOT_DEPENDENCY_KEY,
        )
        session = await client.create(
            manifest=agent.default_manifest,
            snapshot=snapshot_spec,
            options=options,
        )
        await session.start()

        run_config = RunConfig(
            sandbox=SandboxRunConfig(session=session),
            workflow_name="QA Harness",
        )

        try:
            for label, prompt in phase_prompts:
                print(f"\n{'═' * 3} {label} {'═' * max(1, 60 - len(label))}")
                await run_turn(agent, prompt, run_config)

            # ── Phase 6: Bucket Mount ──
            mount_path = "/workspace/r2-test"
            print(f"\n{'═' * 3} Phase 6: Bucket Mount {'═' * 38}")
            print(f"  Mounting R2 bucket '{config.r2_bucket}' at {mount_path} …")
            await _bridge_mount(
                config,
                session.state.sandbox_id,
                config.r2_bucket,
                mount_path,
            )
            mount_prompt = _load_prompt("phase6_bucket_mount.md", magic_uuid=magic_uuid)
            await run_turn(agent, mount_prompt, run_config)

            # ── Phase 7: Bucket Unmount ──
            print(f"\n{'═' * 3} Phase 7: Bucket Unmount {'═' * 36}")
            print(f"  Unmounting {mount_path} …")
            await _bridge_unmount(config, session.state.sandbox_id, mount_path)
            unmount_prompt = _load_prompt("phase7_bucket_unmount.md")
            await run_turn(agent, unmount_prompt, run_config)

            # Persist workspace snapshot for resume
            await session.stop()
        except Exception:
            await session.shutdown()
            raise

        # Serialize session state for later resume
        state_json = session.state.model_dump_json(indent=2)
        SESSION_STATE_PATH.write_text(state_json, encoding="utf-8")
        print(f"\nSession state saved to {SESSION_STATE_PATH}")
        print(f"Magic sentinel value: {magic_uuid}")
        print()
        input(">>> Press Enter to resume after stopping/restarting the sandbox... ")
    else:
        if not SESSION_STATE_PATH.exists():
            raise RuntimeError(
                f"No session state found at {SESSION_STATE_PATH}. "
                "Run without --resume first to complete phases 1-7."
            )
        print(f"Skipping phases 1-7, resuming from {SESSION_STATE_PATH}")

    # ── Resume: restore session, verify ──
    print(f"\nRestoring session from {SESSION_STATE_PATH} …")
    state_data = json.loads(SESSION_STATE_PATH.read_text(encoding="utf-8"))
    restored_state = CloudflareSandboxSessionState.model_validate(state_data)

    resumed_session = await client.resume(restored_state)
    await resumed_session.start()

    run_config = RunConfig(
        sandbox=SandboxRunConfig(session=resumed_session),
        workflow_name="QA Harness — Resume",
    )

    print(f"\n{'═' * 3} Phase 8: Post-Resume Verification {'═' * 25}")
    try:
        await run_turn(agent, RESUME_VERIFICATION_PROMPT, run_config)
    finally:
        await client.delete(resumed_session)

    print("\n✓ All phases complete.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nInterrupted.")
