import { randomBytes } from "node:crypto";
import type { Logger, SessionCreateResult } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';

import type { RequestContext } from '../core/types';
import type { SessionManager } from '../services/session-manager';
import { BaseHandler } from './base-handler';

// SessionListResult type - matches actual handler return format
interface SessionListResult {
  success: boolean;
  data: string[];
  timestamp: string;
}

export class SessionHandler extends BaseHandler<Request, Response> {
  constructor(
    private sessionManager: SessionManager,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    switch (pathname) {
      case '/api/session/create':
        return await this.handleCreate(request, context);
      case '/api/session/list':
        return await this.handleList(request, context);
      default:
        return this.createErrorResponse({
          message: 'Invalid session endpoint',
          code: ErrorCode.UNKNOWN_ERROR,
        }, context);
    }
  }

  private async handleCreate(request: Request, context: RequestContext): Promise<Response> {
    // Parse request body for session options
    let sessionId: string;
    let env: Record<string, string>;
    let cwd: string;

    try {
      const body = await request.json() as any;
      sessionId = body.id || this.generateSessionId();
      env = body.env || {};
      cwd = body.cwd || '/workspace';
    } catch {
      // If no body or invalid JSON, use defaults
      sessionId = this.generateSessionId();
      env = {};
      cwd = '/workspace';
    }

    const result = await this.sessionManager.createSession({
      id: sessionId,
      env,
      cwd,
    });

    if (result.success) {
      // Note: Returning the Session object directly for now
      // This matches current test expectations
      const response = {
        success: true,
        data: result.data,
        timestamp: new Date().toISOString(),
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleList(request: Request, context: RequestContext): Promise<Response> {
    const result = await this.sessionManager.listSessions();

    if (result.success) {
      const response: SessionListResult = {
        success: true,
        data: result.data,
        timestamp: new Date().toISOString(),
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${randomBytes(6).toString('hex')}`;
  }
}
