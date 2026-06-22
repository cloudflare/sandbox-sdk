import type { Socket } from 'node:net';
import type { RpcTransport } from 'capnweb';

const HEADER_BYTES = 4;
/** Defensive upper bound on a single capnweb message. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * capnweb `RpcTransport` implemented on top of a unix-domain socket.
 *
 * capnweb's wire format is strictly UTF-8 JSON strings (see
 * `DeferredTransport` in `packages/sandbox/src/container-control/connection.ts`
 * for the WebSocket sibling). Sockets are byte streams, so we length-prefix
 * each message with a 4-byte big-endian unsigned integer. capnweb itself
 * sees the same `send(string)` / `receive(): Promise<string>` interface it
 * uses for every other transport.
 *
 * Lifetimes:
 * - One transport per socket per capnweb session.
 * - On socket close/error, in-flight `receive()` callers reject and any
 *   subsequent receive throws the cached error. capnweb tears the session
 *   down from there.
 */
export class SocketTransport implements RpcTransport {
  readonly #socket: Socket;
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  readonly #queue: string[] = [];
  readonly #waiters: Array<{
    resolve: (msg: string) => void;
    reject: (err: Error) => void;
  }> = [];
  #error: Error | null = null;

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    socket.on('error', (err) => this.#fail(err));
    socket.on('close', () => this.#fail(new Error('Extension socket closed')));
  }

  async send(message: string): Promise<void> {
    if (this.#error) throw this.#error;
    const body = Buffer.from(message, 'utf8');
    if (body.length > MAX_FRAME_BYTES) {
      throw new Error(
        `Extension capnweb message exceeds maximum size (${body.length} > ${MAX_FRAME_BYTES} bytes)`
      );
    }
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header.writeUInt32BE(body.length, 0);
    this.#socket.write(Buffer.concat([header, body]));
  }

  receive(): Promise<string> {
    if (this.#queue.length > 0) {
      return Promise.resolve(this.#queue.shift()!);
    }
    if (this.#error) return Promise.reject(this.#error);
    return new Promise<string>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  abort(reason: unknown): void {
    this.#fail(reason instanceof Error ? reason : new Error(String(reason)));
    this.#socket.destroy();
  }

  #onData(chunk: Buffer): void {
    this.#buffer =
      this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= HEADER_BYTES) {
      const length = this.#buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        this.#fail(
          new Error(
            `Extension capnweb message exceeds maximum size (${length} > ${MAX_FRAME_BYTES} bytes)`
          )
        );
        return;
      }
      if (this.#buffer.length < HEADER_BYTES + length) break;
      const message = this.#buffer
        .subarray(HEADER_BYTES, HEADER_BYTES + length)
        .toString('utf8');
      this.#buffer = this.#buffer.subarray(HEADER_BYTES + length);
      const waiter = this.#waiters.shift();
      if (waiter) {
        waiter.resolve(message);
      } else {
        this.#queue.push(message);
      }
    }
  }

  #fail(err: Error): void {
    if (this.#error) return;
    this.#error = err;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(err);
    }
  }
}
