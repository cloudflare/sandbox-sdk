// Validation Middleware
import type { Middleware, RequestContext, NextFunction, ValidatedRequestContext, ValidationResult } from '../core/types';
import type { RequestValidator } from '../validation/request-validator';

export class ValidationMiddleware implements Middleware {
  constructor(private validator: RequestValidator) {}

  async handle(
    request: Request,
    context: RequestContext,
    next: NextFunction
  ): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Skip validation for certain endpoints
    if (this.shouldSkipValidation(pathname)) {
      return await next();
    }

    // Only validate requests with JSON bodies
    if (request.method === 'POST' || request.method === 'PUT') {
      try {
        const contentType = request.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          // Parse request body for validation
          const body = await request.json();
          
          // Validate based on endpoint
          const validationResult = this.validateByEndpoint(pathname, body);
          
          if (!validationResult.isValid) {
            return new Response(
              JSON.stringify({
                error: 'Validation Error',
                message: 'Request validation failed',
                details: validationResult.errors,
                timestamp: new Date().toISOString(),
              }),
              {
                status: 400,
                headers: {
                  'Content-Type': 'application/json',
                  ...context.corsHeaders,
                },
              }
            );
          }

          // Create new request with validated data
          const validatedRequest = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: JSON.stringify(validationResult.data),
          });

          // Store original request in context for handlers
          const validatedContext = context as ValidatedRequestContext;
          validatedContext.originalRequest = request;
          validatedContext.validatedData = validationResult.data;

          return await next();
        }
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: 'Invalid JSON',
            message: 'Request body must be valid JSON',
            timestamp: new Date().toISOString(),
          }),
          {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              ...context.corsHeaders,
            },
          }
        );
      }
    }

    return await next();
  }

  private shouldSkipValidation(pathname: string): boolean {
    const skipPatterns = [
      '/',
      '/api/ping',
      '/api/commands',
      '/api/session/list',
      '/api/exposed-ports',
      '/api/process/list',
      '/proxy/',
    ];

    return skipPatterns.some(pattern => 
      pathname === pattern || pathname.startsWith(pattern)
    );
  }

  private validateByEndpoint(pathname: string, body: unknown): ValidationResult<unknown> {
    switch (pathname) {
      case '/api/execute':
      case '/api/execute/stream':
        return this.validator.validateExecuteRequest(body);

      case '/api/read':
        return this.validator.validateFileRequest(body, 'read');

      case '/api/write':
        return this.validator.validateFileRequest(body, 'write');

      case '/api/delete':
        return this.validator.validateFileRequest(body, 'delete');

      case '/api/rename':
        return this.validator.validateFileRequest(body, 'rename');

      case '/api/move':
        return this.validator.validateFileRequest(body, 'move');

      case '/api/mkdir':
        return this.validator.validateFileRequest(body, 'mkdir');

      case '/api/expose-port':
        return this.validator.validatePortRequest(body);

      case '/api/process/start':
        return this.validator.validateProcessRequest(body);

      case '/api/git/checkout':
        return this.validator.validateGitRequest(body);

      default:
        // For dynamic routes, try to determine validation type
        if (pathname.startsWith('/api/process/') && pathname.split('/').length > 3) {
          // Individual process operations don't need body validation
          return { isValid: true, data: body, errors: [] };
        }

        if (pathname.startsWith('/api/exposed-ports/') && pathname.split('/').length > 3) {
          // Individual port operations don't need body validation
          return { isValid: true, data: body, errors: [] };
        }

        // Default: no validation required
        return { isValid: true, data: body, errors: [] };
    }
  }
}