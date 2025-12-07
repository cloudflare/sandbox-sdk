import type { Sandbox } from '../../sandbox';

export async function handleCode(
  _request: Request,
  _sandbox: Sandbox,
  _pathSegments: string[]
): Promise<Response> {
  return Response.json(
    { error: 'NOT_IMPLEMENTED', message: 'Code handler not implemented yet' },
    { status: 501 }
  );
}
