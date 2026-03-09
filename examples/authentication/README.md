# Authentication Example

A zero-trust proxy that lets sandboxes access external APIs without exposing credentials.

```
Sandbox (JWT token) → Worker Proxy (validates, injects credentials) → External API
```

## Quick Start

```bash
cp .dev.vars.example .dev.vars  # Add your secrets
npm install
npm run dev
```

## Structure

```
src/
├── index.ts              # Worker entry point
├── proxy/                # Proxy framework (copy as-is)
└── services/
    ├── anthropic/        # Claude Code / Anthropic SDK
    ├── github/           # Git operations with OAuth lookup
    └── r2/               # R2 bucket access via S3 proxy
```

Each service has its own README with setup and usage instructions.

## Services

| Service                              | Description                   | Credentials                                               |
| ------------------------------------ | ----------------------------- | --------------------------------------------------------- |
| [anthropic](src/services/anthropic/) | Claude Code and Anthropic SDK | `ANTHROPIC_API_KEY`                                       |
| [github](src/services/github/)       | Git clone/push                | `GITHUB_TOKEN`                                            |
| [r2](src/services/r2/)               | R2 bucket access              | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` |

## Adding a Service

Create `src/services/myapi/index.ts`:

```typescript
import type { ServiceConfig } from '../../proxy';

export const myapi: ServiceConfig<Env> = {
  target: 'https://api.example.com',
  validate: (req) =>
    req.headers.get('Authorization')?.replace('Bearer ', '') ?? null,
  transform: async (req, ctx) => {
    req.headers.set('Authorization', `Bearer ${ctx.env.MY_API_KEY}`);
    return req;
  }
};
```

Add to `src/services/index.ts` and `src/index.ts`.

## Production

```bash
wrangler secret put PROXY_JWT_SECRET
# Add secrets for each service you use
npm run deploy
```
