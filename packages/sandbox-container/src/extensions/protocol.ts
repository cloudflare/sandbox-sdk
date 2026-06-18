/**
 * Wire protocol for the extension bridge.
 *
 * The host (container server) and a sidecar process exchange length-prefixed
 * JSON frames over a unix domain socket. Each frame is a 4-byte big-endian
 * unsigned length followed by that many bytes of UTF-8 JSON.
 *
 * This mirrors the stdio framing the interpreter process pool already uses,
 * generalised into a reusable request/response/event protocol so any sidecar
 * can speak it.
 */

/** Request sent host -> sidecar to invoke a method. */
export interface RequestFrame {
  t: 'req';
  id: number;
  method: string;
  args: unknown[];
}

/** Successful response sidecar -> host for a request. */
export interface ResponseOkFrame {
  t: 'res';
  id: number;
  ok: true;
  value: unknown;
}

/** Error response sidecar -> host for a request. */
export interface ResponseErrFrame {
  t: 'res';
  id: number;
  ok: false;
  error: { message: string; code?: string };
}

/** Streaming event sidecar -> host, correlated to an in-flight request id. */
export interface EventFrame {
  t: 'evt';
  id: number;
  event: string;
  data: unknown;
}

export type HostFrame = RequestFrame;
export type SidecarFrame = ResponseOkFrame | ResponseErrFrame | EventFrame;
export type Frame = HostFrame | SidecarFrame;

const HEADER_BYTES = 4;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Encode a frame into a length-prefixed buffer ready to write to a socket. */
export function encodeFrame(frame: Frame): Buffer {
  const json = Buffer.from(JSON.stringify(frame), 'utf8');
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Incremental decoder. Feed it raw socket chunks; it yields complete frames as
 * they become available, buffering partial reads across chunk boundaries.
 */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.#buffer =
      this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

    const frames: Frame[] = [];
    while (this.#buffer.length >= HEADER_BYTES) {
      const length = this.#buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new Error(
          `Extension frame exceeds maximum size (${length} > ${MAX_FRAME_BYTES} bytes)`
        );
      }
      if (this.#buffer.length < HEADER_BYTES + length) {
        break;
      }
      const json = this.#buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      // Advance past this frame before parsing so a single malformed frame is
      // skipped (length-prefixing keeps us aligned) rather than wedging the
      // decoder or discarding sibling frames already decoded in this batch.
      this.#buffer = this.#buffer.subarray(HEADER_BYTES + length);
      try {
        const frame = JSON.parse(json.toString('utf8'));
        if (!isFrame(frame)) {
          throw new Error('invalid frame shape');
        }
        frames.push(frame);
      } catch (error) {
        throw new Error(
          `Failed to decode extension frame (${length} bytes): ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        );
      }
    }
    return frames;
  }
}

function isFrame(value: unknown): value is Frame {
  if (!isRecord(value) || !Number.isInteger(value.id)) return false;
  if (value.t === 'req') {
    return typeof value.method === 'string' && Array.isArray(value.args);
  }
  if (value.t === 'evt') {
    return typeof value.event === 'string';
  }
  if (value.t === 'res') {
    if (value.ok === true) return true;
    return (
      value.ok === false &&
      isRecord(value.error) &&
      typeof value.error.message === 'string' &&
      (value.error.code === undefined || typeof value.error.code === 'string')
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
