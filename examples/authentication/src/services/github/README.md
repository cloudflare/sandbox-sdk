# GitHub Service

Proxies git operations (clone/push) to GitHub, injecting a GitHub token.

## How It Works

1. `configureGithub()` rewrites `github.com` URLs to go through the proxy
2. Sandbox runs `git clone`, `git push`, etc.
3. Proxy validates JWT, injects real `GITHUB_TOKEN`
4. Proxy forwards to GitHub

## Configuration

**Worker secrets:**

```bash
wrangler secret put GITHUB_TOKEN
```

Use a fine-grained PAT with **Contents** read/write permission.

**Sandbox setup:**

```typescript
await configureGithub(sandbox, proxyBase, token);
```

## Usage in Sandbox

```bash
git clone https://github.com/org/private-repo
git push origin main
```

## Security

- Only git protocol paths are allowed (`info/refs`, `git-upload-pack`, `git-receive-pack`)
- GitHub token never enters the sandbox
- JWT provides time-limited, revocable access
