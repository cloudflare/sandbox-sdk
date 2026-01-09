// Centralized Router for handling HTTP requests

import type { Logger } from '@repo/shared';
import type { ErrorResponse } from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import type {
  HttpMethod,
  Middleware,
  NextFunction,
  RequestContext,
  RequestHandler,
  RouteDefinition
} from './types';

export class Router {
  private routes: RouteDefinition[] = [];
  private globalMiddleware: Middleware[] = [];
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Register a route with optional middleware
   */
  register(definition: RouteDefinition): void {
    this.logger.debug('Registering route', {
      method: definition.method,
      path: definition.path
    });
    this.routes.push(definition);
  }

  /**
   * Add global middleware that runs for all routes
   */
  use(middleware: Middleware): void {
    this.globalMiddleware.push(middleware);
  }

  /**
   * Log all registered routes at startup (INFO level for visibility)
   */
  logRegisteredRoutes(): void {
    const ptyRoutes = this.routes
      .filter((r) => r.path.includes('/pty'))
      .map((r) => `${r.method} ${r.path}`);

    this.logger.info('Routes registered at startup', {
      totalRoutes: this.routes.length,
      ptyRouteCount: ptyRoutes.length,
      ptyRoutes: ptyRoutes.join(', ')
    });
  }

  private validateHttpMethod(method: string): HttpMethod {
    const validMethods: HttpMethod[] = [
      'GET',
      'POST',
      'PUT',
      'DELETE',
      'OPTIONS'
    ];
    if (validMethods.includes(method as HttpMethod)) {
      return method as HttpMethod;
    }
    throw new Error(`Unsupported HTTP method: ${method}`);
  }

  /**
   * Route an incoming request to the appropriate handler
   */
  async route(request: Request): Promise<Response> {
    const method = this.validateHttpMethod(request.method);
    const pathname = new URL(request.url).pathname;

    // Find matching route
    const route = this.matchRoute(method, pathname);

    if (!route) {
      // Log at INFO for PTY routes to help debug 404 issues in CI
      const isPtyRoute = pathname.includes('/pty');
      const logLevel = isPtyRoute ? 'info' : 'debug';
      const ptyRoutes = this.routes
        .filter((r) => r.path.includes('/pty'))
        .map((r) => `${r.method} ${r.path}`);

      this.logger[logLevel]('No route found', {
        method,
        pathname,
        totalRoutes: this.routes.length,
        ptyRouteCount: ptyRoutes.length,
        ptyRoutes: ptyRoutes.join(', ')
      });
      return this.createNotFoundResponse();
    }

    // Create request context
    const context: RequestContext = {
      sessionId: this.extractSessionId(request),
      corsHeaders: this.getCorsHeaders(),
      requestId: this.generateRequestId(),
      timestamp: new Date()
    };

    try {
      // Build middleware chain (global + route-specific)
      const middlewareChain = [
        ...this.globalMiddleware,
        ...(route.middleware || [])
      ];

      // Execute middleware chain
      return await this.executeMiddlewareChain(
        middlewareChain,
        request,
        context,
        route.handler
      );
    } catch (error) {
      this.logger.error('Error handling request', error as Error, {
        method,
        pathname,
        requestId: context.requestId
      });
      return this.createErrorResponse(
        error instanceof Error ? error : new Error('Unknown error')
      );
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
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    // Try to get from X-Session-Id header
    const sessionHeader = request.headers.get('X-Session-Id');
    if (sessionHeader) {
      return sessionHeader;
    }

    // Try query params ?session= or ?sessionId=
    try {
      const url = new URL(request.url);
      const qp =
        url.searchParams.get('session') || url.searchParams.get('sessionId');
      if (qp) {
        return qp;
      }
    } catch {
      // ignore URL parsing errors
    }

    // Will be extracted from request body in individual handlers if needed
    return undefined;
  }

  /**
   * Get CORS headers
   */
  private getCorsHeaders(): Record<string, string> {
    return {
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, X-Session-Id',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Origin': '*'
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
    const errorResponse: ErrorResponse = {
      code: ErrorCode.UNKNOWN_ERROR,
      message: 'The requested endpoint was not found',
      context: {},
      httpStatus: 404,
      timestamp: new Date().toISOString()
    };

    return new Response(JSON.stringify(errorResponse), {
      status: 404,
      headers: {
        'Content-Type': 'application/json',
        ...this.getCorsHeaders()
      }
    });
  }

  /**
   * Create an error response
   */
  private createErrorResponse(error: Error): Response {
    const errorResponse: ErrorResponse = {
      code: ErrorCode.INTERNAL_ERROR,
      message: error.message,
      context: {
        stack: error.stack
      },
      httpStatus: 500,
      timestamp: new Date().toISOString()
    };

    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...this.getCorsHeaders()
      }
    });
  }
}
