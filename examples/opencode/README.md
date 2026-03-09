# OpenCode + Sandbox SDK

Run OpenCode inside Cloudflare Sandboxes! Just open the worker URL in your browser to get the full OpenCode web experience.

## Quick Start

1. Copy `.dev.vars.example` to `.dev.vars` and add your Anthropic API key:

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your ANTHROPIC_API_KEY
```

2. Install dependencies and run:

```bash
npm install
npm run dev
```

3. Open http://localhost:8787 in your browser - you'll see the OpenCode web UI!

## How It Works

The worker acts as a transparent proxy to OpenCode running in the container:

```
Browser → Worker → Sandbox DO → Container :4096 → OpenCode Server
                                                       ↓
                                    Proxies UI from desktop.dev.opencode.ai
```

OpenCode handles everything:

- API routes (`/session/*`, `/event`, etc.)
- Web UI (proxied from `desktop.dev.opencode.ai`)
- WebSocket for terminal

## Key Benefits

- **Web UI** - Full browser-based OpenCode experience
- **Isolated execution** - Code runs in secure sandbox containers
- **Persistent sessions** - Sessions survive across requests

## Advanced: Cloudflare AI Gateway

You can route AI requests through [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) for monitoring, caching, and rate limiting. With **unified billing**, the gateway handles provider API keys — you only need your Cloudflare credentials.

Add these variables to `.dev.vars`:

```bash
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_GATEWAY_ID=your-gateway-id
CLOUDFLARE_API_TOKEN=your-api-token
```

Configure the provider in `src/index.ts`. Models must be declared explicitly using the `provider/model` format:

```typescript
const getConfig = (env: Env): Config => ({
  provider: {
    'cloudflare-ai-gateway': {
      options: {
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        gatewayId: env.CLOUDFLARE_GATEWAY_ID,
        apiToken: env.CLOUDFLARE_API_TOKEN
      },
      models: {
        'anthropic/claude-sonnet-4-5-20250929': {},
        'openai/gpt-4o': {}
      }
    }
  }
});
```

When using the SDK programmatically, specify the model with `providerID: 'cloudflare-ai-gateway'`:

```typescript
await client.session.prompt({
  sessionID,
  model: {
    providerID: 'cloudflare-ai-gateway',
    modelID: 'anthropic/claude-sonnet-4-5-20250929'
  },
  parts: [{ type: 'text', text: 'Hello!' }]
});
```

Happy hacking!
