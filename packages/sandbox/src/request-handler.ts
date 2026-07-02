import { createLogger, TraceContext } from '@repo/shared';
import { withPreviewProxyMetadata } from './preview/protocol';
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

    return await sandbox.fetch(
      withPreviewProxyMetadata(request, { port, token, sandboxId })
    );
  } catch (error) {
    const logger = createProxyLogger(request);
    logger.error(
      'Proxy routing error',
      error instanceof Error ? error : new Error(String(error))
    );
    return new Response('Proxy routing error', { status: 500 });
  }
}
