# Basic Cloudflare Sandbox Demo

A minimal single-file demo that runs a one-shot coding agent against a
[Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) using the
[OpenAI Agents SDK](https://github.com/openai/openai-agents-python).

The agent acts as a JavaScript developer with access to bun, Node.js, and npm
inside the sandbox. It executes a coding task described in a prompt, then copies
the output files to the host filesystem.

## Prerequisites

- Python 3.12+
- [uv](https://docs.astral.sh/uv/)
- An OpenAI API key with access to `gpt-5.4`
- A Cloudflare Sandbox worker URL and API key

## Setup

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
# edit .env with your actual keys
```

## Usage

```bash
# Run with a coding prompt — output lands in the current directory
uv run main.py "Create a hello world HTTP server using Bun.serve"

# Specify an output directory
uv run main.py --output ./results "Build a CLI tool that converts CSV to JSON"

# Provide a mockup image as a visual reference
uv run main.py --image mockup.png "Build an HTML page that matches this mockup"
```

The agent streams tool calls and text to the console as it works. When
finished, any files the agent produced are copied from the sandbox into the
output directory.

### Output convention

The agent is instructed to place all output under `/workspace/output/` inside
the sandbox. If the task produces multiple files the agent zips them into
`result.zip`; otherwise a single file is copied as-is.

### Image input

Pass `--image <path>` to upload a local image (PNG, JPEG, etc.) into the
sandbox before the agent starts. The image is copied to `/workspace/` and the
agent is prompted to inspect it with `view_image` before coding. This is useful
for tasks like building an HTML page from a design mockup.

## Configuration

| Variable                        | Description                           |
| ------------------------------- | ------------------------------------- |
| `OPENAI_API_KEY`                | OpenAI API key                        |
| `CLOUDFLARE_SANDBOX_API_KEY`    | Cloudflare Sandbox API key            |
| `CLOUDFLARE_SANDBOX_WORKER_URL` | URL of your Cloudflare Sandbox worker |
