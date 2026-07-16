---
name: examples
description: Use when working in the examples/ directory, running an example with wrangler dev, adding a new example, or answering questions about EXPOSE directives and the local Docker dev loop. (project)
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
| `devin-outpost`              | Running Devin Outposts on Containers         |
| `code-interpreter`           | `CodeInterpreter` API + Workers AI           |
| `codex` / `codex-app-server` | OpenAI Codex integration patterns            |
| `collaborative-terminal`     | Multi-user terminal sharing                  |
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
2. Update `package.json` `name` and any wrangler config (`wrangler.jsonc`) — class names, DO bindings, container image tag.
3. Add a `README.md` with an `# H1` title (the README scanner uses it) and a short description of what the example demonstrates.
4. Make sure the example builds and `npm run dev` works from a clean checkout.
5. If the example demonstrates a new SDK capability, link to it from `packages/sandbox/README.md`.

## Local Development Tips

- Examples link to `@cloudflare/sandbox` via the workspace, so SDK changes are picked up after a build (`npm run build` from repo root).
- Container changes require `npm run docker:rebuild` to take effect.
- If you hit stale-image issues, delete the container image (`docker images | grep sandbox`) and re-run `npm run dev`.
