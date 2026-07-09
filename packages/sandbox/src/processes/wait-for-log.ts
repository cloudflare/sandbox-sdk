import type { ProcessLogEvent, WaitForLogResult } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import { ProcessExitedBeforeLogError } from '../errors';
import { processFailure, streamClosed } from './process-waits';

const MATCH_WINDOW = 64 * 1024;

type WantedStream = 'stdout' | 'stderr' | 'both';
type LogStream = 'stdout' | 'stderr';

export async function readUntilLogMatch(
  reader: ReadableStreamDefaultReader<ProcessLogEvent>,
  pattern: string | RegExp,
  wanted: WantedStream,
  processId: string,
  pid: number
): Promise<WaitForLogResult> {
  const decoders = {
    stdout: new TextDecoder(),
    stderr: new TextDecoder()
  };
  const windows = { stdout: '', stderr: '' };
  const cursors = { stdout: '', stderr: '' };

  const append = (
    stream: LogStream,
    decoded: string,
    cursor: string
  ): WaitForLogResult | undefined => {
    const text = bounded(windows[stream] + decoded);
    windows[stream] = text;
    cursors[stream] = cursor;
    const match = findMatch(text, pattern);
    return match === undefined ? undefined : { stream, text, match, cursor };
  };
  const flush = (cursor: string): WaitForLogResult | undefined => {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (wanted !== 'both' && wanted !== stream) continue;
      const result = append(
        stream,
        decoders[stream].decode(),
        cursors[stream] || cursor
      );
      if (result !== undefined) return result;
    }
    return undefined;
  };

  for (;;) {
    const result = await reader.read();
    if (result.done) {
      const match = flush('');
      if (match !== undefined) return match;
      streamClosed('Process log stream ended before a match was found');
    }
    const event = result.value;
    if ('state' in event) {
      const match = flush(event.cursor);
      if (match !== undefined) return match;
      if (event.state === 'error')
        throw processFailure(processId, pid, event.error);
      throw new ProcessExitedBeforeLogError({
        code: ErrorCode.PROCESS_EXITED_BEFORE_LOG,
        message: 'Process exited before a log match was found',
        context: { processId, pid, exit: { ...event.exit } },
        httpStatus: 409,
        timestamp: new Date().toISOString()
      });
    }
    if (event.type !== 'stdout' && event.type !== 'stderr') continue;
    if (wanted !== 'both' && wanted !== event.type) continue;

    const match = append(
      event.type,
      decoders[event.type].decode(event.data, { stream: true }),
      event.cursor
    );
    if (match !== undefined) return match;
  }
}

function bounded(text: string): string {
  return text.length <= MATCH_WINDOW ? text : text.slice(-MATCH_WINDOW);
}

function findMatch(text: string, pattern: string | RegExp): string | undefined {
  if (typeof pattern === 'string')
    return text.includes(pattern) ? pattern : undefined;
  pattern.lastIndex = 0;
  const match = pattern.exec(text)?.[0];
  pattern.lastIndex = 0;
  return match;
}
