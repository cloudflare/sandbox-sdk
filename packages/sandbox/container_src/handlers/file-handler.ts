// File Handler
import { BaseHandler } from './base-handler';
import type { 
  RequestContext, 
  Logger, 
  ReadFileRequest,
  WriteFileRequest,
  DeleteFileRequest,
  RenameFileRequest,
  MoveFileRequest,
  MkdirRequest
} from '../core/types';
import type { FileService } from '../services/file-service';

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

    try {
      switch (pathname) {
        case '/api/read':
          return await this.handleRead(request, context);
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
        default:
          return this.createErrorResponse('Invalid file endpoint', 404, context);
      }
    } catch (error) {
      return this.createErrorResponse(error instanceof Error ? error : 'Unknown error', 500, context);
    }
  }

  private async handleRead(request: Request, context: RequestContext): Promise<Response> {
    try {
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
          sizeBytes: result.data!.length,
        });

        return new Response(
          JSON.stringify({
            success: true,
            content: result.data!,
            path: body.path,
            encoding: body.encoding || 'utf-8',
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

  private async handleWrite(request: Request, context: RequestContext): Promise<Response> {
    try {
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

        return new Response(
          JSON.stringify({
            success: true,
            message: 'File written successfully',
            path: body.path,
            bytesWritten: body.content.length,
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

  private async handleDelete(request: Request, context: RequestContext): Promise<Response> {
    try {
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

        return new Response(
          JSON.stringify({
            success: true,
            message: 'File deleted successfully',
            path: body.path,
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

  private async handleRename(request: Request, context: RequestContext): Promise<Response> {
    try {
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

        return new Response(
          JSON.stringify({
            success: true,
            message: 'File renamed successfully',
            oldPath: body.oldPath,
            newPath: body.newPath,
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

  private async handleMove(request: Request, context: RequestContext): Response {
    try {
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

        return new Response(
          JSON.stringify({
            success: true,
            message: 'File moved successfully',
            sourcePath: body.sourcePath,
            destinationPath: body.destinationPath,
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

  private async handleMkdir(request: Request, context: RequestContext): Promise<Response> {
    try {
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

        return new Response(
          JSON.stringify({
            success: true,
            message: 'Directory created successfully',
            path: body.path,
            recursive: body.recursive,
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
}