/**
 * Unit coverage for `resolveStdinForRpc` and the `SandboxProcessImpl` /
 * SDK plumbing that exposes `proc.stdin` as a `WritableStream` when the
 * caller passes `stdin: 'pipe'`.
 *
 * The container-side FIFO behaviour is exercised by E2E (see
 * `tests/e2e/...`); these tests pin the SDK-side contract.
 */

import type { ProcessStatus, WaitForExitResult } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import { resolveStdinForRpc, SandboxProcessImpl } from '../src/process';

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

describe('SandboxProcessImpl', () => {
  function createProcess(
    options: {
      stdout?: 'pipe' | 'ignore';
      stderr?: 'pipe' | 'ignore' | 'combined';
    } = {}
  ) {
    const deps = {
      openLogStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          }
        }),
      readLogs: async () => ({ stdout: 'out', stderr: 'err' }),
      fetchStatus: async (): Promise<ProcessStatus> => 'completed',
      killProcess: async (_id: string, _signal: number) => {},
      waitForPort: async () => {},
      waitForLogPattern: async () => ({ line: 'out' }),
      waitForProcessExit: async (): Promise<WaitForExitResult> => ({
        exitCode: 0
      })
    };

    return {
      deps,
      proc: new SandboxProcessImpl(
        {
          id: 'proc-test',
          pid: 123,
          command: 'echo test',
          startTime: new Date('2024-01-01T00:00:00Z'),
          status: 'running',
          ownership: 'owner',
          stdout: options.stdout ?? 'pipe',
          stderr: options.stderr ?? 'pipe',
          stdin: null
        },
        deps
      )
    };
  }

  it('forwards normalized kill signals to deps', async () => {
    const { deps, proc } = createProcess();
    const calls: Array<{ id: string; signal: number }> = [];
    deps.killProcess = async (id: string, signal: number) => {
      calls.push({ id, signal });
    };

    proc.kill('SIGKILL');

    await vi.waitFor(() =>
      expect(calls).toEqual([{ id: 'proc-test', signal: 9 }])
    );
  });

  it('honors ignore and combined modes in buffered output', async () => {
    const ignored = await createProcess({
      stdout: 'ignore',
      stderr: 'ignore'
    }).proc.outputViaLogs();
    expect(ignored.stdout).toBe('');
    expect(ignored.stderr).toBe('');

    const combined = await createProcess({
      stderr: 'combined'
    }).proc.outputViaLogs();
    expect(combined.stdout).toBe('out');
    expect(combined.stderr).toBe('');
  });
});
