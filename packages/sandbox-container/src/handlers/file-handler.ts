import type {
  DeleteFileResult,
  FileStreamEvent,
  ListFilesResult,
  MkdirResult,
  MoveFileResult,
  ReadFileResult,
  RenameFileResult,
  WriteFileResult,
} from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';

import type {
  DeleteFileRequest,
  ListFilesRequest,
  Logger,
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
      default:
        return this.createErrorResponse({
          message: 'Invalid file endpoint',
          code: ErrorCode.UNKNOWN_ERROR,
        }, context);
    }
  }

  private async handleRead(request: Request, context: RequestContext): Promise<Response> {
    const body = await this.parseRequestBody<ReadFileRequest>(request);

    this.logger.info('Reading file', {
      requestId: context.requestId,
      path: body.path,
      encoding: body.encoding
    });

    const result = await this.fileService.readFile(body.path, {
      encoding: body.encoding || 'utf-8',
    });

    if (result.success) {
      this.logger.info('File read successfully', {
        requestId: context.requestId,
        path: body.path,
        sizeBytes: result.data.length,
      });

      const response: ReadFileResult = {
        success: true,
        path: body.path,
        content: result.data,
        timestamp: new Date().toISOString(),
        encoding: result.metadata?.encoding,
        isBinary: result.metadata?.isBinary,
        mimeType: result.metadata?.mimeType,
        size: result.metadata?.size,
      };

      return this.createTypedResponse(response, context);
    } else {
      this.logger.error('File read failed', undefined, {
        requestId: context.requestId,
        path: body.path,
        errorCode: result.error.code,
        errorMessage: result.error.message,
      });

      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleReadStream(request: Request, context: RequestContext): Promise<Response> {
    const body = await this.parseRequestBody<ReadFileRequest>(request);

    this.logger.info('Streaming file', {
      requestId: context.requestId,
      path: body.path,
    });

    try {
      // Get file metadata first
      const metadataResult = await this.fileService.readFile(body.path, { encoding: 'utf-8' });

      if (!metadataResult.success) {
        // Return error as SSE event
        const encoder = new TextEncoder();
        const errorEvent: FileStreamEvent = {
          type: 'error',
          error: metadataResult.error.message
        };
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
            controller.close();
          }
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...context.corsHeaders,
          },
        });
      }

      // Create SSE stream
      const stream = await this.fileService.readFileStreamOperation(body.path, body.sessionId);

      this.logger.info('File streaming started', {
        requestId: context.requestId,
        path: body.path,
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...context.corsHeaders,
        },
      });
    } catch (error) {
      this.logger.error('File streaming failed', error instanceof Error ? error : undefined, {
        requestId: context.requestId,
        path: body.path,
      });

      // Return error as SSE event
      const encoder = new TextEncoder();
      const errorEvent: FileStreamEvent = {
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
          controller.close();
        }
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...context.corsHeaders,
        },
      });
    }
  }

  private async handleWrite(request: Request, context: RequestContext): Promise<Response> {
    const body = await this.parseRequestBody<WriteFileRequest>(request);

    this.logger.info('Writing file', {
      requestId: context.requestId,
      path: body.path,
      sizeBytes: body.content.length,
      encoding: body.encoding
    });

    const result = await this.fileService.writeFile(body.path, body.content, {
      encoding: body.encoding || 'utf-8',
    });

    if (result.success) {
      this.logger.info('File written successfully', {
        requestId: context.requestId,
        path: body.path,
        sizeBytes: body.content.length,
      });

      const response: WriteFileResult = {
        success: true,
        path: body.path,
        timestamp: new Date().toISOString(),
      };

      return this.createTypedResponse(response, context);
    } else {
      this.logger.error('File write failed', undefined, {
        requestId: context.requestId,
        path: body.path,
        errorCode: result.error.code,
        errorMessage: result.error.message,
      });

      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleDelete(request: Request, context: RequestContext): Promise<Response> {
    const body = await this.parseRequestBody<DeleteFileRequest>(request);

    this.logger.info('Deleting file', {
      requestId: context.requestId,
      path: body.path
    });

    const result = await this.fileService.deleteFile(body.path);

    if (result.success) {
      this.logger.info('File deleted successfully', {
        requestId: context.requestId,
        path: body.path,
      });

      const response: DeleteFileResult = {
        success: true,
        path: body.path,
        timestamp: new Date().toISOString(),
      };

      return this.createTypedResponse(response, context);
    } else {
      this.logger.error('File delete failed', undefined, {
        requestId: context.requestId,
        path: body.path,
        errorCode: result.error.code,
        errorMessage: result.error.message,
      });

      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleRename(request: Request, context: RequestContext): Promise<Response> {
    const body = await this.parseRequestBody<RenameFileRequest>(request);

    this.logger.info('Renaming file', {
      requestId: context.requestId,
      oldPath: body.oldPath,
      newPath: body.newPath
    });

    const result = await this.fileService.renameFile(body.oldPath, body.newPath);

    if (result.success) {
      this.logger.info('File renamed successfully', {
        requestId: context.requestId,
        oldPath: body.oldPath,
        newPath: body.newPath,
      });

      const response: RenameFileResult = {
        success: true,
        path: body.oldPath,
        newPath: body.newPath,
        timestamp: new Date().toISOString(),
      };

      return this.createTypedResponse(response, context);
    } else {
      this.logger.error('File rename failed', undefined, {
        requestId: context.requestId,
        oldPath: body.oldPath,
        newPath: body.newPath,
        errorCode: result.error.code,
        errorMessage: result.error.message,
      });

      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleMove(request: Request, context: RequestContext): Promise<Response> {
    const body = await this.parseRequestBody<MoveFileRequest>(request);

    this.logger.info('Moving file', {
      requestId: context.requestId,
      sourcePath: body.sourcePath,
      destinationPath: body.destinationPath
    });

    const result = await this.fileService.moveFile(body.sourcePath, body.destinationPath);

    if (result.success) {
      this.logger.info('File moved successfully', {
        requestId: context.requestId,
        sourcePath: body.sourcePath,
        destinationPath: body.destinationPath,
      });

      const response: MoveFileResult = {
        success: true,
        path: body.sourcePath,
        newPath: body.destinationPath,
        timestamp: new Date().toISOString(),
      };

      return this.createTypedResponse(response, context);
    } else {
      this.logger.error('File move failed', undefined, {
        requestId: context.requestId,
        sourcePath: body.sourcePath,
        destinationPath: body.destinationPath,
        errorCode: result.error.code,
        errorMessage: result.error.message,
      });

      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleMkdir(request: Request, context: RequestContext): Promise<Response> {
    const body = await this.parseRequestBody<MkdirRequest>(request);

    this.logger.info('Creating directory', {
      requestId: context.requestId,
      path: body.path,
      recursive: body.recursive
    });

    const result = await this.fileService.createDirectory(body.path, {
      recursive: body.recursive,
    });

    if (result.success) {
      this.logger.info('Directory created successfully', {
        requestId: context.requestId,
        path: body.path,
        recursive: body.recursive,
      });

      const response: MkdirResult = {
        success: true,
        path: body.path,
        recursive: body.recursive ?? false,
        timestamp: new Date().toISOString(),
      };

      return this.createTypedResponse(response, context);
    } else {
      this.logger.error('Directory creation failed', undefined, {
        requestId: context.requestId,
        path: body.path,
        recursive: body.recursive,
        errorCode: result.error.code,
        errorMessage: result.error.message,
      });

      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleListFiles(request: Request, context: RequestContext): Promise<Response> {
    const body = await this.parseRequestBody<ListFilesRequest>(request);

    this.logger.info('Listing files', {
      requestId: context.requestId,
      path: body.path,
      recursive: body.options?.recursive,
      includeHidden: body.options?.includeHidden
    });

    const result = await this.fileService.listFiles(
      body.path,
      body.options || {},
      body.sessionId
    );

    if (result.success) {
      this.logger.info('Files listed successfully', {
        requestId: context.requestId,
        path: body.path,
        count: result.data.length,
      });

      const response: ListFilesResult = {
        success: true,
        path: body.path,
        files: result.data,
        count: result.data.length,
        timestamp: new Date().toISOString(),
      };

      return this.createTypedResponse(response, context);
    } else {
      this.logger.error('List files failed', undefined, {
        requestId: context.requestId,
        path: body.path,
        errorCode: result.error.code,
        errorMessage: result.error.message,
      });

      return this.createErrorResponse(result.error, context);
    }
  }
}