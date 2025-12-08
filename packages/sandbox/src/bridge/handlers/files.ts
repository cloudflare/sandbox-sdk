import type { Sandbox } from '../../sandbox';

interface WriteFileRequest {
  path: string;
  content: string;
  options?: { encoding?: string };
}

interface PathRequest {
  path: string;
}

interface MkdirRequest {
  path: string;
  options?: { recursive?: boolean };
}

interface RenameRequest {
  oldPath: string;
  newPath: string;
}

interface MoveRequest {
  sourcePath: string;
  destinationPath: string;
}

export async function handleFiles(
  request: Request,
  sandbox: Sandbox,
  pathSegments: string[]
): Promise<Response> {
  const [action, ...rest] = pathSegments;
  const url = new URL(request.url);

  try {
    switch (action) {
      case 'write': {
        const body: WriteFileRequest = await request.json();
        if (!body.path || body.content === undefined) {
          return Response.json(
            {
              error: 'INVALID_REQUEST',
              message: 'path and content are required'
            },
            { status: 400 }
          );
        }
        const result = await sandbox.writeFile(
          body.path,
          body.content,
          body.options
        );
        return Response.json(result);
      }

      case 'read': {
        if (rest[0] === 'stream') {
          const path = url.searchParams.get('path');
          if (!path) {
            return Response.json(
              {
                error: 'INVALID_REQUEST',
                message: 'path query param is required'
              },
              { status: 400 }
            );
          }
          const stream = await sandbox.readFileStream(path);
          return new Response(stream, {
            headers: { 'Content-Type': 'application/octet-stream' }
          });
        }

        const path = url.searchParams.get('path');
        const encoding = url.searchParams.get('encoding') || undefined;
        if (!path) {
          return Response.json(
            {
              error: 'INVALID_REQUEST',
              message: 'path query param is required'
            },
            { status: 400 }
          );
        }
        const result = await sandbox.readFile(
          path,
          encoding ? { encoding } : undefined
        );
        return Response.json(result);
      }

      case 'mkdir': {
        const body: MkdirRequest = await request.json();
        if (!body.path) {
          return Response.json(
            { error: 'INVALID_REQUEST', message: 'path is required' },
            { status: 400 }
          );
        }
        const result = await sandbox.mkdir(body.path, body.options);
        return Response.json(result);
      }

      case 'delete': {
        const body: PathRequest = await request.json();
        if (!body.path) {
          return Response.json(
            { error: 'INVALID_REQUEST', message: 'path is required' },
            { status: 400 }
          );
        }
        const result = await sandbox.deleteFile(body.path);
        return Response.json(result);
      }

      case 'rename': {
        const body: RenameRequest = await request.json();
        if (!body.oldPath || !body.newPath) {
          return Response.json(
            {
              error: 'INVALID_REQUEST',
              message: 'oldPath and newPath are required'
            },
            { status: 400 }
          );
        }
        const result = await sandbox.renameFile(body.oldPath, body.newPath);
        return Response.json(result);
      }

      case 'move': {
        const body: MoveRequest = await request.json();
        if (!body.sourcePath || !body.destinationPath) {
          return Response.json(
            {
              error: 'INVALID_REQUEST',
              message: 'sourcePath and destinationPath are required'
            },
            { status: 400 }
          );
        }
        const result = await sandbox.moveFile(
          body.sourcePath,
          body.destinationPath
        );
        return Response.json(result);
      }

      case 'list': {
        const path = url.searchParams.get('path');
        if (!path) {
          return Response.json(
            {
              error: 'INVALID_REQUEST',
              message: 'path query param is required'
            },
            { status: 400 }
          );
        }
        const recursive = url.searchParams.get('recursive') === 'true';
        const result = await sandbox.listFiles(
          path,
          recursive ? { recursive } : undefined
        );
        return Response.json(result);
      }

      case 'exists': {
        const path = url.searchParams.get('path');
        if (!path) {
          return Response.json(
            {
              error: 'INVALID_REQUEST',
              message: 'path query param is required'
            },
            { status: 400 }
          );
        }
        const result = await sandbox.exists(path);
        return Response.json(result);
      }

      default:
        return Response.json(
          { error: 'NOT_FOUND', message: `Unknown files action: ${action}` },
          { status: 404 }
        );
    }
  } catch (error) {
    return Response.json(
      {
        error: 'FILE_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
