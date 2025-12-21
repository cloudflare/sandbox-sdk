import type { Sandbox } from '@cloudflare/sandbox';

import type { ServiceConfig } from '../../proxy';

/**
 * GitHub git operations (clone/push) proxy.
 *
 * Rewrites git URLs to go through the proxy, which injects a GitHub token.
 * Sandbox code uses normal git commands without any credentials.
 */

// Git smart HTTP protocol paths - .git suffix is optional
const ALLOWED_GIT_PATHS =
  /^\/.+\/.+(\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export const github: ServiceConfig<Env> = {
  target: 'https://github.com',

  validate: (req) =>
    req.headers.get('Authorization')?.replace('Bearer ', '') ?? null,

  transform: async (req, ctx) => {
    if (!ctx.env.GITHUB_TOKEN) {
      return new Response('GITHUB_TOKEN not configured', { status: 500 });
    }

    const url = new URL(req.url);

    // Only allow git-specific paths (info/refs, git-upload-pack, git-receive-pack)
    if (!ALLOWED_GIT_PATHS.test(url.pathname)) {
      return new Response('Invalid git path', { status: 400 });
    }

    // Use Basic auth with x-access-token (GitHub's preferred method for tokens)
    req.headers.set(
      'Authorization',
      `Basic ${btoa(`x-access-token:${ctx.env.GITHUB_TOKEN}`)}`
    );
    req.headers.set('User-Agent', 'Sandbox-Git-Proxy');

    return req;
  }
};

export async function configureGithub(
  sandbox: Sandbox,
  proxyBase: string,
  token: string
) {
  const gitProxy = `${proxyBase}/proxy/github`;

  // Rewrite github.com URLs to go through the proxy
  await sandbox.exec(
    `git config --global url."${gitProxy}/".insteadOf "https://github.com/"`
  );

  // Add JWT token for proxy authentication
  await sandbox.exec(
    `git config --global http.${gitProxy}/.extraheader "Authorization: Bearer ${token}"`
  );
}
