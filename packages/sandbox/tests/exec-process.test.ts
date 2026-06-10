import type { ExecEvent, ExecResult } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { createExecProcess } from '../src/exec-process';

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
  describe('output()', () => {
    it('buffers stdout and stderr into ExecResult', async () => {
      const proc = createExecProcess(
        'echo hello',
        createSSEStream(stdEvents({ stdout: 'hello\n', stderr: 'warn\n' }))
      );
      const result = await proc.output();

      expect(result.stdout).toBe('hello\n');
      expect(result.stderr).toBe('warn\n');
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
      expect(result.command).toBe('echo hello');
      expect(result.sessionId).toBe('sess-1');
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeTruthy();
    });

    it('reports failure for non-zero exit code', async () => {
      const proc = createExecProcess(
        'false',
        createSSEStream(stdEvents({ exitCode: 1 }))
      );
      const result = await proc.output();

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('handles empty stdout and stderr', async () => {
      const proc = createExecProcess('true', createSSEStream(stdEvents({})));
      const result = await proc.output();

      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('PromiseLike (then)', () => {
    it('resolves to ExecResult when awaited', async () => {
      const proc = createExecProcess(
        'echo hi',
        createSSEStream(stdEvents({ stdout: 'hi\n' }))
      );
      const result: ExecResult = await proc;

      expect(result.stdout).toBe('hi\n');
      expect(result.exitCode).toBe(0);
    });

    it('supports .then() chaining', async () => {
      const proc = createExecProcess(
        'echo chain',
        createSSEStream(stdEvents({ stdout: 'chain\n' }))
      );
      const stdout = await proc.then((r) => r.stdout);

      expect(stdout).toBe('chain\n');
    });

    it('supports .then(null, onRejected) for errors', async () => {
      const ts = new Date().toISOString();
      const proc = createExecProcess(
        'bad',
        createSSEStream([
          { type: 'start', timestamp: ts },
          { type: 'error', data: 'kaboom', timestamp: ts }
        ])
      );
      const err = await proc.then(
        () => null,
        (e) => e
      );

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('kaboom');
    });
  });

  describe('exitCode', () => {
    it('resolves with exit code from complete event', async () => {
      const proc = createExecProcess(
        'exit 42',
        createSSEStream(stdEvents({ exitCode: 42 }))
      );
      await expect(proc.exitCode).resolves.toBe(42);
    });

    it('rejects on error event', async () => {
      const ts = new Date().toISOString();
      const proc = createExecProcess(
        'fail',
        createSSEStream([
          { type: 'start', timestamp: ts },
          { type: 'error', data: 'oops', timestamp: ts }
        ])
      );
      await expect(proc.exitCode).rejects.toThrow('oops');
    });

    it('rejects when stream ends without completion', async () => {
      const proc = createExecProcess(
        'hang',
        createSSEStream([
          { type: 'start', timestamp: new Date().toISOString() }
        ])
      );
      await expect(proc.exitCode).rejects.toThrow(
        'Stream ended without completion event'
      );
    });
  });

  describe('stdout / stderr streams', () => {
    it('demuxes stdout and stderr into separate streams', async () => {
      const proc = createExecProcess(
        'mixed',
        createSSEStream(stdEvents({ stdout: 'out-data', stderr: 'err-data' }))
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

  describe('lazy promise input', () => {
    it('accepts a Promise<ReadableStream> for deferred setup', async () => {
      const streamPromise = Promise.resolve(
        createSSEStream(stdEvents({ stdout: 'lazy\n' }))
      );
      const proc = createExecProcess('echo lazy', streamPromise);
      const result = await proc;

      expect(result.stdout).toBe('lazy\n');
    });

    it('propagates setup rejection through exitCode', async () => {
      const streamPromise = Promise.reject(new Error('setup failed'));
      const proc = createExecProcess('fail', streamPromise);

      await expect(proc.exitCode).rejects.toThrow('setup failed');
    });

    it('propagates setup rejection through then()', async () => {
      const streamPromise = Promise.reject(new Error('rpc down'));
      const proc = createExecProcess('fail', streamPromise);

      await expect(proc.then((r) => r)).rejects.toThrow('rpc down');
    });
  });
});
