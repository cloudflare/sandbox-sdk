import { Sandbox as BaseSandbox, getSandbox } from '@cloudflare/sandbox';

export class Sandbox extends BaseSandbox<Env> {
  interceptHttps = true;
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
  stdout: string;
  stderr: string;
}
// helper to read the outputs from `.exec` results
const getOutput = (res: CmdOutput) => (res.success ? res.stdout : res.stderr);

const EXTRA_SYSTEM =
  'You are an automatic feature-implementer/bug-fixer.' +
  'You apply all necessary changes to achieve the user request. You must ensure you DO NOT commit the changes, ' +
  'so the pipeline can read the local `git diff` and apply the change upstream.';

// Pick the placeholder env var based on which secret is configured on the
// worker. The value is a sentinel -- the real secret is injected by the
// outbound handler above and never enters the container.
function placeholderAuthVars(env: Env): Record<string, string> {
  if (env.ANTHROPIC_API_KEY) return { ANTHROPIC_API_KEY: 'proxy-injected' };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { CLAUDE_CODE_OAUTH_TOKEN: 'proxy-injected' };
  throw new Error('No Anthropic credential configured (set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)');
}

async function runTask(request: Request, env: Env): Promise<Response> {
  try {
    const { repo, task } = await request.json<{
      repo?: string;
      task?: string;
    }>();
    if (!repo || !task)
      return new Response('invalid body', { status: 400 });

    // get the repo name
    const name = repo.split('/').pop() ?? 'tmp';

    // open sandbox
    const sandbox = getSandbox(env.Sandbox, crypto.randomUUID().slice(0, 8));

    // git clone repo
    await sandbox.gitCheckout(repo, { targetDir: name });

    // Wrap a string as a single-quoted POSIX shell argument so user input
    // can't break out of the command line.
    const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

    // kick off CC with our query
    const cmd = `cd ${shellQuote(name)} && claude --append-system-prompt ${shellQuote(EXTRA_SYSTEM)} -p ${shellQuote(task)} --permission-mode acceptEdits`;

    const logs = getOutput(await sandbox.exec(cmd, {env: placeholderAuthVars(env)}));
    const diff = getOutput(await sandbox.exec('git diff'));

    return Response.json({ logs, diff });
  } catch {
    return new Response('invalid body', { status: 400 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

    const { pathname } = new URL(request.url);
    if (pathname !== '/') return new Response('not found');

    return runTask(request, env);
  }
};
