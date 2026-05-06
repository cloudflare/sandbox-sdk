---
name: examples
description: "Use when running examples with wrangler dev, scaffolding new example projects, debugging the local Docker dev loop, or understanding EXPOSE directives. Guides setup, execution, and troubleshooting of working sample apps in the examples/ directory. (project)"
---

# Examples

The `examples/` directory contains working sample apps that exercise the SDK end-to-end. They double as integration smoke tests and as reference material for users.

## Running an Example

From inside an example directory (e.g. `examples/minimal/`):

```bash
npm run dev    # Start wrangler dev (builds Docker on first run)
```

The first run builds the container image, so it's slow. Subsequent runs reuse the image unless the SDK or Dockerfile changes. If you've changed the container runtime or SDK, run `npm run docker:rebuild` from the repo root before `npm run dev`.

## Available Examples

| Example                      | Demonstrates                                 |
| ---------------------------- | -------------------------------------------- |
| `minimal`                    | Smallest possible Sandbox SDK setup          |
| `authentication`             | Auth-protected sandbox access                |
| `claude-code`                | Running Claude Code inside a sandbox         |
| `code-interpreter`           | `CodeInterpreter` API + Workers AI           |
| `codex` / `codex-app-server` | OpenAI Codex integration patterns            |
| `collaborative-terminal`     | Multi-user terminal sharing                  |
| `desktop`                    | Desktop variant of the container image       |
| `openai-agents`              | OpenAI Agents SDK + Sandbox                  |
| `opencode`                   | OpenCode integration                         |
| `time-machine`               | Snapshot/restore patterns                    |
| `typescript-validator`       | Running `tsc` against user code              |
| `vite-sandbox`               | Vite dev server proxied through preview URLs |
| `websocket-tunnel`           | WebSocket transport / port exposure          |
| `alpine`                     | Alpine-based container variant               |

## `EXPOSE` Directives

The Cloudflare containers primitive does **not** require `EXPOSE` directives — all ports are accessible in both local dev and production without them.

Including `EXPOSE` is still recommended in example Dockerfiles because it documents which ports the app uses (standard Docker convention). Don't add it expecting it to gate access; add it as documentation.

## Adding a New Example

1. Copy `examples/minimal/` as a starting point.
2. Update `package.json` `name` and `wrangler.jsonc` — key fields to change:
   ```jsonc
   {
     "name": "your-example",
     "main": "src/index.ts",
     "durable_objects": {
       "bindings": [{ "name": "SANDBOX", "class_name": "YourSandbox" }]
     },
     "containers": {
       "image": "your-example:latest"  // must match Dockerfile output tag
     }
   }
   ```
3. Add a `README.md` with an `# H1` title (the README scanner uses it) and a short description.
4. Run `npm run dev` from the example directory. Verify the dev server starts and responds. If the Docker build fails, check that the image tag in `wrangler.jsonc` matches the Dockerfile output.
5. If the example demonstrates a new SDK capability, link to it from `packages/sandbox/README.md`.

## Local Development Tips

- Examples link to `@cloudflare/sandbox` via the workspace, so SDK changes are picked up after a build (`npm run build` from repo root).
- Container changes require `npm run docker:rebuild` to take effect.
- If you hit stale-image issues, delete the container image (`docker images | grep sandbox`) and re-run `npm run dev`.
