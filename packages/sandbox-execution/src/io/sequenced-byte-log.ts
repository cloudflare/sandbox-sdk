import { Buffer } from 'node:buffer';
import type { ProcessLogSubscriptionOptions } from '../process/process-log-store';

export interface SequencedByteLogOptions<TTerminal> {
  storeId: string;
  maxBytes: number;
  maxEvents: number;
  copyTerminal?: (value: TTerminal) => TTerminal;
}

export interface SequencedByteEvent<TType extends string> {
  type: TType;
  cursor: string;
  timestamp: string;
  data: Uint8Array;
}

export interface SequencedTerminalEvent<TTerminal> {
  type: 'terminal';
  cursor: string;
  timestamp: string;
  value: TTerminal;
}

export type SequencedTruncatedEvent = {
  type: 'truncated';
  cursor?: string;
  timestamp: string;
};

type SequencedLogEvent<TType extends string, TTerminal> =
  | SequencedByteEvent<TType>
  | SequencedTerminalEvent<TTerminal>;

type SequencedSubscriptionEvent<TType extends string, TTerminal> =
  | SequencedLogEvent<TType, TTerminal>
  | SequencedTruncatedEvent;

interface StoredEvent<TType extends string, TTerminal> {
  readonly sequence: number;
  readonly event: SequencedLogEvent<TType, TTerminal>;
  readonly byteLength: number;
}

interface Subscriber<TType extends string, TTerminal> {
  readonly controller: ReadableStreamDefaultController<
    SequencedSubscriptionEvent<TType, TTerminal>
  >;
  readonly follow: boolean;
  readonly endSequence: number;
  nextSequence: number;
  truncated: boolean;
  closed: boolean;
}

const CURSOR_VERSION = 'v1';
const INVALID_CURSOR = 'Invalid byte log cursor';

export class SequencedByteLog<TType extends string, TTerminal> {
  readonly #storeId: string;
  readonly #maxBytes: number;
  readonly #maxEvents: number;
  readonly #events: StoredEvent<TType, TTerminal>[] = [];
  readonly #subscribers = new Set<Subscriber<TType, TTerminal>>();
  readonly #copyTerminal: (value: TTerminal) => TTerminal;
  #sequence = 0;
  #retainedBytes = 0;
  #evictionBoundary = 1;
  #head = 0;
  #terminal = false;

  constructor(options: SequencedByteLogOptions<TTerminal>) {
    if (options.storeId.length === 0)
      throw new Error('Store ID must not be empty');
    this.#storeId = options.storeId;
    this.#maxBytes = validateLimit(options.maxBytes, 'maxBytes');
    this.#maxEvents = validateLimit(options.maxEvents, 'maxEvents');
    this.#copyTerminal = options.copyTerminal ?? ((value) => value);
  }

  append(
    type: TType,
    data: Uint8Array,
    timestamp = new Date().toISOString()
  ): SequencedByteEvent<TType> {
    this.#ensureOpen();
    const sequence = ++this.#sequence;
    const event: SequencedByteEvent<TType> = {
      type,
      cursor: this.#cursor(sequence),
      timestamp,
      data: data.slice()
    };
    this.#append(sequence, event, event.data.byteLength);
    return copyEvent(event);
  }

  close(
    value: TTerminal,
    timestamp = new Date().toISOString()
  ): SequencedTerminalEvent<TTerminal> {
    this.#ensureOpen();
    const sequence = ++this.#sequence;
    const event: SequencedTerminalEvent<TTerminal> = {
      type: 'terminal',
      cursor: this.#cursor(sequence),
      timestamp,
      value: this.#copyTerminal(value)
    };
    this.#terminal = true;
    this.#append(sequence, event, 0);
    return this.#copyTerminalEvent(event);
  }

  subscribe(
    options: ProcessLogSubscriptionOptions = {}
  ): ReadableStream<SequencedSubscriptionEvent<TType, TTerminal>> {
    const replay = options.replay ?? true;
    const follow = options.follow ?? false;
    const afterSequence = options.after
      ? this.#parseCursor(options.after)
      : undefined;
    const startSequence = replay
      ? (afterSequence ?? 0) + 1
      : this.#sequence + 1;
    let subscriber: Subscriber<TType, TTerminal> | undefined;

    return new ReadableStream<SequencedSubscriptionEvent<TType, TTerminal>>({
      start: (controller) => {
        subscriber = {
          controller,
          follow: follow && !this.#terminal,
          endSequence:
            follow && !this.#terminal
              ? Number.POSITIVE_INFINITY
              : this.#sequence,
          nextSequence: startSequence,
          truncated: false,
          closed: false
        };
        this.#subscribers.add(subscriber);
        this.#pump(subscriber);
      },
      pull: () => {
        if (subscriber) this.#pump(subscriber);
      },
      cancel: () => {
        if (subscriber) {
          subscriber.closed = true;
          this.#subscribers.delete(subscriber);
        }
      }
    });
  }

  #append(
    sequence: number,
    event: SequencedLogEvent<TType, TTerminal>,
    byteLength: number
  ): void {
    this.#events.push({ sequence, event, byteLength });
    this.#retainedBytes += byteLength;
    while (
      this.#retainedLength() > this.#maxEvents ||
      this.#retainedBytes > this.#maxBytes
    ) {
      const removed = this.#events[this.#head];
      if (!removed) break;
      this.#head += 1;
      this.#retainedBytes -= removed.byteLength;
      this.#evictionBoundary = removed.sequence + 1;
    }
    this.#compactIfNeeded();
    for (const subscriber of this.#subscribers) this.#pump(subscriber);
  }

  #pump(subscriber: Subscriber<TType, TTerminal>): void {
    if (subscriber.closed || !this.#subscribers.has(subscriber)) return;
    if (subscriber.nextSequence < this.#evictionBoundary) {
      subscriber.nextSequence = this.#evictionBoundary;
      subscriber.truncated = true;
    }
    if (
      subscriber.controller.desiredSize === null ||
      subscriber.controller.desiredSize <= 0
    )
      return;
    if (subscriber.truncated) {
      subscriber.truncated = false;
      subscriber.controller.enqueue({
        type: 'truncated',
        timestamp: new Date().toISOString()
      });
      return;
    }
    const retainedIndex =
      this.#head + subscriber.nextSequence - this.#evictionBoundary;
    const stored = this.#events[retainedIndex];
    if (stored && stored.sequence <= subscriber.endSequence) {
      subscriber.nextSequence = stored.sequence + 1;
      subscriber.controller.enqueue(this.#copyStoredEvent(stored.event));
      if (stored.event.type === 'terminal') {
        this.#close(subscriber);
        return;
      }
      this.#pump(subscriber);
      return;
    }
    if (
      !subscriber.follow ||
      this.#terminal ||
      subscriber.nextSequence > subscriber.endSequence
    )
      this.#close(subscriber);
  }

  #retainedLength(): number {
    return this.#events.length - this.#head;
  }

  #compactIfNeeded(): void {
    if (this.#head < 1024 || this.#head * 2 < this.#events.length) return;
    this.#events.splice(0, this.#head);
    this.#head = 0;
  }

  #copyTerminalEvent(
    event: SequencedTerminalEvent<TTerminal>
  ): SequencedTerminalEvent<TTerminal> {
    return { ...event, value: this.#copyTerminal(event.value) };
  }

  #copyStoredEvent(
    event: SequencedLogEvent<TType, TTerminal>
  ): SequencedLogEvent<TType, TTerminal> {
    if ('data' in event) return copyEvent(event);
    return this.#copyTerminalEvent(event);
  }

  #close(subscriber: Subscriber<TType, TTerminal>): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    this.#subscribers.delete(subscriber);
    subscriber.controller.close();
  }

  #cursor(sequence: number): string {
    const encodedStoreId = Buffer.from(this.#storeId).toString('base64url');
    return Buffer.from(
      `${CURSOR_VERSION}.${encodedStoreId}.${sequence}`
    ).toString('base64url');
  }

  #parseCursor(cursor: string): number {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error(INVALID_CURSOR);
    const decoded = Buffer.from(cursor, 'base64url').toString();
    if (Buffer.from(decoded).toString('base64url') !== cursor)
      throw new Error(INVALID_CURSOR);
    const parts = decoded.split('.');
    if (parts.length !== 3 || parts[0] !== CURSOR_VERSION)
      throw new Error(INVALID_CURSOR);
    const encodedStoreId = parts[1] ?? '';
    const storeId = Buffer.from(encodedStoreId, 'base64url').toString();
    if (Buffer.from(storeId).toString('base64url') !== encodedStoreId)
      throw new Error(INVALID_CURSOR);
    if (storeId !== this.#storeId)
      throw new Error('Byte log cursor belongs to another run or store');
    const sequenceText = parts[2] ?? '';
    const sequence = Number(sequenceText);
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      String(sequence) !== sequenceText
    )
      throw new Error(INVALID_CURSOR);
    if (sequence > this.#sequence)
      throw new Error('Byte log cursor is from the future');
    return sequence;
  }

  #ensureOpen(): void {
    if (this.#terminal) throw new Error('Byte log is already terminal');
  }
}

function validateLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function copyEvent<TType extends string>(
  event: SequencedByteEvent<TType>
): SequencedByteEvent<TType> {
  return { ...event, data: event.data.slice() };
}
