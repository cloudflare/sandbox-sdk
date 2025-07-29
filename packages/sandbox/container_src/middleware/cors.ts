// CORS Middleware
import type { Middleware, RequestContext, NextFunction } from '../core/types';

export class CorsMiddleware implements Middleware {
  async handle(
    request: Request,
    context: RequestContext,
    next: NextFunction
  ): Promise<Response> {
    console.log(`[CorsMiddleware] Processing ${request.method} request`);

    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      console.log(`[CorsMiddleware] Handling CORS preflight`);
      return new Response(null, {
        status: 200,
        headers: context.corsHeaders,
      });
    }

    // For non-preflight requests, continue to next middleware/handler
    const response = await next();

    // Add CORS headers to the response
    const corsResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        ...Object.fromEntries(response.headers.entries()),
        ...context.corsHeaders,
      },
    });

    return corsResponse;
  }
}