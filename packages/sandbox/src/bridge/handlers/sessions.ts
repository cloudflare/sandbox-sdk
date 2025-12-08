import type { Sandbox } from '../../sandbox';

interface CreateSessionRequest {
  options?: {
    cwd?: string;
    env?: Record<string, string>;
  };
}

export async function handleSessions(
  request: Request,
  sandbox: Sandbox,
  pathSegments: string[]
): Promise<Response> {
  const [sessionId] = pathSegments;

  try {
    // POST /sessions - create new session
    if (!sessionId && request.method === 'POST') {
      const body = (await request
        .json()
        .catch(() => ({}))) as CreateSessionRequest;
      const session = await sandbox.createSession(body.options);
      return Response.json({
        sessionId: session.id
      });
    }

    // DELETE /sessions/:id - delete session
    if (sessionId && request.method === 'DELETE') {
      const result = await sandbox.deleteSession(sessionId);
      return Response.json(result);
    }

    return Response.json(
      { error: 'NOT_FOUND', message: 'Unknown sessions endpoint' },
      { status: 404 }
    );
  } catch (error) {
    return Response.json(
      {
        error: 'SESSION_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
