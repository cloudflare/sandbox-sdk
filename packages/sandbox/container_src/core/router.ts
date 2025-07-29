// Centralized Router for handling HTTP requests
import type { 
  RouteDefinition, 
  HttpMethod, 
  RequestHandler, 
  Middleware, 
  RequestContext, 
  NextFunction 
} from './types';

export class Router {
  private routes: RouteDefinition[] = [];
  private globalMiddleware: Middleware[] = [];

  /**
   * Register a route with optional middleware
   */
  register(definition: RouteDefinition): void {
    this.routes.push(definition);
  }

  /**
   * Add global middleware that runs for all routes
   */
  use(middleware: Middleware): void {
    this.globalMiddleware.push(middleware);
  }

  /**
   * Route an incoming request to the appropriate handler
   */
  async route(request: Request): Promise<Response> {
    const method = request.method as HttpMethod;
    const pathname = new URL(request.url).pathname;
    
    console.log(`[Router] Routing ${method} ${pathname}`);

    // Find matching route
    const route = this.matchRoute(method, pathname);
    
    if (!route) {
      console.log(`[Router] No route found for ${method} ${pathname}`);
      return this.createNotFoundResponse();
    }

    // Create request context
    const context: RequestContext = {
      sessionId: this.extractSessionId(request),
      corsHeaders: this.getCorsHeaders(),
      requestId: this.generateRequestId(),
      timestamp: new Date(),
    };

    try {
      // Build middleware chain (global + route-specific)
      const middlewareChain = [...this.globalMiddleware, ...(route.middleware || [])];
      
      // Execute middleware chain
      return await this.executeMiddlewareChain(
        middlewareChain,
        request,
        context,
        route.handler
      );
    } catch (error) {
      console.error(`[Router] Error handling ${method} ${pathname}:`, error);
      return this.createErrorResponse(error instanceof Error ? error : new Error('Unknown error'));
    }
  }

  /**
   * Match a route based on method and path
   */
  private matchRoute(method: HttpMethod, path: string): RouteDefinition | null {
    for (const route of this.routes) {
      if (route.method === method && this.pathMatches(route.path, path)) {
        return route;
      }
    }
    return null;
  }

  /**
   * Check if a route path matches the request path
   * Supports basic dynamic routes like /api/process/{id}
   */
  private pathMatches(routePath: string, requestPath: string): boolean {
    // Exact match
    if (routePath === requestPath) {
      return true;
    }

    // Dynamic route matching
    const routeSegments = routePath.split('/');
    const requestSegments = requestPath.split('/');

    if (routeSegments.length !== requestSegments.length) {
      return false;
    }

    return routeSegments.every((segment, index) => {
      // Dynamic segment (starts with {)
      if (segment.startsWith('{') && segment.endsWith('}')) {
        return true;
      }
      // Exact match required
      return segment === requestSegments[index];
    });
  }

  /**
   * Execute middleware chain with proper next() handling
   */
  private async executeMiddlewareChain(
    middlewareChain: Middleware[],
    request: Request,
    context: RequestContext,
    finalHandler: RequestHandler
  ): Promise<Response> {
    let currentIndex = 0;

    const next: NextFunction = async (): Promise<Response> => {
      // If we've reached the end of middleware, call the final handler
      if (currentIndex >= middlewareChain.length) {
        return await finalHandler(request, context);
      }

      // Get the current middleware and increment index
      const middleware = middlewareChain[currentIndex];
      currentIndex++;

      // Execute middleware with next function
      return await middleware.handle(request, context, next);
    };

    return await next();
  }

  /**
   * Extract session ID from request headers or body
   */
  private extractSessionId(request: Request): string | undefined {
    // Try to get from Authorization header
    const authHeader = request.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    // Try to get from X-Session-Id header
    const sessionHeader = request.headers.get('X-Session-Id');
    if (sessionHeader) {
      return sessionHeader;
    }

    // Will be extracted from request body in individual handlers if needed
    return undefined;
  }

  /**
   * Get CORS headers
   */
  private getCorsHeaders(): Record<string, string> {
    return {
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-Id',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Origin': '*',
    };
  }

  /**
   * Generate a unique request ID for tracing
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * Create a 404 Not Found response
   */
  private createNotFoundResponse(): Response {
    return new Response(
      JSON.stringify({
        error: 'Not Found',
        message: 'The requested endpoint was not found',
        timestamp: new Date().toISOString(),
      }),
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          ...this.getCorsHeaders(),
        },
      }
    );
  }

  /**
   * Create an error response
   */
  private createErrorResponse(error: Error): Response {
    return new Response(
      JSON.stringify({
        error: 'Internal Server Error',
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...this.getCorsHeaders(),
        },
      }
    );
  }

  /**
   * Get all registered routes (for debugging/testing)
   */
  getRoutes(): RouteDefinition[] {
    return [...this.routes];
  }

  /**
   * Clear all routes (for testing)
   */
  clearRoutes(): void {
    this.routes = [];
  }
}