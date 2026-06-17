import type { Process } from '@repo/shared';
import { parseSSEStream } from '../../../packages/sandbox/src/sse-parser';

export interface ProcessStreamEvent {
  type: 'stdout' | 'stderr' | 'exit' | 'error';
  timestamp?: string;
  data?: string;
  processId?: string;
  sessionId?: string;
  exitCode?: number;
  error?: string;
}

export async function startProcessViaTestWorker(
  workerUrl: string,
  headers: Record<string, string>,
  command: string,
  options: {
    processId?: string;
    env?: Record<string, string | undefined>;
    cwd?: string;
    timeout?: number;
  } = {}
): Promise<Process> {
  const response = await fetch(`${workerUrl}/api/process/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ command, ...options })
  });

  if (!response.ok) {
    throw new Error(`Failed to start process: ${response.status}`);
  }

  return (await response.json()) as Process;
}

export async function streamProcessViaTestWorker(
  workerUrl: string,
  headers: Record<string, string>,
  processId: string
): Promise<Response> {
  return fetch(`${workerUrl}/api/process/${processId}/stream`, {
    method: 'GET',
    headers
  });
}

export async function collectProcessStreamEvents(
  response: Response,
  maxEvents = 50
): Promise<ProcessStreamEvent[]> {
  if (!response.body) {
    throw new Error('No readable stream in response');
  }

  const events: ProcessStreamEvent[] = [];
  const abortController = new AbortController();

  try {
    for await (const event of parseSSEStream<ProcessStreamEvent>(
      response.body,
      abortController.signal
    )) {
      events.push(event);
      if (event.type === 'exit' || event.type === 'error') {
        abortController.abort();
        break;
      }
      if (events.length >= maxEvents) {
        abortController.abort();
        break;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message !== 'Operation was aborted') {
      throw error;
    }
  }

  return events;
}

export function collectProcessStdout(events: ProcessStreamEvent[]): string {
  return events
    .filter((event) => event.type === 'stdout')
    .map((event) => event.data ?? '')
    .join('');
}

export function collectProcessStderr(events: ProcessStreamEvent[]): string {
  return events
    .filter((event) => event.type === 'stderr')
    .map((event) => event.data ?? '')
    .join('');
}
