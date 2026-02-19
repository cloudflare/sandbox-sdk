/**
 * Shared SSE parsing utilities.
 *
 * Parses SSE frames from arbitrary text chunks while preserving partial state
 * across chunk boundaries.
 */

export interface SSEEventFrame {
  event?: string;
  data: string;
}

export interface SSEPartialEvent {
  event?: string;
  data: string[];
}

/**
 * Parse SSE frames from a buffer.
 *
 * Returns parsed events, remaining unparsed text, and the current partial event
 * so callers can continue parsing on the next chunk.
 */
export function parseSSEFrames(
  buffer: string,
  currentEvent: SSEPartialEvent = { data: [] }
): {
  events: SSEEventFrame[];
  remaining: string;
  currentEvent: SSEPartialEvent;
} {
  const events: SSEEventFrame[] = [];
  let i = 0;

  while (i < buffer.length) {
    const newlineIndex = buffer.indexOf('\n', i);
    if (newlineIndex === -1) break;

    const rawLine = buffer.substring(i, newlineIndex);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    i = newlineIndex + 1;

    if (line === '' && currentEvent.data.length > 0) {
      events.push({
        event: currentEvent.event,
        data: currentEvent.data.join('\n')
      });
      currentEvent = { data: [] };
      continue;
    }

    if (line.startsWith('event:')) {
      const value = line.startsWith('event: ')
        ? line.substring(7)
        : line.substring(6);
      currentEvent.event = value;
      continue;
    }

    if (line.startsWith('data:')) {
      const value = line.startsWith('data: ')
        ? line.substring(6)
        : line.substring(5);
      currentEvent.data.push(value);
    }
  }

  return {
    events,
    remaining: buffer.substring(i),
    currentEvent
  };
}
