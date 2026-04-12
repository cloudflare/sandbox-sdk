# Claude Code Sandbox SDK

Run Claude Code on Cloudflare Sandboxes! This example shows a basic setup that does the following:

- The worker accepts POST requests that include a repository URL and a task description
- The worker spawns a sandbox, clones the repository and starts Claude Code in headless mode with the provided task
- Claude Code will edit all necessary files and return when done
- The Worker will return a response with the output logs from Claude and the diff left on the repo.

## Authentication

The worker supports two ways to authenticate Claude Code:

**Option 1 — Anthropic API key** (pay-per-token):
```
ANTHROPIC_API_KEY=<your-key>
```

**Option 2 — Claude.ai subscription** (uses your existing subscription):
```
CLAUDE_CODE_OAUTH_TOKEN=<your-token>
```

To get your OAuth token after logging in with Claude Code locally:
```bash
cat ~/.claude/.credentials.json
```

Set exactly one of these in `.dev.vars` for local development, or as a Worker secret for production:
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
