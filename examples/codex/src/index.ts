import { Sandbox as BaseSandbox, getSandbox } from '@cloudflare/sandbox';
import { type GitCheckoutOptions, withGit } from '@cloudflare/sandbox/git';

export { ContainerProxy } from '@cloudflare/sandbox';

export class Sandbox extends BaseSandbox<Env> {
  interceptHttps = true;
  // Block general internet access; only allow what we explicitly need.
  // `github.com` for `git clone`, `api.openai.com` for API-key auth, and
  // `chatgpt.com` for the ChatGPT subscription backend used by `codex exec`.
  enableInternet = false;
  allowedHosts = ['github.com', 'api.openai.com', 'chatgpt.com'];

  git = withGit(this);

  gitCheckout(repoUrl: string, options?: GitCheckoutOptions) {
    return this.git.checkout(repoUrl, options);
  }
}

// Build the auth headers codex expects for each upstream, swapping the
// container-side placeholder for the real secret on the way out.
function authHeadersFor(host: string, env: Env): Record<string, string> {
  if (host === 'api.openai.com' && env.OPENAI_API_KEY) {
    return { authorization: `Bearer ${env.OPENAI_API_KEY}` };
  }

  if (host === 'chatgpt.com' && env.CODEX_AUTH_JSON) {
    // CODEX_AUTH_JSON is the file produced by `codex login` on a trusted
    // machine. We parse it worker-side and inject the bearer + account id
    // headers the codex backend expects.
    const auth = JSON.parse(env.CODEX_AUTH_JSON) as {
      tokens?: { access_token?: string };
      account_id?: string | null;
    };
    const headers: Record<string, string> = {};
    if (auth.tokens?.access_token) {
      headers.authorization = `Bearer ${auth.tokens.access_token}`;
    }
    if (auth.account_id) {
      headers['chatgpt-account-id'] = auth.account_id;
    }
    return headers;
  }

  return {};
}

const proxyOutbound = async (request: Request, env: Env) => {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(
    authHeadersFor(url.hostname, env)
  )) {
    headers.set(name, value);
  }
  return fetch(`https://${url.hostname}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: request.body
  });
};

Sandbox.outboundByHost = {
  'api.openai.com': proxyOutbound,
  'chatgpt.com': proxyOutbound
};

// Wrap a string as a single-quoted POSIX shell argument so user input
// can't break out of the command line.
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

const EXTRA_SYSTEM =
  'You are an automatic feature-implementer/bug-fixer. ' +
  'Apply all necessary changes to achieve the user request. You must ensure you DO NOT commit the changes, ' +
  'so the pipeline can read the local `git diff` and apply the change upstream.';

// A placeholder auth.json that lets codex pick ChatGPT-subscription mode.
// The id_token is the minimal valid JWT shape (header.{}.signature); the
// access token never leaves the worker -- the egress handler injects the
// real one on the way out.
const PLACEHOLDER_AUTH_JSON = JSON.stringify({
  tokens: {
    id_token: 'x.e30.x',
    access_token: 'proxy-injected',
    refresh_token: 'proxy-injected'
  },
  account_id: 'proxy-injected'
});

// Seed the container with whichever placeholder credential matches the secret
// configured on the worker. The real secret stays worker-side.
async function seedPlaceholderAuth(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env
): Promise<void> {
  if (env.OPENAI_API_KEY) {
    await sandbox.setEnvVars({ OPENAI_API_KEY: 'proxy-injected' });
    return;
  }
  if (env.CODEX_AUTH_JSON) {
    await sandbox.mkdir('/root/.codex', { recursive: true });
    await sandbox.writeFile('/root/.codex/auth.json', PLACEHOLDER_AUTH_JSON);
    return;
  }
  throw new Error(
    'No OpenAI credential configured (set OPENAI_API_KEY or CODEX_AUTH_JSON)'
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
    const name =
      repo
        .split('/')
        .pop()
        ?.replace(/\.git$/, '') ?? 'tmp';

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
    const repoPath = `/workspace/${name}`;

    // wire up the placeholder credential the container should see
    await seedPlaceholderAuth(sandbox, env);

    // codex has no `--append-system-prompt` flag, so we prepend our system
    // instructions to the user task.
    const prompt = `${EXTRA_SYSTEM}\n\nTask: ${task}`;
    const cmd = `codex exec --dangerously-bypass-approvals-and-sandbox ${shellQuote(prompt)}`;

    const logsResult = await (
      await sandbox.exec(['/bin/bash', '-lc', cmd], {
        cwd: repoPath
      })
    ).output({ encoding: 'utf8' });
    const diffResult = await (
      await sandbox.exec(['/bin/bash', '-lc', 'git diff'], {
        cwd: repoPath
      })
    ).output({ encoding: 'utf8' });
    const logs =
      logsResult.exitCode === 0 ? logsResult.stdout : logsResult.stderr;
    const diff =
      diffResult.exitCode === 0 ? diffResult.stdout : diffResult.stderr;

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
