# cloudflare-sandbox-test-harness

Agent-driven QA test harness for the `cloudflare-sandbox-bridge` Cloudflare Worker. Uses the OpenAI Agents SDK (`openai-agents[cloudflare]`) to exercise sandbox exec, file I/O, process management, and session persistence against a production deployment.

## Key files

- `src/main.py` — Entry point. Builds a `SandboxAgent`, runs seven QA phase turns via `Runner.run_streamed()`, persists workspace snapshots to R2, and handles pause/resume with `--resume` flag. Includes `R2SnapshotClient` for S3-compatible snapshot storage. Dependencies and Python version are declared inline via PEP 723 script metadata.
- `src/config.py` — Loads and validates environment variables from the process environment into a typed `Config` dataclass.
- `src/prompts/phase1_basic_ops.md` — QA prompt: echo, exit codes, stderr, file read/write, binary round-trip, nested dirs.
- `src/prompts/phase2_stress_large.md` — QA prompt: 10 MB binary + SHA-256, large output, deep JSON, Unicode, 500-file batch.
- `src/prompts/phase3_stress_pty.md` — QA prompt: pipes, long output, rapid loops, background jobs, signals, pipe chains.
- `src/prompts/phase4_stress_volume.md` — QA prompt: 200 sequential ops, 50 parallel writes, mixed bursts, timing.
- `src/prompts/phase5_pre_pause.md` — QA prompt: writes UUID/timestamp/checksum/env sentinels for resume verification. Contains `{magic_uuid}` template placeholder.
- `src/prompts/phase6_bucket_mount.md` — QA prompt: mount R2 bucket via bridge HTTP API, write/read/list files in the mount.
- `src/prompts/phase7_bucket_unmount.md` — QA prompt: unmount R2 bucket, verify mount point is gone and sandbox still functional.
- `script/start` — Shell wrapper that runs `uv run --env-file .env src/main.py`.
- `.env.example` — Template for required environment variables (copy to `.env`).
- `src/session_state.json` — Generated at runtime. Serialized `CloudflareSandboxSessionState` used for session resume.

## Development

```bash
cp .env.example .env
# Fill in credentials
./script/start          # full run (phases 1-7 + pause + resume verification)
./script/start --resume # resume from existing session_state.json
```

Requires Python 3.12.x. Dependencies are declared inline in `src/main.py` via [PEP 723](https://peps.python.org/pep-0723/) script metadata; uv resolves and caches them on first run. There is no `pyproject.toml` or lockfile. Environment variables are loaded by `uv run --env-file .env` rather than by python-dotenv.

## Architecture

The harness does not test sandbox APIs directly. It creates a `SandboxAgent` with `Shell` and `Filesystem` capabilities, connects it to `CloudflareSandboxClient` via `SandboxRunConfig`, and sends QA prompts as user messages through `Runner.run_streamed()`. The agent executes all tests inside the sandbox using its tools and reports results. The harness manages session lifecycle, prompt loading, and the interactive pause/resume flow.

Session persistence uses the SDK's `RemoteSnapshotSpec` with a custom `R2SnapshotClient` (S3-compatible via boto3) for workspace archival to Cloudflare R2. The `CloudflareSandboxSessionState` Pydantic model handles sandbox state serialization.
