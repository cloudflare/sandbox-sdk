import type { Sandbox } from '@cloudflare/sandbox';
import { errorResponse, jsonResponse } from '../http';

export async function getProcess(sandbox: Sandbox<unknown>, pathname: string) {
  const processId = pathname.split('/').pop();
  if (!processId) {
    return errorResponse('Process ID is required');
  }

  if (typeof sandbox.getProcess === 'function') {
    const process = await sandbox.getProcess(processId);
    if (!process) {
      return errorResponse('Process not found', 404);
    }
    return jsonResponse(process);
  } else {
    return errorResponse(
      'Process management not implemented in current SDK version',
      501
    );
  }
}
