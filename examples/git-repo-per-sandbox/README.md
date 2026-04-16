# Git Repo Per Sandbox

Create one Artifacts repo per sandbox and let the sandbox push to that repo with a normal Git remote.

This example uses the same ID for the sandbox and the Artifacts repo. It creates both resources on demand, mints a short-lived write token, passes an authenticated Git remote into the sandbox, and then uses `git clone`, `touch`, `git add`, `git commit`, and `git push` inside the sandbox.

## What It Shows

- Create or reuse a sandbox by ID
- Create or reuse an Artifacts repo with the same ID
- Fetch an existing repo for a sandbox
- Clone the repo inside the sandbox and push a commit back to Artifacts

## Endpoints

- `POST /sandboxes/:id/setup`
  - Creates or reuses the sandbox and repo
  - Stores `ARTIFACTS_GIT_REMOTE` inside the sandbox
  - Returns the write token expiration time used for the sandbox remote
- `GET /sandboxes/:id/repo`
  - Returns the existing repo metadata for that sandbox ID
- `POST /sandboxes/:id/commit`
  - Clones the repo inside the sandbox if needed
  - Creates a file with `touch <filename>`
  - Commits and pushes it to the repo

## Setup

1. From the repository root, install dependencies:

```bash
npm install
```

2. Generate Wrangler types for this example:

```bash
cd examples/git-repo-per-sandbox
npm run types
```

3. Run locally:

```bash
npm run dev
```

The first run builds the Docker container. Later runs are much faster.

The Worker binds Artifacts through the `artifacts` block in `wrangler.jsonc`, and `src/index.ts` keeps the Artifacts methods it uses explicit.

## Try It

Create or reuse the sandbox and repo:

```bash
curl -X POST http://localhost:8787/sandboxes/demo/setup
```

Fetch the current repo metadata:

```bash
curl http://localhost:8787/sandboxes/demo/repo
```

Clone the repo in the sandbox, create a file, commit it, and push it:

```bash
curl -X POST http://localhost:8787/sandboxes/demo/commit \
  -H "Content-Type: application/json" \
  -d '{"filename":"hello.txt"}'
```

If you omit `filename`, the example creates a unique file name for you.

## Notes

- This example expects access to the `artifacts` service in your Cloudflare account.
- The sandbox receives an authenticated Git remote through `ARTIFACTS_GIT_REMOTE`.
- The Worker mints a short-lived write token and does not return that secret in API responses.
- The example returns the public repo remote in JSON responses, not the authenticated one.
