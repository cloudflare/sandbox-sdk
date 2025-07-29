// Miscellaneous Handler for ping, commands, etc.
import { BaseHandler } from './base-handler';
import type { RequestContext, Logger } from '../core/types';

export class MiscHandler extends BaseHandler<Request, Response> {
  constructor(logger: Logger) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    switch (pathname) {
      case '/':
        return await this.handleRoot(request, context);
      case '/api/ping':
        return await this.handlePing(request, context);
      case '/api/commands':
        return await this.handleCommands(request, context);
      default:
        return this.createErrorResponse('Invalid endpoint', 404, context);
    }
  }

  private async handleRoot(request: Request, context: RequestContext): Promise<Response> {
    return new Response('Hello from Bun server! 🚀', {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        ...context.corsHeaders,
      },
    });
  }

  private async handlePing(request: Request, context: RequestContext): Promise<Response> {
    this.logger.info('Ping request', { requestId: context.requestId });

    return new Response(
      JSON.stringify({
        message: 'pong',
        timestamp: new Date().toISOString(),
        requestId: context.requestId,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          ...context.corsHeaders,
        },
      }
    );
  }

  private async handleCommands(request: Request, context: RequestContext): Promise<Response> {
    this.logger.info('Commands request', { requestId: context.requestId });

    return new Response(
      JSON.stringify({
        availableCommands: [
          'ls',
          'pwd',
          'echo',
          'cat',
          'grep',
          'find',
          'whoami',
          'date',
          'uptime',
          'ps',
          'top',
          'df',
          'du',
          'free',
          'node',
          'npm',
          'git',
          'curl',
          'wget',
        ],
        timestamp: new Date().toISOString(),
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          ...context.corsHeaders,
        },
      }
    );
  }
}