# Agents — basic demo

This directory contains a single-file uv script (`main.py`) that demonstrates
the OpenAI Agents SDK with a Cloudflare Sandbox backend.

## Conventions

- **Single file**: everything lives in `main.py` with inline `# /// script`
  metadata. Do not add a `pyproject.toml`.
- **Formatting**: run `uv run ruff format main.py` and
  `uv run ruff check --fix main.py` before committing.
- **Dependencies**: declared in the uv script header. The `openai-agents`
  package is installed from the early-access git branch.
- **Credentials**: loaded from `.env` via `python-dotenv`. Never hard-code
  secrets. See `.env.example` for the required variables.
- **Model**: uses `gpt-5.4`.
