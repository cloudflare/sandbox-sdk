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

You can optionally route all AI provider requests through [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) for monitoring, caching, and rate limiting. Add these variables to `.dev.vars`:

```bash
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_GATEWAY_ID=your-gateway-id
CLOUDFLARE_API_TOKEN=your-api-token  # Optional, for authenticated gateways
```

Then uncomment the `cloudflareAIGateway` section in `src/index.ts`:

```typescript
const getConfig = (env: Env): Config => ({
  provider: {
    anthropic: {
      options: { apiKey: env.ANTHROPIC_API_KEY }
    },
    cloudflareAIGateway: {
      options: {
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        gatewayId: env.CLOUDFLARE_GATEWAY_ID,
        apiToken: env.CLOUDFLARE_API_TOKEN
      }
    }
  }
});
```

## Advanced: Custom Environment Variables

You can pass additional environment variables to the OpenCode process using the `env` option. This is useful for:

- **OTEL telemetry** - Configure OpenTelemetry exporters
- **Distributed tracing** - Propagate W3C trace context (`TRACEPARENT`)
- **Custom configuration** - Any other env vars your setup requires

```typescript
const server = await createOpencodeServer(sandbox, {
  config: getConfig(env),
  env: {
    TRACEPARENT: request.headers.get('traceparent') ?? undefined,
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf'
  }
});
```

Custom env vars are merged with config-extracted variables (like API keys) and can override them if needed.

Happy hacking!
