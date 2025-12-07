import type { Sandbox } from '../../sandbox';

export async function handleSessions(
  _request: Request,
  _sandbox: Sandbox,
  _pathSegments: string[]
): Promise<Response> {
  return Response.json(
    {
      error: 'NOT_IMPLEMENTED',
      message: 'Sessions handler not implemented yet'
    },
    { status: 501 }
  );
}
