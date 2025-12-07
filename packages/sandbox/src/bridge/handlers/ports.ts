import type { Sandbox } from '../../sandbox';

export async function handlePorts(
  _request: Request,
  _sandbox: Sandbox,
  _pathSegments: string[]
): Promise<Response> {
  return Response.json(
    { error: 'NOT_IMPLEMENTED', message: 'Ports handler not implemented yet' },
    { status: 501 }
  );
}
