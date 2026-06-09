# Git Repo Per Sandbox

Create one Artifacts repo per sandbox and let the sandbox push to that repo with a normal Git remote.

This example uses the same ID for the sandbox and the Artifacts repo. A single `POST` endpoint creates both resources on demand, mints a short-lived write token, passes an authenticated Git remote into the sandbox, writes the request body to a file, and commits and pushes it.

## What It Shows

- Create or reuse a sandbox and Artifacts repo in one call
- Clone the repo inside the sandbox and push a commit back to Artifacts
- Fetch existing repo metadata for a sandbox

## Endpoints

- `POST /sandboxes/:id/commit/:filename`
  - Creates or reuses the sandbox and repo
  - Clones the repo inside the sandbox if needed
  - Writes the request body to `<filename>` (defaults to a timestamp if the body is empty)
  - Commits and pushes it to the repo
- `GET /sandboxes/:id/repo`
  - Returns the existing repo metadata for that sandbox ID

## Setup

1. From the repository root, install dependencies:

```bash
npm install
```

2. Generate Wrangler types for this example:

```bash
cd examples/git-repo-per-sandbox
npm run cf-typegen
```

3. Run locally:

```bash
npm run dev
```

The first run builds the Docker container. Later runs are much faster.

The Worker binds Artifacts through the `artifacts` block in `wrangler.jsonc`, and `src/index.ts` keeps the Artifacts methods it uses explicit.

## Try It

Create a file, commit it, and push it (creates the sandbox and repo on first call):

```bash
curl -X POST http://localhost:8787/sandboxes/demo/commit/hello.txt \
  -d 'Hello from the sandbox!'
```

If you omit the body, the example writes a default timestamp string.

Fetch the current repo metadata:

```bash
curl http://localhost:8787/sandboxes/demo/repo
```

## Notes

- This example expects access to the `artifacts` service in your Cloudflare account.
- The sandbox receives an authenticated Git remote through `ARTIFACTS_GIT_REMOTE`.
- The Worker mints a short-lived write token and does not return that secret in API responses.
- The example returns the public repo remote in JSON responses, not the authenticated one.
- When repo lookup fails, the example only falls back to `create()` for missing repos. Other binding errors still surface.
