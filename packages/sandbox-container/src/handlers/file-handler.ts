import type {
  DeleteFileResult,
  FileExistsRequest,
  FileExistsResult,
  FileStreamEvent,
  ListFilesResult,
  Logger,
  MkdirResult,
  MoveFileResult,
  ReadFileResult,
  RenameFileResult,
  WriteFileResult
} from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';

import type {
  DeleteFileRequest,
  ListFilesRequest,
  MkdirRequest,
  MoveFileRequest,
  ReadFileRequest,
  RenameFileRequest,
  RequestContext,
  WriteFileRequest
} from '../core/types';
import type { FileService } from '../services/file-service';
import { BaseHandler } from './base-handler';

export class FileHandler extends BaseHandler<Request, Response> {
  constructor(
    private fileService: FileService,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    switch (pathname) {
      case '/api/read':
        return await this.handleRead(request, context);
      case '/api/read/stream':
        return await this.handleReadStream(request, context);
      case '/api/write':
        return await this.handleWrite(request, context);
      case '/api/delete':
        return await this.handleDelete(request, context);
      case '/api/rename':
        return await this.handleRename(request, context);
      case '/api/move':
        return await this.handleMove(request, context);
      case '/api/mkdir':
        return await this.handleMkdir(request, context);
      case '/api/list-files':
        return await this.handleListFiles(request, context);
      case '/api/exists':
        return await this.handleExists(request, context);
      default:
        return this.createErrorResponse(
          {
            message: 'Invalid file endpoint',
            code: ErrorCode.UNKNOWN_ERROR
          },
          context
        );
    }
  }

  private async handleRead(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<ReadFileRequest>(request);

    const result = await this.fileService.readFile(body.path, {
      encoding: body.encoding
    });

    if (result.success) {
      const response: ReadFileResult = {
        success: true,
        path: body.path,
        content: result.data,
        timestamp: new Date().toISOString(),
        encoding: result.metadata?.encoding,
        isBinary: result.metadata?.isBinary,
        mimeType: result.metadata?.mimeType,
        size: result.metadata?.size
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleReadStream(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<ReadFileRequest>(request);

    try {
      // Create SSE stream (handles metadata fetching and errors internally)
      const stream = await this.fileService.readFileStreamOperation(
        body.path,
        body.sessionId
      );

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...context.corsHeaders
        }
      });
    } catch (error) {
      this.logger.error(
        'File streaming failed',
        error instanceof Error ? error : undefined,
        {
          requestId: context.requestId,
          path: body.path
        }
      );

      // Return error as SSE event
      const encoder = new TextEncoder();
      const errorEvent: FileStreamEvent = {
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`)
          );
          controller.close();
        }
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...context.corsHeaders
        }
      });
    }
  }

  private async handleWrite(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<WriteFileRequest>(request);

    const result = await this.fileService.writeFile(body.path, body.content, {
      encoding: body.encoding
    });

    if (result.success) {
      const response: WriteFileResult = {
        success: true,
        path: body.path,
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleDelete(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<DeleteFileRequest>(request);

    const result = await this.fileService.deleteFile(body.path);

    if (result.success) {
      const response: DeleteFileResult = {
        success: true,
        path: body.path,
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleRename(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<RenameFileRequest>(request);

    const result = await this.fileService.renameFile(
      body.oldPath,
      body.newPath
    );

    if (result.success) {
      const response: RenameFileResult = {
        success: true,
        path: body.oldPath,
        newPath: body.newPath,
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleMove(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<MoveFileRequest>(request);

    const result = await this.fileService.moveFile(
      body.sourcePath,
      body.destinationPath
    );

    if (result.success) {
      const response: MoveFileResult = {
        success: true,
        path: body.sourcePath,
        newPath: body.destinationPath,
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleMkdir(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<MkdirRequest>(request);

    const result = await this.fileService.createDirectory(body.path, {
      recursive: body.recursive
    });

    if (result.success) {
      const response: MkdirResult = {
        success: true,
        path: body.path,
        recursive: body.recursive ?? false,
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleListFiles(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<ListFilesRequest>(request);

    const result = await this.fileService.listFiles(
      body.path,
      body.options || {},
      body.sessionId
    );

    if (result.success) {
      const response: ListFilesResult = {
        success: true,
        path: body.path,
        files: result.data,
        count: result.data.length,
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleExists(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<FileExistsRequest>(request);

    const result = await this.fileService.exists(body.path, body.sessionId);

    if (result.success) {
      const response: FileExistsResult = {
        success: true,
        path: body.path,
        exists: result.data,
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }
}
