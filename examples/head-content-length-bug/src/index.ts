/**
 * Minimal reproduction: Outbound interception strips Content-Length from HEAD responses
 *
 * Bug: When a Durable Object's outbound handler returns a Response with an explicit
 * Content-Length header (and null body, as is correct for HEAD), the container receives
 * Content-Length: 0 instead. GET responses with a body are not affected.
 *
 * Deploy and hit /test to see the bug.
 */
import {
  Sandbox as BaseSandbox,
  ContainerProxy,
  getSandbox
} from '@cloudflare/sandbox';

export { ContainerProxy };

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

// ---------------------------------------------------------------------------
// Outbound handler — intercepts requests to "fake-s3.internal"
// ---------------------------------------------------------------------------
function outboundHandler(request: Request): Response {
  const url = new URL(request.url);
  const BODY = 'x'.repeat(42); // 42 bytes

  if (request.method === 'HEAD') {
    // Standard HTTP: HEAD returns the same headers as GET, but no body.
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Length': '42',
        'Content-Type': 'text/plain',
        'X-Debug-Path': url.pathname
      }
    });
  }

  if (request.method === 'GET') {
    return new Response(BODY, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'X-Debug-Path': url.pathname
      }
    });
  }

  return new Response('Method Not Allowed', { status: 405 });
}

// ---------------------------------------------------------------------------
// Sandbox subclass — registers the outbound handler
// ---------------------------------------------------------------------------
export class Sandbox extends BaseSandbox {
  // no extra config needed
  interceptHttps = true;
}

Sandbox.outboundByHost = {
  'fake-s3.internal': outboundHandler
};

// ---------------------------------------------------------------------------
// Worker fetch — hit /test to reproduce the bug
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/test') {
      return new Response(
        'GET /test — runs curl HEAD and GET from inside the container\n'
      );
    }

    const sandbox = getSandbox(env.Sandbox, 'repro');

    // Run HEAD and GET from inside the container via curl
    const headResult = await sandbox.exec(
      'curl -sI http://fake-s3.internal/some-file 2>&1'
    );
    const getResult = await sandbox.exec(
      'curl -s -D /dev/stderr http://fake-s3.internal/some-file 2>&1 1>/dev/null'
    );

    // Parse Content-Length from each response
    const parseCL = (headers: string) => {
      const match = headers.match(/content-length:\s*(\d+)/i);
      return match ? parseInt(match[1], 10) : null;
    };

    const headCL = parseCL(headResult.stdout);
    const getCL = parseCL(getResult.stdout);

    return Response.json({
      bug: headCL !== 42,
      summary:
        headCL === 42
          ? 'Content-Length is correct for HEAD — bug may be fixed!'
          : `HEAD Content-Length is ${headCL} (expected 42). GET Content-Length is ${getCL}.`,
      head: {
        contentLength: headCL,
        expected: 42,
        correct: headCL === 42,
        rawHeaders: headResult.stdout
      },
      get: {
        contentLength: getCL,
        expected: 42,
        correct: getCL === 42,
        rawHeaders: getResult.stdout
      }
    });
  }
};
