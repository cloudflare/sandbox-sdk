import { createLogger, TraceContext } from '@repo/shared';
import {
  PREVIEW_PROXY_HEADER,
  PREVIEW_PROXY_HEADERS,
  PREVIEW_PROXY_PORT_HEADER,
  PREVIEW_PROXY_SANDBOX_ID_HEADER,
  PREVIEW_PROXY_TOKEN_HEADER
} from './preview/protocol';
import { parsePreviewRoute } from './preview/route';
import { getSandbox, type Sandbox } from './sandbox';

export interface SandboxEnv<T extends Sandbox<any> = Sandbox<any>> {
  Sandbox: DurableObjectNamespace<T>;
}

function createProxyLogger(request: Request) {
  const traceId =
    TraceContext.fromHeaders(request.headers) || TraceContext.generate();
  return createLogger({
    component: 'sandbox-do',
    traceId,
    operation: 'proxy'
  });
}

export async function proxyToSandbox<
  T extends Sandbox<any>,
  E extends SandboxEnv<T>
>(request: Request, env: E): Promise<Response | null> {
  try {
    const url = new URL(request.url);
    const routeInfo = parsePreviewRoute(url);

    if (!routeInfo) {
      return null; // Not a request to an exposed container port
    }

    const { sandboxId, port, token } = routeInfo;
    // Preview URLs always use normalized (lowercase) IDs
    const sandbox = getSandbox(env.Sandbox, sandboxId, { normalizeId: true });

    const headers = new Headers(request.headers);
    for (const header of PREVIEW_PROXY_HEADERS) {
      headers.delete(header);
    }
    headers.set(PREVIEW_PROXY_HEADER, '1');
    headers.set(PREVIEW_PROXY_PORT_HEADER, port.toString());
    headers.set(PREVIEW_PROXY_TOKEN_HEADER, token);
    headers.set(PREVIEW_PROXY_SANDBOX_ID_HEADER, sandboxId);

    const previewRequest = new Request(request, { headers });
    return await sandbox.fetch(previewRequest);
  } catch (error) {
    const logger = createProxyLogger(request);
    logger.error(
      'Proxy routing error',
      error instanceof Error ? error : new Error(String(error))
    );
    return new Response('Proxy routing error', { status: 500 });
  }
}
