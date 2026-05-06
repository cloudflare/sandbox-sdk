# Claude Code Sandbox SDK

Run Claude Code on Cloudflare Sandboxes! This example shows a basic setup that does the following:

- The worker accepts POST requests that include a repository URL and a task description
- The worker spawns a sandbox, clones the repository and starts Claude Code in headless mode with the provided task
- Claude Code will edit all necessary files and return when done
- The Worker will return a response with the output logs from Claude and the diff left on the repo.

## Credential isolation

The Anthropic credential never enters the container. The worker subclasses `Sandbox` with `interceptHttps = true` and registers an `outboundByHost` handler for `api.anthropic.com` that swaps a placeholder header for the real secret on its way out. Inside the container, claude only sees `ANTHROPIC_API_KEY=proxy-injected` (or `CLAUDE_CODE_OAUTH_TOKEN=proxy-injected`) -- enough to make it pick the right auth header, but useless if leaked.

## Setup

Copy `.dev.vars.example` to `.dev.vars` and fill in **one** of:

```
# Pay-per-token
ANTHROPIC_API_KEY=<your-api-key>

# OR Claude.ai subscription -- get a token by running: claude setup-token
CLAUDE_CODE_OAUTH_TOKEN=<your-oauth-token>
```

If both are set, the API key wins.

For production, set secrets with:
```bash
wrangler secret put ANTHROPIC_API_KEY
# or
wrangler secret put CLAUDE_CODE_OAUTH_TOKEN
```

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
