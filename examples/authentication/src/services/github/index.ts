/**
 * Outbound handler for github.com.
 *
 * Intercepts git HTTPS requests from the sandbox and injects the real GitHub
 * token. The sandbox runs plain `git clone https://github.com/...` with no
 * credential configuration — the token is added transparently here.
 */
export function githubHandler(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_TOKEN) {
    return Promise.resolve(
      new Response('GITHUB_TOKEN not configured', { status: 500 })
    );
  }
  const req = new Request(request);
  req.headers.set(
    'Authorization',
    `Basic ${btoa(`x-access-token:${env.GITHUB_TOKEN}`)}`
  );
  req.headers.set('User-Agent', 'git/sandbox');
  return fetch(req);
}
