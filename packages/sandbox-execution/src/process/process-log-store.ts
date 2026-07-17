import { SequencedByteLog } from '../io/sequenced-byte-log';
import type {
  RuntimeErroredProcess,
  RuntimeExitedProcess,
  RuntimeProcessLogEvent
} from './types';

export interface ProcessLogStoreOptions {
  maxBytes?: number;
  maxEvents?: number;
}

export interface ProcessLogSubscriptionOptions {
  after?: string;
  replay?: boolean;
  follow?: boolean;
}

export type TerminalLogDetails =
  | Pick<RuntimeExitedProcess, 'state' | 'exit'>
  | Pick<RuntimeErroredProcess, 'state' | 'error'>;

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_EVENTS = 10_000;

type OutputEvent = Extract<
  RuntimeProcessLogEvent,
  { type: 'stdout' | 'stderr' }
>;
type TerminalEvent = Extract<RuntimeProcessLogEvent, { state: string }>;

export class ProcessLogStore {
  readonly #log: SequencedByteLog<'stdout' | 'stderr', TerminalLogDetails>;

  constructor(runId: string, options: ProcessLogStoreOptions = {}) {
    if (runId.length === 0) throw new Error('Run ID must not be empty');
    this.#log = new SequencedByteLog({
      storeId: runId,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      maxEvents: options.maxEvents ?? DEFAULT_MAX_EVENTS,
      copyTerminal: copyTerminalDetails
    });
  }

  appendOutput(
    type: 'stdout' | 'stderr',
    data: Uint8Array,
    timestamp = new Date().toISOString()
  ): OutputEvent {
    return this.#log.append(type, data, timestamp);
  }

  appendTerminal(
    terminal: TerminalLogDetails,
    timestamp = new Date().toISOString()
  ): TerminalEvent {
    const event = this.#log.close(copyTerminalDetails(terminal), timestamp);
    return terminalEvent(event);
  }

  subscribe(
    options: ProcessLogSubscriptionOptions = {}
  ): ReadableStream<RuntimeProcessLogEvent> {
    return this.#log.subscribe(options).pipeThrough(
      new TransformStream({
        transform(event, controller) {
          if (event.type === 'terminal') {
            controller.enqueue(terminalEvent(event));
            return;
          }
          controller.enqueue(event);
        }
      })
    );
  }
}

function copyTerminalDetails(terminal: TerminalLogDetails): TerminalLogDetails {
  if (terminal.state === 'exited') {
    return {
      state: 'exited',
      exit: { ...terminal.exit }
    };
  }
  return {
    state: 'error',
    error: { ...terminal.error }
  };
}

function terminalEvent(event: {
  cursor: string;
  timestamp: string;
  value: TerminalLogDetails;
}): TerminalEvent {
  return {
    type: 'terminal',
    cursor: event.cursor,
    timestamp: event.timestamp,
    ...copyTerminalDetails(event.value)
  };
}
