# cloudflare-sandbox-bridge

Supported self-deployed bridge releases come from the `main` branch template,
paired with the matching stable Sandbox package and container image.

This directory on `next` is not a supported bridge release target. Prefer:

- Template: `main` → `bridge/worker`
- Docs: https://developers.cloudflare.com/sandbox/bridge/

Monorepo bridge implementation used by the package lives under
`packages/sandbox/src/bridge/`.
