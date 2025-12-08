import type { Sandbox } from '../../sandbox';

interface StartProcessRequest {
  command: string;
  options?: {
    cwd?: string;
    env?: Record<string, string>;
  };
}

interface KillProcessRequest {
  signal?: string;
}

export async function handleProcesses(
  request: Request,
  sandbox: Sandbox,
  pathSegments: string[]
): Promise<Response> {
  const [action, processId, subAction] = pathSegments;

  try {
    // GET /processes - list all processes
    if (!action && request.method === 'GET') {
      const processes = await sandbox.listProcesses();
      return Response.json({ processes });
    }

    // POST /processes/start - start new process
    if (action === 'start' && request.method === 'POST') {
      const body: StartProcessRequest = await request.json();
      if (!body.command) {
        return Response.json(
          { error: 'INVALID_REQUEST', message: 'command is required' },
          { status: 400 }
        );
      }
      const process = await sandbox.startProcess(body.command, body.options);
      return Response.json(process);
    }

    // Routes with process ID
    if (action && action !== 'start') {
      const id = action;

      // GET /processes/:id - get process info
      if (!processId && request.method === 'GET') {
        const process = await sandbox.getProcess(id);
        if (!process) {
          return Response.json(
            { error: 'NOT_FOUND', message: `Process ${id} not found` },
            { status: 404 }
          );
        }
        return Response.json(process);
      }

      // DELETE /processes/:id - kill process
      if (!processId && request.method === 'DELETE') {
        const body: KillProcessRequest = request.body
          ? await request.json()
          : {};
        await sandbox.killProcess(id, body.signal);
        return Response.json({ success: true });
      }

      // GET /processes/:id/logs - get process logs
      if (processId === 'logs' && request.method === 'GET') {
        const logs = await sandbox.getProcessLogs(id);
        return Response.json(logs);
      }

      // GET /processes/:id/logs/stream - stream process logs
      if (
        processId === 'logs' &&
        subAction === 'stream' &&
        request.method === 'GET'
      ) {
        const stream = await sandbox.streamProcessLogs(id);
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          }
        });
      }
    }

    return Response.json(
      { error: 'NOT_FOUND', message: 'Unknown processes endpoint' },
      { status: 404 }
    );
  } catch (error) {
    return Response.json(
      {
        error: 'PROCESS_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
