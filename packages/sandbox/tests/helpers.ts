import { vi } from "vite-plus/test";

export const encoder = new TextEncoder();
export const SUCCESS_HEADER = new Uint8Array([0x53, 0x42, 0x58, 0x46, 1, 0]);

export function successFrame(...content: Uint8Array[]): Uint8Array[] {
  return [SUCCESS_HEADER, ...content];
}

export function errorFrame(errnoNumber: number, message: string): Uint8Array[] {
  return errorFrameBytes(errnoNumber, encoder.encode(message));
}

export function errorFrameBytes(errnoNumber: number, detail: Uint8Array): Uint8Array[] {
  const errno = new Uint8Array(4);
  new DataView(errno.buffer).setInt32(0, errnoNumber, true);
  return [new Uint8Array([0x53, 0x42, 0x58, 0x46, 1, 1]), errno, detail];
}

export function contiguousErrorFrame(errnoNumber: number, detail: string): Uint8Array {
  const message = encoder.encode(detail);
  const frame = new Uint8Array(10 + message.length);
  frame.set([0x53, 0x42, 0x58, 0x46, 1, 1]);
  new DataView(frame.buffer).setInt32(6, errnoNumber, true);
  frame.set(message, 10);
  return frame;
}

export function readableChunks(chunks: Uint8Array[], close = true): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (close) controller.close();
    },
  });
}

interface ProcessOptions {
  stdout: ReadableStream<Uint8Array> | null;
  stdin: WritableStream<Uint8Array> | null;
  exitCode?: number | Promise<number>;
}

function processDouble(options: ProcessOptions) {
  return {
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: null,
    pid: 1,
    isPty: false,
    exitCode: Promise.resolve(options.exitCode ?? 0),
    output: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
  };
}

export function readProcess(
  chunks: Uint8Array[],
  exitCode: number | Promise<number> = 0,
  stdout: ReadableStream<Uint8Array> | null = readableChunks(chunks),
) {
  return processDouble({ stdin: null, stdout, exitCode });
}

interface WriteProcessOptions {
  stdout?: ReadableStream<Uint8Array> | null;
  stdin?: WritableStream<Uint8Array> | null;
  exitCode?: number | Promise<number>;
}

export function writeProcess(options: WriteProcessOptions = {}) {
  return processDouble({
    stdin: options.stdin === undefined ? new WritableStream<Uint8Array>() : options.stdin,
    stdout:
      options.stdout === undefined
        ? readableChunks([SUCCESS_HEADER, SUCCESS_HEADER])
        : options.stdout,
    exitCode: options.exitCode,
  });
}

export function containerWith(process: ExecProcess) {
  return { exec: vi.fn().mockResolvedValue(process) };
}

export interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
}

export function deferred<Value>(): Deferred<Value> {
  let resolvePromise: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = (value) => resolve(value);
  });
  return { promise, resolve: resolvePromise };
}
