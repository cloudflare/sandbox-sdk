import type { Sandbox } from '@cloudflare/sandbox';
import { getSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

const DEFAULT_URL = 'https://example.com';
const MAX_PREVIEW_CHARS = 500;

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function normalizeUrl(raw: string | null | undefined): string {
  if (!raw) {
    return DEFAULT_URL;
  }

  const value = raw.trim();
  if (!value) {
    return DEFAULT_URL;
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value)
    ? value
    : `https://${value}`;

  return new URL(withProtocol).toString();
}

function extractTitle(dom: string): string | null {
  const match = dom.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return null;
  }

  return match[1].replace(/\s+/g, ' ').trim();
}

async function runBrowserAutomation(
  env: Env,
  sandboxId: string,
  targetUrl: string
): Promise<Response> {
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  const screenshotPath = '/workspace/browser-automation.png';
  const command = [
    'set -euo pipefail',
    `rm -f ${shellEscape(screenshotPath)}`,
    'google-chrome-stable \\',
    '  --headless=new \\',
    '  --disable-gpu \\',
    '  --no-sandbox \\',
    '  --disable-dev-shm-usage \\',
    '  --hide-scrollbars \\',
    '  --window-size=1280,720 \\',
    '  --virtual-time-budget=5000 \\',
    `  --screenshot=${shellEscape(screenshotPath)} \\`,
    `  --dump-dom ${shellEscape(targetUrl)}`
  ].join('\n');

  const result = await sandbox.exec(command);
  if (!result.success) {
    throw new Error(
      result.stderr || result.stdout || 'Browser automation failed'
    );
  }

  const screenshot = await sandbox.readFile(screenshotPath, {
    encoding: 'base64'
  });

  return Response.json({
    sandboxId,
    requestedUrl: targetUrl,
    title: extractTitle(result.stdout),
    htmlPreview: result.stdout.slice(0, MAX_PREVIEW_CHARS),
    htmlLength: result.stdout.length,
    screenshot: `data:image/png;base64,${screenshot.content}`
  });
}

async function getTargetUrl(request: Request, url: URL): Promise<string> {
  if (request.method === 'POST') {
    const body = (await request.json()) as { url?: string };
    return normalizeUrl(body.url ?? url.searchParams.get('url'));
  }

  return normalizeUrl(url.searchParams.get('url'));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/run') {
      return new Response(
        'Use GET /run?url=https://example.com or POST /run with a JSON body containing url.',
        {
          headers: {
            'Content-Type': 'text/plain'
          }
        }
      );
    }

    try {
      const targetUrl = await getTargetUrl(request, url);
      const sandboxId =
        url.searchParams.get('sandboxId') ?? 'browser-automation';
      return await runBrowserAutomation(env, sandboxId, targetUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return Response.json({ error: message }, { status: 500 });
    }
  }
} satisfies ExportedHandler<Env>;
