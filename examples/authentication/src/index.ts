import { getSandbox, type Sandbox } from '@cloudflare/sandbox';

import { createProxyHandler, createProxyToken } from './proxy';
import {
  anthropic,
  configureAnthropic,
  configureGithub,
  github,
  r2
} from './services';

export { Sandbox } from '@cloudflare/sandbox';

declare global {
  interface Env {
    PROXY_JWT_SECRET: string;
    ANTHROPIC_API_KEY?: string;
    GITHUB_TOKEN?: string;
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
    R2_ENDPOINT?: string;
  }
}

const proxyHandler = createProxyHandler<Env>({
  mountPath: '/proxy',
  jwtSecret: (env) => env.PROXY_JWT_SECRET,
  services: { anthropic, github, r2 }
});

/** Get proxy base URL that works from inside the container */
function getProxyBase(url: URL): string {
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return `http://host.docker.internal:${url.port}`;
  }
  return url.origin;
}

/** Configure sandbox with all services */
async function configureSandbox(
  sandbox: Sandbox,
  proxyBase: string,
  token: string
): Promise<void> {
  // Clear any previous config
  await sandbox.exec('rm -f /workspace/.env');

  await configureAnthropic(sandbox, proxyBase, token);
  await configureGithub(sandbox, proxyBase, token);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/proxy/')) {
      return proxyHandler(request, env);
    }

    if (url.pathname === '/test/anthropic') {
      const sandbox = getSandbox(env.Sandbox, 'test-sandbox');
      const proxyBase = getProxyBase(url);
      const token = await createProxyToken({
        secret: env.PROXY_JWT_SECRET,
        sandboxId: 'test-sandbox',
        expiresIn: '15m'
      });

      await configureSandbox(sandbox, proxyBase, token);

      const result = await sandbox.exec(`
        source /workspace/.env
        curl -s "$ANTHROPIC_BASE_URL/v1/messages" \
          -H "Content-Type: application/json" \
          -H "x-api-key: $ANTHROPIC_API_KEY" \
          -H "anthropic-version: 2023-06-01" \
          -H "Accept-Encoding: identity" \
          -d '{"model":"claude-haiku-4-5-20251001","max_tokens":20,"messages":[{"role":"user","content":"Say hi"}]}'
      `);

      return Response.json({
        success: result.exitCode === 0,
        output: result.stdout || result.stderr
      });
    }

    if (url.pathname === '/test/github') {
      const sandbox = getSandbox(env.Sandbox, 'test-sandbox');
      const proxyBase = getProxyBase(url);
      const token = await createProxyToken({
        secret: env.PROXY_JWT_SECRET,
        sandboxId: 'test-sandbox',
        expiresIn: '15m'
      });

      await configureSandbox(sandbox, proxyBase, token);

      const result = await sandbox.exec(`
        cd /tmp && rm -rf sandbox-scm-test
        git clone https://github.com/ghostwriternr/sandbox-scm-test 2>&1
        ls sandbox-scm-test
      `);

      return Response.json({
        success: result.exitCode === 0,
        output: result.stdout || result.stderr
      });
    }

    if (url.pathname === '/test/r2') {
      const sandbox = getSandbox(env.Sandbox, 'test-sandbox');
      const proxyBase = getProxyBase(url);
      const token = await createProxyToken({
        secret: env.PROXY_JWT_SECRET,
        sandboxId: 'test-sandbox',
        expiresIn: '15m'
      });

      await configureSandbox(sandbox, proxyBase, token);

      const testContent = `Hello from sandbox at ${new Date().toISOString()}`;
      const bucket = 'sandbox-auth-test';

      await sandbox.exec(`
        curl -s -X PUT "${proxyBase}/proxy/r2/${bucket}/test-file.txt" \
          -H "Authorization: Bearer ${token}" \
          -H "Content-Type: text/plain" \
          -d '${testContent}'
      `);

      const readResult = await sandbox.exec(`
        curl -s "${proxyBase}/proxy/r2/${bucket}/test-file.txt" \
          -H "Authorization: Bearer ${token}" \
          -H "Accept-Encoding: identity"
      `);

      return Response.json({
        success: readResult.exitCode === 0 && readResult.stdout === testContent,
        written: testContent,
        read: readResult.stdout || readResult.stderr
      });
    }

    if (url.pathname === '/') {
      return new Response(
        `Authentication Proxy Example

Test endpoints:
  GET /test/anthropic - Test Claude API via proxy
  GET /test/github    - Test git clone via proxy
  GET /test/r2        - Test R2 bucket access via proxy

Proxy endpoints:
  /proxy/anthropic/*  - Anthropic API proxy
  /proxy/github/*     - GitHub git proxy
  /proxy/r2/*         - R2 S3-compatible proxy
`,
        { headers: { 'Content-Type': 'text/plain' } }
      );
    }

    return new Response('Not found', { status: 404 });
  }
};
