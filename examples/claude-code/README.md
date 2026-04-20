# Claude Code Sandbox SDK

Run Claude Code on Cloudflare Sandboxes! This example shows a basic setup that does the following:

- The worker accepts POST requests that include a repository URL and a task description
- The worker spawns a sandbox, clones the repository and starts Claude Code in headless mode with the provided task
- Claude Code will edit all necessary files and return when done
- The Worker will return a response with the output logs from Claude and the diff left on the repo.

## Routes

| Route | Auth method |
|-------|-------------|
| `POST /` | Anthropic API key (`ANTHROPIC_API_KEY`) — pay per token |
| `POST /sub` | Claude.ai subscription (`CLAUDE_CODE_OAUTH_TOKEN`) |

## Setup

Copy `.dev.vars.example` to `.dev.vars` and fill in the var(s) you need:

```
# For POST /
ANTHROPIC_API_KEY=<your-api-key>

# For POST /sub — get your token by running: claude setup-token
CLAUDE_CODE_OAUTH_TOKEN=<your-oauth-token>
```

For production, set secrets with:
```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put CLAUDE_CODE_OAUTH_TOKEN
```

## Usage

```bash
# Using an API key
curl -X POST http://localhost:8787/ \
  -H 'Content-Type: application/json' \
  -d '{"repo": "https://github.com/owner/repo", "task": "fix the typo in README.md"}'

# Using a Claude.ai subscription
curl -X POST http://localhost:8787/sub \
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
