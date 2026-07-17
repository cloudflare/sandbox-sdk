import type { ProcessLogEvent, ProcessOutput } from '@repo/shared';
import { processFailure, streamClosed } from './process-waits';

export async function readProcessOutput(
  reader: ReadableStreamDefaultReader<ProcessLogEvent>,
  options: { maxBytes?: number; processId: string; pid: number }
): Promise<ProcessOutput<Uint8Array>> {
  const maxBytes = validateMaxBytes(options.maxBytes);
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let retainedBytes = 0;
  let truncated = false;

  for (;;) {
    const result = await reader.read();
    if (result.done) streamClosed('Process log stream ended before exit');

    const event = result.value;
    if ('type' in event && event.type === 'truncated') {
      truncated = true;
      continue;
    }
    if ('state' in event) {
      if (event.state === 'error')
        throw processFailure(options.processId, options.pid, event.error);
      return {
        stdout: concat(stdout, stdoutBytes),
        stderr: concat(stderr, stderrBytes),
        exitCode: event.exit.code,
        signal: event.exit.signal,
        timedOut: event.exit.timedOut,
        truncated
      };
    }

    const remaining =
      maxBytes === undefined
        ? event.data.byteLength
        : Math.max(0, maxBytes - retainedBytes);
    const retainedLength = Math.min(remaining, event.data.byteLength);
    if (retainedLength < event.data.byteLength) truncated = true;
    if (retainedLength === 0) continue;

    const chunk =
      retainedLength === event.data.byteLength
        ? event.data
        : event.data.slice(0, retainedLength);
    if (event.type === 'stdout') {
      stdout.push(chunk);
      stdoutBytes += chunk.byteLength;
    } else {
      stderr.push(chunk);
      stderrBytes += chunk.byteLength;
    }
    retainedBytes += chunk.byteLength;
  }
}

export function validateMaxBytes(
  maxBytes: number | undefined
): number | undefined {
  if (maxBytes === undefined) return undefined;
  if (!Number.isFinite(maxBytes) || maxBytes < 0)
    throw new Error('maxBytes must be a non-negative finite number');
  return maxBytes;
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
