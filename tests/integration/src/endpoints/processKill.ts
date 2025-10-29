import type { Sandbox } from '@cloudflare/sandbox';
import { errorResponse, jsonResponse } from '../http';

export async function killProcesses(
  sandbox: Sandbox<unknown>,
  pathname: string
) {
  const processId = pathname.split('/').pop();
  if (processId === 'kill-all') {
    if (typeof sandbox.killAllProcesses === 'function') {
      const result = await sandbox.killAllProcesses();
      return jsonResponse({
        message: 'All processes killed',
        killedCount: result
      });
    } else {
      return errorResponse(
        'Process management not implemented in current SDK version',
        501
      );
    }
  } else if (processId) {
    if (typeof sandbox.killProcess === 'function') {
      await sandbox.killProcess(processId);
      return jsonResponse({ message: 'Process killed', processId });
    } else {
      return errorResponse(
        'Process management not implemented in current SDK version',
        501
      );
    }
  } else {
    return errorResponse('Process ID is required');
  }
}
