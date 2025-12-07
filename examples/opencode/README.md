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

Happy hacking!
