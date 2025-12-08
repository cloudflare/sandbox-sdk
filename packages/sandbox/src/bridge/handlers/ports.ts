import type { Sandbox } from '../../sandbox';

interface ExposePortRequest {
  port: number;
  name?: string;
  hostname: string;
}

interface UnexposePortRequest {
  port: number;
}

export async function handlePorts(
  request: Request,
  sandbox: Sandbox,
  pathSegments: string[]
): Promise<Response> {
  const [action] = pathSegments;
  const url = new URL(request.url);

  try {
    switch (action) {
      case 'expose': {
        if (request.method !== 'POST') {
          return Response.json(
            { error: 'METHOD_NOT_ALLOWED', message: 'POST required' },
            { status: 405 }
          );
        }
        const body: ExposePortRequest = await request.json();
        if (!body.port || !body.hostname) {
          return Response.json(
            {
              error: 'INVALID_REQUEST',
              message: 'port and hostname are required'
            },
            { status: 400 }
          );
        }
        const result = await sandbox.exposePort(body.port, {
          name: body.name,
          hostname: body.hostname
        });
        return Response.json(result);
      }

      case 'unexpose': {
        if (request.method !== 'POST') {
          return Response.json(
            { error: 'METHOD_NOT_ALLOWED', message: 'POST required' },
            { status: 405 }
          );
        }
        const body: UnexposePortRequest = await request.json();
        if (!body.port) {
          return Response.json(
            { error: 'INVALID_REQUEST', message: 'port is required' },
            { status: 400 }
          );
        }
        await sandbox.unexposePort(body.port);
        return Response.json({ success: true });
      }

      case 'list': {
        if (request.method !== 'GET') {
          return Response.json(
            { error: 'METHOD_NOT_ALLOWED', message: 'GET required' },
            { status: 405 }
          );
        }
        const hostname = url.searchParams.get('hostname');
        if (!hostname) {
          return Response.json(
            {
              error: 'INVALID_REQUEST',
              message: 'hostname query param is required'
            },
            { status: 400 }
          );
        }
        const result = await sandbox.getExposedPorts(hostname);
        return Response.json(result);
      }

      default:
        return Response.json(
          { error: 'NOT_FOUND', message: `Unknown ports action: ${action}` },
          { status: 404 }
        );
    }
  } catch (error) {
    return Response.json(
      {
        error: 'PORT_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
