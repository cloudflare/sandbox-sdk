import type { ExecEvent, ExecProcess, ExecResult } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { createExecProcess } from '../src/exec-process';

function mockProcess(events: ExecEvent[]): ExecProcess {
  return createExecProcess({
    buffered: async () => {
      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      for (const e of events) {
        if (e.type === 'stdout' && e.data) stdout += e.data;
        if (e.type === 'stderr' && e.data) stderr += e.data;
        if (e.type === 'complete') exitCode = e.exitCode ?? 0;
        if (e.type === 'error')
          throw new Error(e.data || 'Command execution failed');
      }
      return {
        success: exitCode === 0,
        exitCode,
        stdout,
        stderr,
        command: '',
        duration: 0,
        timestamp: ''
      };
    },
    stream: () => Promise.resolve(createSSEStream(events))
  });
}

function createSSEStream(events: ExecEvent[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
}

function stdEvents(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): ExecEvent[] {
  const ts = new Date().toISOString();
  const events: ExecEvent[] = [
    { type: 'start', timestamp: ts, pid: 42, sessionId: 'sess-1' }
  ];
  if (opts.stdout != null) {
    events.push({ type: 'stdout', data: opts.stdout, timestamp: ts });
  }
  if (opts.stderr != null) {
    events.push({ type: 'stderr', data: opts.stderr, timestamp: ts });
  }
  events.push({
    type: 'complete',
    exitCode: opts.exitCode ?? 0,
    timestamp: ts
  });
  return events;
}

describe('createExecProcess', () => {
  describe('output() — buffered path', () => {
    it('returns the buffered ExecResult', async () => {
      const proc = mockProcess(
        stdEvents({ stdout: 'hello\n', stderr: 'warn\n' })
      );
      const result = await proc.output();

      expect(result.stdout).toBe('hello\n');
      expect(result.stderr).toBe('warn\n');
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
    });

    it('reports failure for non-zero exit code', async () => {
      const proc = mockProcess(stdEvents({ exitCode: 1 }));
      const result = await proc.output();

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('handles empty stdout and stderr', async () => {
      const proc = mockProcess(stdEvents({}));
      const result = await proc.output();

      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('PromiseLike (then) — uses buffered path', () => {
    it('resolves to ExecResult when awaited', async () => {
      const proc = mockProcess(stdEvents({ stdout: 'hi\n' }));
      const result: ExecResult = await proc;

      expect(result.stdout).toBe('hi\n');
      expect(result.exitCode).toBe(0);
    });

    it('supports .then() chaining', async () => {
      const proc = mockProcess(stdEvents({ stdout: 'chain\n' }));
      const stdout = await proc.then((r) => r.stdout);

      expect(stdout).toBe('chain\n');
    });

    it('supports .then(null, onRejected) for errors', async () => {
      const ts = new Date().toISOString();
      const proc = mockProcess([
        { type: 'start', timestamp: ts },
        { type: 'error', data: 'kaboom', timestamp: ts }
      ]);
      const err = await proc.then(
        () => null,
        (e) => e
      );

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('kaboom');
    });
  });

  describe('exitCode — streaming path', () => {
    it('resolves with exit code from complete event', async () => {
      const proc = mockProcess(stdEvents({ exitCode: 42 }));
      await expect(proc.exitCode).resolves.toBe(42);
    });

    it('rejects on error event', async () => {
      const ts = new Date().toISOString();
      const proc = mockProcess([
        { type: 'start', timestamp: ts },
        { type: 'error', data: 'oops', timestamp: ts }
      ]);
      await expect(proc.exitCode).rejects.toThrow('oops');
    });

    it('rejects when stream ends without completion', async () => {
      const proc = mockProcess([
        { type: 'start', timestamp: new Date().toISOString() }
      ]);
      await expect(proc.exitCode).rejects.toThrow(
        'Stream ended without completion event'
      );
    });
  });

  describe('stdout / stderr — streaming path', () => {
    it('demuxes stdout and stderr into separate streams', async () => {
      const proc = mockProcess(
        stdEvents({ stdout: 'out-data', stderr: 'err-data' })
      );

      const decoder = new TextDecoder();
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      const [stdoutReader, stderrReader] = [
        proc.stdout.getReader(),
        proc.stderr.getReader()
      ];

      for (;;) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdoutChunks.push(decoder.decode(value));
      }
      for (;;) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrChunks.push(decoder.decode(value));
      }

      expect(stdoutChunks.join('')).toBe('out-data');
      expect(stderrChunks.join('')).toBe('err-data');
    });
  });

  describe('error propagation', () => {
    it('propagates buffered rejection through then()', async () => {
      const proc = createExecProcess({
        buffered: () => Promise.reject(new Error('rpc down')),
        stream: () => Promise.resolve(createSSEStream([]))
      });
      await expect(proc.then((r) => r)).rejects.toThrow('rpc down');
    });

    it('propagates stream rejection through exitCode', async () => {
      const proc = createExecProcess({
        buffered: () => Promise.resolve({} as ExecResult),
        stream: () => Promise.reject(new Error('stream failed'))
      });
      await expect(proc.exitCode).rejects.toThrow('stream failed');
    });
  });
});
