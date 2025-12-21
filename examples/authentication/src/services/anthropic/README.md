# Anthropic Service

Proxies requests to the Anthropic API, injecting the real API key.

## How It Works

1. `configureAnthropic()` sets `ANTHROPIC_BASE_URL` in the sandbox
2. Claude Code / Anthropic SDK sends requests with JWT as `x-api-key`
3. Proxy validates JWT, replaces with real `ANTHROPIC_API_KEY`
4. Proxy forwards to `api.anthropic.com`

## Configuration

**Worker secrets:**

```bash
wrangler secret put ANTHROPIC_API_KEY
```

**Sandbox setup:**

```typescript
await configureAnthropic(sandbox, proxyBase, token);
```

## Usage in Sandbox

Claude Code and the Anthropic SDK read `ANTHROPIC_BASE_URL` automatically:

```bash
claude "Help me refactor this code"
```

```python
from anthropic import Anthropic
client = Anthropic()  # Uses ANTHROPIC_BASE_URL
```
