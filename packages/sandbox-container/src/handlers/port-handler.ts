// Port Handler
import type {
  PortCloseResult,
  PortExposeResult,
  PortListResult,
} from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';

import type { ExposePortRequest, Logger, RequestContext } from '../core/types';
import type { PortService } from '../services/port-service';
import { BaseHandler } from './base-handler';

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

    return this.createErrorResponse({
      message: 'Invalid port endpoint',
      code: ErrorCode.UNKNOWN_ERROR,
    }, context);
  }

  private async handleExpose(request: Request, context: RequestContext): Promise<Response> {
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

      const response: PortExposeResult = {
        success: true,
        port: portInfo.port,
        url: `http://localhost:${portInfo.port}`, // Generate URL from port
        timestamp: new Date().toISOString(),
      };

      return this.createTypedResponse(response, context);
    } else {
      this.logger.error('Port expose failed', undefined, {
        requestId: context.requestId,
        port: body.port,
        name: body.name,
        errorCode: result.error!.code,
        errorMessage: result.error!.message,
      });
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleUnexpose(request: Request, context: RequestContext, port: number): Promise<Response> {
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

      const response: PortCloseResult = {
        success: true,
        port,
        timestamp: new Date().toISOString(),
      };

      return this.createTypedResponse(response, context);
    } else {
      this.logger.error('Port unexpose failed', undefined, {
        requestId: context.requestId,
        port,
        errorCode: result.error!.code,
        errorMessage: result.error!.message,
      });
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleList(request: Request, context: RequestContext): Promise<Response> {
    this.logger.info('Listing exposed ports', { requestId: context.requestId });

    const result = await this.portService.getExposedPorts();

    if (result.success) {
      const ports = result.data!.map(portInfo => ({
        port: portInfo.port,
        url: `http://localhost:${portInfo.port}`,
        status: portInfo.status,
      }));

      const response: PortListResult = {
        success: true,
        ports,
        timestamp: new Date().toISOString(),
      };

      return this.createTypedResponse(response, context);
    } else {
      this.logger.error('Port listing failed', undefined, {
        requestId: context.requestId,
        errorCode: result.error!.code,
        errorMessage: result.error!.message,
      });
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleProxy(request: Request, context: RequestContext): Promise<Response> {
    try {
      // Extract port from URL path: /proxy/{port}/...
      const url = new URL(request.url);
      const pathSegments = url.pathname.split('/');
      
      if (pathSegments.length < 3) {
        return this.createErrorResponse({
          message: 'Invalid proxy URL format',
          code: ErrorCode.UNKNOWN_ERROR,
        }, context);
      }

      const portStr = pathSegments[2];
      const port = parseInt(portStr, 10);

      if (Number.isNaN(port)) {
        return this.createErrorResponse({
          message: 'Invalid port number in proxy URL',
          code: ErrorCode.UNKNOWN_ERROR,
        }, context);
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

      return this.createErrorResponse({
        message: error instanceof Error ? error.message : 'Proxy request failed',
        code: ErrorCode.UNKNOWN_ERROR,
      }, context);
    }
  }
}