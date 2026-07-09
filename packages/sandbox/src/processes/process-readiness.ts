import type { PortWatchEvent, ProcessLogEvent } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import { ProcessExitedBeforeReadyError } from '../errors';
import { processFailure, streamClosed } from './process-waits';

export async function waitForReadiness(
  portReader: ReadableStreamDefaultReader<PortWatchEvent>,
  logReader: ReadableStreamDefaultReader<ProcessLogEvent>,
  context: { processId: string; pid: number; port: number }
): Promise<void> {
  await Promise.race([
    consumePort(portReader),
    consumeTerminal(logReader, context)
  ]);
}

async function consumePort(
  reader: ReadableStreamDefaultReader<PortWatchEvent>
): Promise<void> {
  for (;;) {
    const result = await reader.read();
    if (result.done) streamClosed('Port watch stream ended unexpectedly');
    if (result.value.type === 'ready') return;
    if (result.value.type === 'error')
      throw new Error(result.value.error || 'Port watch failed');
  }
}

async function consumeTerminal(
  reader: ReadableStreamDefaultReader<ProcessLogEvent>,
  context: { processId: string; pid: number; port: number }
): Promise<never> {
  for (;;) {
    const result = await reader.read();
    if (result.done) streamClosed('Process log stream ended before exit');
    const event = result.value;
    if (!('state' in event)) continue;
    if (event.state === 'error')
      throw processFailure(context.processId, context.pid, event.error);
    throw exitedBeforeReady(context.processId, context.port, event.exit.code);
  }
}

function exitedBeforeReady(
  processId: string,
  port: number,
  exitCode: number
): ProcessExitedBeforeReadyError {
  return new ProcessExitedBeforeReadyError({
    code: ErrorCode.PROCESS_EXITED_BEFORE_READY,
    message: `Process exited with code ${exitCode} before becoming ready. Waiting for: port ${port}`,
    context: {
      processId,
      command: processId,
      condition: `port ${port}`,
      exitCode
    },
    httpStatus: 500,
    timestamp: new Date().toISOString()
  });
}
