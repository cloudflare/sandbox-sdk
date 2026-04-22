import {
  Sandbox as BaseSandbox,
  ContainerProxy,
  getSandbox
} from '@cloudflare/sandbox';

import { anthropicHandler, githubHandler, r2Handler } from './services';

export { ContainerProxy };

export class Sandbox extends BaseSandbox {
  interceptHttps = true;
}

Sandbox.outboundByHost = {
  'api.anthropic.com': anthropicHandler,
  'github.com': githubHandler,
  'r2.worker': r2Handler
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/test/anthropic') {
      const sandbox = getSandbox(env.Sandbox, 'test-sandbox');

      const result = await sandbox.exec(`
        curl -s "https://api.anthropic.com/v1/messages" \
          -H "Content-Type: application/json" \
          -H "x-api-key: placeholder" \
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
      const testContent = `Hello from sandbox at ${new Date().toISOString()}`;
      const bucket = 'sandbox-auth-test';

      await sandbox.exec(`
        curl -s -X PUT "http://r2.worker/${bucket}/test-file.txt" \
          -H "Content-Type: text/plain" \
          -d '${testContent}'
      `);

      const readResult = await sandbox.exec(`
        curl -s "http://r2.worker/${bucket}/test-file.txt" \
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
        `Outbound Interception Authentication Example

Credentials are injected by outbound handlers in the Worker — the sandbox
never sees secrets and needs no configuration.

Test endpoints:
  GET /test/anthropic - Claude API call (x-api-key injected by handler)
  GET /test/github    - git clone (GitHub token injected by handler)
  GET /test/r2        - R2 read/write (signed by handler at http://r2.worker/...)
`,
        { headers: { 'Content-Type': 'text/plain' } }
      );
    }

    return new Response('Not found', { status: 404 });
  }
};
