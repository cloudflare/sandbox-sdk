import { posix as pathPosix } from 'node:path';
import type { Logger, WatchRequest } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import type { RequestContext } from '../core/types';
import type { WatchService } from '../services/watch-service';
import { BaseHandler } from './base-handler';

interface StopWatchRequest {
  watchId: string;
}

const WORKSPACE_ROOT = '/workspace';

/**
 * Handler for file watch operations
 */
export class WatchHandler extends BaseHandler<Request, Response> {
  constructor(
    private watchService: WatchService,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (pathname === '/api/watch') {
      return this.handleWatch(request, context);
    }

    if (pathname === '/api/watch/stop') {
      return this.handleStopWatch(request, context);
    }

    return this.createErrorResponse(
      {
        message: 'Invalid watch endpoint',
        code: ErrorCode.VALIDATION_FAILED,
        details: { pathname }
      },
      context
    );
  }

  /**
   * Start watching a directory.
   * Returns an SSE stream of file change events.
   */
  private async handleWatch(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    let body: WatchRequest;
    try {
      body = await this.parseRequestBody<WatchRequest>(request);
    } catch (error) {
      return this.createErrorResponse(
        {
          message:
            error instanceof Error ? error.message : 'Invalid request body',
          code: ErrorCode.VALIDATION_FAILED
        },
        context
      );
    }

    const validationError = this.validateWatchBody(body);
    if (validationError) {
      return this.createErrorResponse(validationError, context);
    }

    const pathResult = this.normalizeWatchPath(body.path);
    if (!pathResult.success) {
      return this.createErrorResponse(pathResult.error, context);
    }

    const result = await this.watchService.watchDirectory(pathResult.path, {
      ...body,
      path: pathResult.path
    });

    if (result.success) {
      return new Response(result.data, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...context.corsHeaders
        }
      });
    }

    return this.createErrorResponse(result.error, context);
  }

  /**
   * Stop an active watch by ID.
   */
  private async handleStopWatch(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    let body: StopWatchRequest;
    try {
      body = await this.parseRequestBody<StopWatchRequest>(request);
    } catch (error) {
      return this.createErrorResponse(
        {
          message:
            error instanceof Error ? error.message : 'Invalid request body',
          code: ErrorCode.VALIDATION_FAILED
        },
        context
      );
    }

    if (
      !body ||
      typeof body.watchId !== 'string' ||
      body.watchId.trim() === ''
    ) {
      return this.createErrorResponse(
        {
          message: 'watchId is required and must be a non-empty string',
          code: ErrorCode.VALIDATION_FAILED,
          details: { watchId: body?.watchId }
        },
        context
      );
    }

    const result = await this.watchService.stopWatch(body.watchId.trim());
    if (!result.success) {
      return this.createErrorResponse(result.error, context);
    }

    return this.createTypedResponse(
      {
        success: true,
        watchId: body.watchId.trim(),
        timestamp: new Date().toISOString()
      },
      context
    );
  }

  private validateWatchBody(body: WatchRequest): {
    message: string;
    code: string;
    details?: Record<string, unknown>;
  } | null {
    if (!body || typeof body !== 'object') {
      return {
        message: 'Request body must be a JSON object',
        code: ErrorCode.VALIDATION_FAILED
      };
    }

    if (typeof body.path !== 'string' || body.path.trim() === '') {
      return {
        message: 'path is required and must be a non-empty string',
        code: ErrorCode.VALIDATION_FAILED,
        details: { path: body.path }
      };
    }

    if (!this.isStringArrayOrUndefined(body.include)) {
      return {
        message: 'include must be an array of strings',
        code: ErrorCode.VALIDATION_FAILED,
        details: { include: body.include }
      };
    }

    const invalidInclude = this.findUnsupportedPattern(body.include);
    if (invalidInclude) {
      return {
        message:
          'include contains unsupported glob syntax. Supported tokens: *, **, ? and path separators',
        code: ErrorCode.VALIDATION_FAILED,
        details: { pattern: invalidInclude, include: body.include }
      };
    }

    if (!this.isStringArrayOrUndefined(body.exclude)) {
      return {
        message: 'exclude must be an array of strings',
        code: ErrorCode.VALIDATION_FAILED,
        details: { exclude: body.exclude }
      };
    }

    const invalidExclude = this.findUnsupportedPattern(body.exclude);
    if (invalidExclude) {
      return {
        message:
          'exclude contains unsupported glob syntax. Supported tokens: *, **, ? and path separators',
        code: ErrorCode.VALIDATION_FAILED,
        details: { pattern: invalidExclude, exclude: body.exclude }
      };
    }

    if (body.recursive !== undefined && typeof body.recursive !== 'boolean') {
      return {
        message: 'recursive must be a boolean when provided',
        code: ErrorCode.VALIDATION_FAILED,
        details: { recursive: body.recursive }
      };
    }

    return null;
  }

  private isStringArrayOrUndefined(
    value: unknown
  ): value is string[] | undefined {
    return (
      value === undefined ||
      (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    );
  }

  private findUnsupportedPattern(patterns?: string[]): string | null {
    if (!patterns) {
      return null;
    }

    // Supported syntax is intentionally narrow: *, **, ? and path separators.
    // Character classes and brace expansion are rejected so behavior is explicit.
    const unsupportedTokens = /[[\]{}]/;

    for (const pattern of patterns) {
      if (pattern.trim() === '' || pattern.includes('\0')) {
        return pattern;
      }
      if (unsupportedTokens.test(pattern)) {
        return pattern;
      }
    }

    return null;
  }

  private normalizeWatchPath(path: string):
    | { success: true; path: string }
    | {
        success: false;
        error: {
          message: string;
          code: string;
          details?: Record<string, unknown>;
        };
      } {
    const input = path.trim();

    if (input.includes('\0')) {
      return {
        success: false,
        error: {
          message: 'path contains invalid null bytes',
          code: ErrorCode.VALIDATION_FAILED,
          details: { path }
        }
      };
    }

    const resolved = input.startsWith('/')
      ? pathPosix.resolve(input)
      : pathPosix.resolve(WORKSPACE_ROOT, input);

    if (
      resolved !== WORKSPACE_ROOT &&
      !resolved.startsWith(`${WORKSPACE_ROOT}/`)
    ) {
      return {
        success: false,
        error: {
          message: 'path must be inside /workspace',
          code: ErrorCode.PERMISSION_DENIED,
          details: {
            path,
            resolvedPath: resolved,
            workspaceRoot: WORKSPACE_ROOT
          }
        }
      };
    }

    return { success: true, path: resolved };
  }
}
