import type { Sandbox } from '../../sandbox';
import type { ParsedRoute } from '../router';
import { handleCode } from './code';
import { handleExec, handleExecStream } from './exec';
import { handleFiles } from './files';
import { handleGit } from './git';
import { handlePorts } from './ports';
import { handleProcesses } from './processes';
import { handleSessions } from './sessions';

export async function dispatchHandler(
  request: Request,
  sandbox: Sandbox,
  route: ParsedRoute
): Promise<Response> {
  const [resource, ...rest] = route.segments;

  switch (resource) {
    case 'exec':
      if (rest[0] === 'stream') {
        return handleExecStream(request, sandbox);
      }
      return handleExec(request, sandbox);

    case 'files':
      return handleFiles(request, sandbox, rest);

    case 'processes':
      return handleProcesses(request, sandbox, rest);

    case 'ports':
      return handlePorts(request, sandbox, rest);

    case 'git':
      return handleGit(request, sandbox, rest);

    case 'code':
      return handleCode(request, sandbox, rest);

    case 'sessions':
      return handleSessions(request, sandbox, rest);

    default:
      return Response.json(
        { error: 'NOT_FOUND', message: `Unknown resource: ${resource}` },
        { status: 404 }
      );
  }
}
