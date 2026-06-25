---
'@cloudflare/sandbox': minor
---

Git is now an opt-in extension at `@cloudflare/sandbox/git` instead of a built-in `sandbox.gitCheckout()` method. Git operations are plain shell commands, so the extension drives them through the existing command channel — there is no sidecar, and the container no longer ships a git service.

Attach it to your `Sandbox` subclass and (optionally) expose a delegate:

```ts
import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
import { type GitCheckoutOptions, withGit } from '@cloudflare/sandbox/git';

export class Sandbox extends BaseSandbox<Env> {
  git = withGit(this);

  gitCheckout(repoUrl: string, options?: GitCheckoutOptions) {
    return this.git.checkout(repoUrl, options);
  }
}

await sandbox.git.checkout('https://github.com/owner/repo.git', {
  branch: 'main',
  depth: 1
});
```

The extension exposes `checkout` (clone), `checkoutBranch`, `getCurrentBranch`, and `listBranches`. `checkout` keeps the same options (`branch`, `targetDir`, `depth`, `cloneTimeoutMs`, `sessionId`) and returns the same `GitCheckoutResult`. Git operations default to running sessionless, but still inherit the sandbox-level environment variables (e.g. tokens, proxy settings) so auth and egress configured on the sandbox keep working. Pass `sessionId` to run inside an existing session instead.
