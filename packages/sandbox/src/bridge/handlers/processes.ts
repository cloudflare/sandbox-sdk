import type { Sandbox } from '../../sandbox';

export async function handleProcesses(
  _request: Request,
  _sandbox: Sandbox,
  _pathSegments: string[]
): Promise<Response> {
  return Response.json(
    {
      error: 'NOT_IMPLEMENTED',
      message: 'Processes handler not implemented yet'
    },
    { status: 501 }
  );
}
