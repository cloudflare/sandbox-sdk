/**
 * Unit coverage for `resolveStdinForRpc` and the `SandboxProcessImpl` /
 * SDK plumbing that exposes `proc.stdin` as a `WritableStream` when the
 * caller passes `stdin: 'pipe'`.
 *
 * The container-side FIFO behaviour is exercised by E2E (see
 * `tests/e2e/...`); these tests pin the SDK-side contract.
 */

import { describe, expect, it } from 'vitest';
import { resolveStdinForRpc } from '../src/process';

async function readAll(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

describe('resolveStdinForRpc', () => {
  it('returns no stream and no writer when stdin is undefined', () => {
    const r = resolveStdinForRpc(undefined);
    expect(r.stdinSource).toBeUndefined();
    expect(r.stdinWriter).toBeNull();
  });

  it('returns a TransformStream pair for "pipe"', async () => {
    const r = resolveStdinForRpc('pipe');
    expect(r.stdinSource).toBeInstanceOf(ReadableStream);
    expect(r.stdinWriter).toBeInstanceOf(WritableStream);

    // Drain in parallel: `TransformStream` defaults to `highWaterMark: 1`
    // on its writable queue, so back-to-back `await writer.write(...)`
    // calls back-pressure until the reader consumes. Start the drain
    // first to model the real container-side pump.
    const drained = readAll(r.stdinSource!);
    const writer = r.stdinWriter!.getWriter();
    await writer.write(new TextEncoder().encode('hello, '));
    await writer.write(new TextEncoder().encode('world'));
    await writer.close();

    const bytes = await drained;
    expect(new TextDecoder().decode(bytes)).toBe('hello, world');
  });

  it('encodes string stdin as a single-chunk utf-8 ReadableStream', async () => {
    const r = resolveStdinForRpc('one\ntwo\nthree\n');
    expect(r.stdinWriter).toBeNull();
    expect(r.stdinSource).toBeInstanceOf(ReadableStream);

    const bytes = await readAll(r.stdinSource!);
    expect(new TextDecoder().decode(bytes)).toBe('one\ntwo\nthree\n');
  });

  it('passes a caller-supplied ReadableStream through unchanged', async () => {
    const original = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('passthrough'));
        controller.close();
      }
    });

    const r = resolveStdinForRpc(original);
    expect(r.stdinSource).toBe(original);
    expect(r.stdinWriter).toBeNull();

    const bytes = await readAll(r.stdinSource!);
    expect(new TextDecoder().decode(bytes)).toBe('passthrough');
  });

  it('streams successive chunks through to the readable side', async () => {
    const r = resolveStdinForRpc('pipe');
    const drained = readAll(r.stdinSource!);
    const writer = r.stdinWriter!.getWriter();
    await writer.write(new TextEncoder().encode('a'));
    await writer.write(new TextEncoder().encode('b'));
    await writer.write(new TextEncoder().encode('c'));
    await writer.close();

    const bytes = await drained;
    expect(new TextDecoder().decode(bytes)).toBe('abc');
  });
});
