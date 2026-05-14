# Codex Sandbox SDK

Run [OpenAI Codex](https://developers.openai.com/codex) on Cloudflare Sandboxes! This example shows a basic setup that does the following:

- The worker accepts POST requests that include a repository URL and a task description
- The worker spawns a sandbox, clones the repository and runs `codex exec` in non-interactive mode with the provided task
- Codex will edit all necessary files and return when done
- The Worker will return a response with the output logs from Codex and the diff left on the repo.

## Credential isolation

The OpenAI credential never enters the container. The worker subclasses `Sandbox` with `interceptHttps = true` and registers `outboundByHost` handlers for `api.openai.com` and `chatgpt.com` that swap a placeholder header for the real secret on its way out. Inside the container, codex only sees `OPENAI_API_KEY=proxy-injected` (or a placeholder `~/.codex/auth.json`) -- enough to make it pick the right auth mode, but useless if leaked.

## Network isolation

Internet access is disabled inside the container, bar the OpenAI, ChatGPT and GitHub APIs; this lets `codex exec` run headlessly without needing to ask for permissions.

## Setup

Copy `.dev.vars.example` to `.dev.vars` and fill in **one** of:

```
# Pay-per-token
OPENAI_API_KEY=<your-api-key>

# OR ChatGPT subscription -- generate by running `codex login`, then paste
# the contents of ~/.codex/auth.json into the variable as a single-line JSON.
CODEX_AUTH_JSON=<your-auth-json>
```

If both are set, the API key wins.

For production, set secrets with:

```bash
wrangler secret put OPENAI_API_KEY
# or
wrangler secret put CODEX_AUTH_JSON
```

> **Note on `CODEX_AUTH_JSON`:** Treat the file like a password -- it contains
> access tokens. Codex will refresh stale tokens during a run, but in this
> stateless setup the refreshed bundle isn't persisted back to your secret
> store. For long-lived deployments, prefer the API key route or follow the
> [CI/CD auth guide](https://developers.openai.com/codex/auth/ci-cd-auth) to
> persist the refreshed file between runs.

## Usage

```bash
curl -X POST http://localhost:8787/ \
  -H 'Content-Type: application/json' \
  -d '{"repo": "https://github.com/owner/repo", "task": "fix the typo in README.md"}'
```

Response:

```json
{
  "logs": "...",
  "diff": "..."
}
```

Happy hacking!
