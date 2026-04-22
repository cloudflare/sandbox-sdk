# Authentication Example

Demonstrates secure credential injection using outbound traffic interception.
Secrets live in the Worker environment and are injected transparently — the
sandbox never sees them and requires no configuration.

```
Sandbox (plain request) → outboundByHost handler (injects credentials) → External API
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
├── index.ts              # Worker entry point + Sandbox class with outbound handlers
└── services/
    ├── anthropic/        # Handler for api.anthropic.com
    ├── github/           # Handler for github.com
    └── r2/               # Handler for virtual r2.worker hostname
```

## Services

| Service                              | Description                   | Credentials                                               |
| ------------------------------------ | ----------------------------- | --------------------------------------------------------- |
| [anthropic](src/services/anthropic/) | Claude Code and Anthropic SDK | `ANTHROPIC_API_KEY`                                       |
| [github](src/services/github/)       | Git clone/push                | `GITHUB_TOKEN`                                            |
| [r2](src/services/r2/)               | R2 bucket access              | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` |

## How It Works

Each service defines an outbound handler function. The `Sandbox` class registers
them on `outboundByHost`:

```typescript
Sandbox.outboundByHost = {
  'api.anthropic.com': anthropicHandler,
  'github.com': githubHandler,
  'r2.worker': r2Handler
};
```

When the sandbox makes an HTTP/HTTPS request to one of those hosts, the
corresponding handler runs in the Worker runtime (outside the sandbox), injects
the real credentials from `env`, and forwards the request.

For R2, the sandbox uses the virtual hostname `http://r2.worker/<bucket>/<key>`.
The handler re-signs the request with real AWS credentials before forwarding to
the actual R2 endpoint.

## Adding a Service

Add an outbound handler in `src/services/myapi/index.ts`:

```typescript
export function myapiHandler(request: Request, env: Env): Promise<Response> {
  const req = new Request(request);
  req.headers.set('Authorization', `Bearer ${env.MY_API_KEY}`);
  return fetch(req);
}
```

Register it in `src/index.ts`:

```typescript
Sandbox.outboundByHost = {
  'api.example.com': myapiHandler
};
```

## Production

```bash
wrangler secret put ANTHROPIC_API_KEY
# Add secrets for each service you use
npm run deploy
```
