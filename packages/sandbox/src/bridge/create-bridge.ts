import { getSandbox } from '../sandbox';
import { AuthError, createAuthErrorResponse, validateApiKey } from './auth';
import { dispatchHandler } from './handlers';
import { addCorsHeaders, handleCors, parseRoute } from './router';
import type { BridgeEnv, BridgeOptions } from './types';

export function createBridge(
  _options?: BridgeOptions
): ExportedHandler<BridgeEnv> {
  return {
    async fetch(request: Request, env: BridgeEnv, _ctx: ExecutionContext) {
      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return handleCors();
      }

      // Validate authentication
      try {
        validateApiKey(request, env.SANDBOX_API_KEY);
      } catch (error) {
        if (error instanceof AuthError) {
          return addCorsHeaders(createAuthErrorResponse(error));
        }
        throw error;
      }

      // Parse route
      const url = new URL(request.url);
      const route = parseRoute(url);

      if (!route) {
        return addCorsHeaders(
          Response.json(
            { error: 'NOT_FOUND', message: 'Invalid API path' },
            { status: 404 }
          )
        );
      }

      // Get sandbox instance
      const sandbox = getSandbox(env.Sandbox, route.sandboxId);

      // Dispatch to handler
      const response = await dispatchHandler(request, sandbox, route);

      return addCorsHeaders(response);
    }
  };
}
