# Cloudflare Sandbox — Agent QA Test Harness

An agent-driven test harness that exercises every capability of the `cloudflare-sandbox-bridge` Cloudflare Worker. The harness creates a `SandboxAgent` with Shell and ApplyPatch capabilities, connects it to a `CloudflareSandboxClient`, and prompts it through a structured QA script. The agent runs all tests inside the sandbox, reports pass/fail per check, and validates session persistence across a pause/resume cycle.

## Prerequisites

- Python 3.12.x (pinned in `pyproject.toml` as `>=3.12,<3.13`)
- [uv](https://docs.astral.sh/uv/) installed
- A deployed `cloudflare-sandbox-bridge` Cloudflare Worker
- An OpenAI API key with access to `gpt-5.2-codex`
- A Cloudflare R2 bucket and API credentials for remote snapshot storage

## Setup

```bash
cp .env.example .env
# Fill in all values in .env
```

Required variables:

| Variable                                  | Description                                |
| ----------------------------------------- | ------------------------------------------ |
| `CLOUDFLARE_SANDBOX_WORKER_URL`           | Base URL of the deployed Cloudflare Worker |
| `CLOUDFLARE_SANDBOX_API_KEY`              | Bearer token for worker auth (optional)    |
| `OPENAI_API_KEY`                          | OpenAI API key                             |
| `CLOUDFLARE_SANDBOX_R2_BUCKET`            | R2 bucket name for snapshot storage        |
| `CLOUDFLARE_SANDBOX_R2_ACCOUNT_ID`        | Cloudflare account ID                      |
| `CLOUDFLARE_SANDBOX_R2_ACCESS_KEY_ID`     | R2 API access key                          |
| `CLOUDFLARE_SANDBOX_R2_SECRET_ACCESS_KEY` | R2 API secret key                          |

## Usage

Run the full harness (phases 1–7, then pause for resume):

```bash
./script/start
```

Resume from a previous run (skips phases 1–7, runs verification only):

```bash
./script/start --resume
```

## Test Phases

The agent receives one prompt per phase and executes all tests using the shell tool.

### Phase 1 — Basic Operations

Echo, exit codes, stderr capture, text and binary file round-trips, nested directory creation, nonexistent file errors, environment characterization.

### Phase 2 — Large File & Complex Data Stress

10 MB random binary with SHA-256 verification, large exec output (5 MB base64 pipeline), depth-200 nested JSON, Unicode stress (emoji, CJK, RTL, combining characters), 500-file batch creation.

### Phase 3 — PTY / Process Stress

Piped interactive commands, `yes | head -n 50000`, 100 KB binary-to-base64 pipeline, rapid sequential loops, concurrent background processes, signal handling, 10,000-element pipe chains.

### Phase 4 — Volume Stress

200 sequential echo commands, 200 sequential write-read cycles with verification, 50 parallel file writes, 100-iteration mixed operation bursts, timing measurements.

### Phase 5 — Pre-Pause Sentinel

Writes sentinel data to `/workspace/sentinel/`: a harness-generated UUID, ISO timestamp, recursive workspace checksum, environment snapshot, and structured JSON. This data anchors the resume verification.

### Phase 6 — Bucket Mount

Mounts the configured R2 bucket at `/workspace/r2-test` via the bridge's `POST /sandbox/:id/mount` endpoint, then prompts the agent to write files to the mount, read them back, list contents, and clean up. Verifies end-to-end bucket mount functionality.

### Phase 7 — Bucket Unmount

Unmounts the R2 bucket via `POST /sandbox/:id/unmount`, then prompts the agent to verify the mount point is no longer accessible and the sandbox remains functional.

### Phase 8 — Post-Resume Verification

After the pause, the harness deserializes the session state from `session_state.json`, resumes the sandbox session via `client.resume()`, and prompts the agent to verify all sentinel files survived, the 500-file batch is intact, and the sandbox is functional.

## How It Works

1. `src/main.py` builds a `SandboxAgent` with `Shell` + `ApplyPatch` capabilities backed by `CloudflareSandboxClient`.
2. Each phase prompt is loaded from `src/prompts/*.md` and sent as a user message via `Runner.run_streamed()`.
3. The agent streams responses and tool calls; the harness prints text deltas and tool-call banners.
4. After Phase 5, the sandbox workspace is persisted to R2 via `session.stop()` (using `RemoteSnapshotSpec` + `R2SnapshotClient`) and the `CloudflareSandboxSessionState` is serialized to `src/session_state.json`.
5. Phases 6–7 exercise bucket mount/unmount via direct HTTP calls to the bridge, with agent verification of filesystem state.
6. The harness pauses and waits for user input.
7. On resume (`--resume` or pressing Enter), the session state is deserialized, the sandbox session is reconnected via `client.resume()`, and the verification prompt runs.

## Files

| File                                   | Purpose                                                      |
| -------------------------------------- | ------------------------------------------------------------ |
| `src/main.py`                          | Entry point and agent lifecycle orchestrator                 |
| `src/config.py`                        | Environment variable loading and validation                  |
| `src/prompts/phase1_basic_ops.md`      | Phase 1 QA prompt                                            |
| `src/prompts/phase2_stress_large.md`   | Phase 2 QA prompt                                            |
| `src/prompts/phase3_stress_pty.md`     | Phase 3 QA prompt                                            |
| `src/prompts/phase4_stress_volume.md`  | Phase 4 QA prompt                                            |
| `src/prompts/phase5_pre_pause.md`      | Phase 5 QA prompt (template with `{magic_uuid}` placeholder) |
| `src/prompts/phase6_bucket_mount.md`   | Phase 6 QA prompt (template with `{magic_uuid}` placeholder) |
| `src/prompts/phase7_bucket_unmount.md` | Phase 7 QA prompt                                            |
| `script/start`                         | Shell wrapper: `uv run src/main.py`                          |
| `.env.example`                         | Template for required environment variables                  |

## SSL / Corporate VPN

The harness auto-detects CA bundles from `REQUESTS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, the system store at `/etc/ssl/certs/ca-certificates.crt`, or the `certifi` package. Python 3.12 is required for compatibility with certain corporate CA certificate annotations.
