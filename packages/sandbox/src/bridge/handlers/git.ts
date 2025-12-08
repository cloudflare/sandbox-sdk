import type { Sandbox } from '../../sandbox';

interface GitCheckoutRequest {
  repoUrl: string;
  options?: {
    branch?: string;
    targetDir?: string;
    sessionId?: string;
  };
}

export async function handleGit(
  request: Request,
  sandbox: Sandbox,
  pathSegments: string[]
): Promise<Response> {
  const [action] = pathSegments;

  try {
    switch (action) {
      case 'checkout': {
        if (request.method !== 'POST') {
          return Response.json(
            { error: 'METHOD_NOT_ALLOWED', message: 'POST required' },
            { status: 405 }
          );
        }
        const body: GitCheckoutRequest = await request.json();
        if (!body.repoUrl) {
          return Response.json(
            { error: 'INVALID_REQUEST', message: 'repoUrl is required' },
            { status: 400 }
          );
        }
        const result = await sandbox.gitCheckout(
          body.repoUrl,
          body.options ?? {}
        );
        return Response.json(result);
      }

      default:
        return Response.json(
          { error: 'NOT_FOUND', message: `Unknown git action: ${action}` },
          { status: 404 }
        );
    }
  } catch (error) {
    return Response.json(
      {
        error: 'GIT_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
