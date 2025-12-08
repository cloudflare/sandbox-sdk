import type { CreateContextOptions, RunCodeOptions } from '@repo/shared';
import type { Sandbox } from '../../sandbox';

interface RunCodeRequest {
  code: string;
  options?: RunCodeOptions;
}

interface CreateContextRequest {
  options?: CreateContextOptions;
}

export async function handleCode(
  request: Request,
  sandbox: Sandbox,
  pathSegments: string[]
): Promise<Response> {
  const [action, subAction] = pathSegments;

  try {
    switch (action) {
      case 'run': {
        if (request.method !== 'POST') {
          return Response.json(
            { error: 'METHOD_NOT_ALLOWED', message: 'POST required' },
            { status: 405 }
          );
        }

        const body = (await request.json()) as RunCodeRequest;
        if (!body.code) {
          return Response.json(
            { error: 'INVALID_REQUEST', message: 'code is required' },
            { status: 400 }
          );
        }

        if (subAction === 'stream') {
          const stream = await sandbox.runCodeStream(body.code, body.options);
          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive'
            }
          });
        }

        const result = await sandbox.runCode(body.code, body.options);
        return Response.json(result);
      }

      case 'contexts': {
        // POST /code/contexts - create context
        if (request.method === 'POST' && !subAction) {
          const body = (await request
            .json()
            .catch(() => ({}))) as CreateContextRequest;
          const context = await sandbox.createCodeContext(body.options);
          return Response.json(context);
        }

        // GET /code/contexts - list contexts
        if (request.method === 'GET' && !subAction) {
          const contexts = await sandbox.listCodeContexts();
          return Response.json({ contexts });
        }

        // DELETE /code/contexts/:id - delete context
        if (request.method === 'DELETE' && subAction) {
          await sandbox.deleteCodeContext(subAction);
          return Response.json({ success: true });
        }

        return Response.json(
          {
            error: 'METHOD_NOT_ALLOWED',
            message: 'Invalid method for contexts'
          },
          { status: 405 }
        );
      }

      default:
        return Response.json(
          { error: 'NOT_FOUND', message: `Unknown code action: ${action}` },
          { status: 404 }
        );
    }
  } catch (error) {
    return Response.json(
      {
        error: 'CODE_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
