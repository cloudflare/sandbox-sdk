// Port Handler
import { BaseHandler } from './base-handler';
import type { RequestContext, Logger, ExposePortRequest } from '../core/types';
import type { PortService } from '../services/port-service';

export class PortHandler extends BaseHandler<Request, Response> {
  constructor(
    private portService: PortService,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      if (pathname === '/api/expose-port') {
        return await this.handleExpose(request, context);
      } else if (pathname === '/api/exposed-ports') {
        return await this.handleList(request, context);
      } else if (pathname.startsWith('/api/exposed-ports/')) {
        // Handle dynamic routes for individual ports
        const segments = pathname.split('/');
        if (segments.length >= 4) {
          const portStr = segments[3];
          const port = parseInt(portStr, 10);

          if (!Number.isNaN(port) && request.method === 'DELETE') {
            return await this.handleUnexpose(request, context, port);
          }
        }
      } else if (pathname.startsWith('/proxy/')) {
        return await this.handleProxy(request, context);
      }

      return this.createErrorResponse('Invalid port endpoint', 404, context);
    } catch (error) {
      return this.createErrorResponse(error instanceof Error ? error : 'Unknown error', 500, context);
    }
  }

  private async handleExpose(request: Request, context: RequestContext): Promise<Response> {
    try {
      const body = await this.parseRequestBody<ExposePortRequest>(request);
      
      this.logger.info('Exposing port', { 
        requestId: context.requestId,
        port: body.port,
        name: body.name
      });

      const result = await this.portService.exposePort(body.port, body.name);

      if (result.success) {
        const portInfo = result.data!;
        
        this.logger.info('Port exposed successfully', {
          requestId: context.requestId,
          port: portInfo.port,
          name: portInfo.name,
        });

        return new Response(
          JSON.stringify({
            success: true,
            port: portInfo.port,
            name: portInfo.name,
            exposedAt: portInfo.exposedAt.toISOString(),
            status: portInfo.status,
            message: 'Port exposed successfully',
            timestamp: new Date().toISOString(),
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              ...context.corsHeaders,
            },
          }
        );
      } else {
        return this.createErrorResponse(result.error!, 400, context);
      }
    } catch (error) {
      return this.createErrorResponse(error instanceof Error ? error : 'Unknown error', 500, context);
    }
  }

  private async handleUnexpose(request: Request, context: RequestContext, port: number): Promise<Response> {
    try {
      this.logger.info('Unexposing port', { 
        requestId: context.requestId,
        port 
      });

      const result = await this.portService.unexposePort(port);

      if (result.success) {
        this.logger.info('Port unexposed successfully', {
          requestId: context.requestId,
          port,
        });

        return new Response(
          JSON.stringify({
            success: true,
            message: 'Port unexposed successfully',
            port,
            timestamp: new Date().toISOString(),
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              ...context.corsHeaders,
            },
          }
        );
      } else {
        return this.createErrorResponse(result.error!, 404, context);
      }
    } catch (error) {
      return this.createErrorResponse(error instanceof Error ? error : 'Unknown error', 500, context);
    }
  }

  private async handleList(request: Request, context: RequestContext): Promise<Response> {
    try {
      this.logger.info('Listing exposed ports', { requestId: context.requestId });

      const result = await this.portService.getExposedPorts();

      if (result.success) {
        const ports = result.data!.map(portInfo => ({
          port: portInfo.port,
          name: portInfo.name,
          exposedAt: portInfo.exposedAt.toISOString(),
          status: portInfo.status,
        }));

        return new Response(
          JSON.stringify({
            success: true,
            count: ports.length,
            ports,
            timestamp: new Date().toISOString(),
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              ...context.corsHeaders,
            },
          }
        );
      } else {
        return this.createErrorResponse(result.error!, 500, context);
      }
    } catch (error) {
      return this.createErrorResponse(error instanceof Error ? error : 'Unknown error', 500, context);
    }
  }

  private async handleProxy(request: Request, context: RequestContext): Promise<Response> {
    try {
      // Extract port from URL path: /proxy/{port}/...
      const url = new URL(request.url);
      const pathSegments = url.pathname.split('/');
      
      if (pathSegments.length < 3) {
        return this.createErrorResponse('Invalid proxy URL format', 400, context);
      }

      const portStr = pathSegments[2];
      const port = parseInt(portStr, 10);

      if (Number.isNaN(port)) {
        return this.createErrorResponse('Invalid port number in proxy URL', 400, context);
      }

      this.logger.info('Proxying request', { 
        requestId: context.requestId,
        port,
        method: request.method,
        originalPath: url.pathname,
      });

      // Use the port service to proxy the request
      const response = await this.portService.proxyRequest(port, request);

      // Log the proxy result
      this.logger.info('Proxy request completed', {
        requestId: context.requestId,
        port,
        status: response.status,
      });

      return response;
    } catch (error) {
      this.logger.error('Proxy request failed', error instanceof Error ? error : undefined, {
        requestId: context.requestId,
      });
      
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Proxy request failed', 
        502, 
        context
      );
    }
  }
}