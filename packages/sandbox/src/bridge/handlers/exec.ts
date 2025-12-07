import type { ExecResult } from '@repo/shared';
import type { Sandbox } from '../../sandbox';

interface ExecRequest {
  command: string;
  options?: {
    timeout?: number;
    cwd?: string;
    env?: Record<string, string>;
  };
  sessionId?: string;
}

export async function handleExec(
  request: Request,
  sandbox: Sandbox
): Promise<Response> {
  let body: ExecRequest;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: 'INVALID_REQUEST', message: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  if (!body.command || typeof body.command !== 'string') {
    return Response.json(
      {
        error: 'INVALID_REQUEST',
        message: 'command is required and must be a string'
      },
      { status: 400 }
    );
  }

  try {
    let result: ExecResult;

    if (body.sessionId) {
      const session = await sandbox.getSession(body.sessionId);
      result = await session.exec(body.command, body.options);
    } else {
      result = await sandbox.exec(body.command, body.options);
    }

    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error: 'EXECUTION_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

export async function handleExecStream(
  request: Request,
  sandbox: Sandbox
): Promise<Response> {
  let body: ExecRequest;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: 'INVALID_REQUEST', message: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  if (!body.command || typeof body.command !== 'string') {
    return Response.json(
      { error: 'INVALID_REQUEST', message: 'command is required' },
      { status: 400 }
    );
  }

  try {
    let stream: ReadableStream<Uint8Array>;

    if (body.sessionId) {
      const session = await sandbox.getSession(body.sessionId);
      stream = await session.execStream(body.command, body.options);
    } else {
      stream = await sandbox.execStream(body.command, body.options);
    }

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      }
    });
  } catch (error) {
    return Response.json(
      {
        error: 'EXECUTION_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
