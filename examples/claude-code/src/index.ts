import { Sandbox as BaseSandbox, getSandbox } from '@cloudflare/sandbox';
import { type GitCheckoutOptions, withGit } from '@cloudflare/sandbox/git';

export { ContainerProxy } from '@cloudflare/sandbox';

export class Sandbox extends BaseSandbox<Env> {
  interceptHttps = true;
  // Block general internet access; only allow what we explicitly need.
  // `github.com` for `git clone`, `api.anthropic.com` for the intercepted
  // claude traffic (allowedHosts gates outboundByHost when internet is off).
  enableInternet = false;
  allowedHosts = ['github.com', 'api.anthropic.com'];

  git = withGit(this);

  gitCheckout(repoUrl: string, options?: GitCheckoutOptions) {
    return this.git.checkout(repoUrl, options);
  }
}

Sandbox.outboundByHost = {
  'api.anthropic.com': async (request: Request, env: Env) => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);

    // claude picks the auth header based on which env var it sees in the
    // container; we mirror that choice here when swapping in the real secret.
    if (headers.has('x-api-key') && env.ANTHROPIC_API_KEY) {
      headers.set('x-api-key', env.ANTHROPIC_API_KEY);
    } else if (env.CLAUDE_CODE_OAUTH_TOKEN) {
      headers.set('Authorization', `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}`);
      headers.delete('x-api-key');
    }

    return fetch(`https://api.anthropic.com${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body
    });
  }
};

interface CmdOutput {
  success: boolean;
  stdout: string | ArrayBuffer;
  stderr: string | ArrayBuffer;
}
// helper to read the outputs from `.exec` results
const getOutput = (res: CmdOutput): string =>
  String(res.success ? res.stdout : res.stderr);

// Wrap a string as a single-quoted POSIX shell argument so user input
// can't break out of the command line.
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

const EXTRA_SYSTEM =
  'You are an automatic feature-implementer/bug-fixer.' +
  'You apply all necessary changes to achieve the user request. You must ensure you DO NOT commit the changes, ' +
  'so the pipeline can read the local `git diff` and apply the change upstream.';

// Pick the placeholder env var based on which secret is configured on the
// worker. The value is a sentinel -- the real secret is injected by the
// outbound handler above and never enters the container.
function placeholderAuthVars(env: Env): Record<string, string> {
  if (env.ANTHROPIC_API_KEY) return { ANTHROPIC_API_KEY: 'proxy-injected' };
  if (env.CLAUDE_CODE_OAUTH_TOKEN)
    return { CLAUDE_CODE_OAUTH_TOKEN: 'proxy-injected' };
  throw new Error(
    'No Anthropic credential configured (set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)'
  );
}

async function runTask(request: Request, env: Env): Promise<Response> {
  try {
    const { repo, task } = await request.json<{
      repo?: string;
      task?: string;
    }>();
    if (!repo || !task) return new Response('invalid body', { status: 400 });

    // get the repo name
    const name = repo.split('/').pop() ?? 'tmp';

    // derive a stable sandbox id from the repo name (sha-256, first 8 hex chars)
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(repo)
    );
    const sandboxId = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 8);

    // open sandbox
    const sandbox = getSandbox(env.Sandbox, sandboxId);

    // git clone repo
    await sandbox.gitCheckout(repo, { targetDir: name });
    const cwd = `/workspace/${name}`;

    // Kick off CC with our query.
    const cmd = `claude --print --permission-mode bypassPermissions --append-system-prompt ${shellQuote(EXTRA_SYSTEM)} ${shellQuote(task)}`;

    const logs = getOutput(
      await sandbox
        .exec(cmd, {
          cwd,
          env: { IS_SANDBOX: '1', ...placeholderAuthVars(env) }
        })
        .output()
    );
    const diff = getOutput(await sandbox.exec('git diff', { cwd }).output());

    return Response.json({ logs, diff });
  } catch {
    return new Response('invalid body', { status: 400 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST')
      return new Response('method not allowed', { status: 405 });

    const { pathname } = new URL(request.url);
    if (pathname !== '/') return new Response('not found');

    return runTask(request, env);
  }
};
