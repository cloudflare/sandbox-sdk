/**
 * File Transfer Benchmark
 *
 * Measures readFile and readFileStream performance across file sizes from 1 KiB
 * to 128 MiB.  Run this before and after each fix to compare results directly.
 *
 * Metrics reported per run:
 *   - Duration (ms / s)
 *   - Throughput (MB/s)
 *   - TTFB – time to first byte (streaming only)
 *   - Bytes received (sanity check)
 *   - Error/status if something went wrong
 *
 * All scenarios handle errors gracefully – a timeout or platform error is
 * recorded in the results table rather than stopping the benchmark run.
 *
 * Usage:
 *   npm run test:e2e:vitest -- -- tests/e2e/file-transfer-benchmark.test.ts
 *
 * Results are printed as a formatted table at the end of the run.
 * Copy the table output for before/after comparison.
 */

import { afterAll, beforeAll, describe, test } from 'vitest';
import {
  createUniqueSession,
  getSharedSandbox
} from './helpers/global-sandbox';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const FILE_SIZES: Array<{ bytes: number; label: string }> = [
  { bytes: 1 * 1024, label: '1 KiB' },
  { bytes: 256 * 1024, label: '256 KiB' },
  { bytes: 1 * 1024 * 1024, label: '1 MiB' },
  { bytes: 8 * 1024 * 1024, label: '8 MiB' },
  { bytes: 20 * 1024 * 1024, label: '20 MiB' },
  { bytes: 33 * 1024 * 1024, label: '33 MiB' },
  { bytes: 64 * 1024 * 1024, label: '64 MiB' },
  { bytes: 128 * 1024 * 1024, label: '128 MiB' }
];

// Per-test timeout – large files with the current shell-exec implementation
// can take several minutes.  Set high so we measure the real baseline.
const TEST_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Transport mode – set SANDBOX_TRANSPORT=websocket to benchmark WebSocket path.
// Defaults to 'http' to match the SDK default.
const SANDBOX_TRANSPORT = process.env.SANDBOX_TRANSPORT ?? 'http';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface BenchmarkResult {
  method: string;
  sizeLabel: string;
  transport: string;
  durationMs: number;
  throughputMBps: number;
  ttfbMs: number | null;
  bytesReceived: number;
  status: 'ok' | 'error' | 'timeout';
  errorDetail: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mb(bytes: number): number {
  return bytes / (1024 * 1024);
}

function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
}

function fmtThroughput(mbps: number): string {
  return `${mbps.toFixed(2)} MB/s`;
}

function fmtBytes(bytes: number): string {
  if (bytes === 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${mb(bytes).toFixed(1)} MiB`;
}

function printTable(results: BenchmarkResult[]): void {
  if (results.length === 0) return;

  const LINE =
    '─'.repeat(17) +
    '┼' +
    '─'.repeat(11) +
    '┼' +
    '─'.repeat(12) +
    '┼' +
    '─'.repeat(14) +
    '┼' +
    '─'.repeat(12) +
    '┼' +
    '─'.repeat(11) +
    '┼' +
    '─'.repeat(13) +
    '┼' +
    '─'.repeat(9) +
    '┼' +
    '─'.repeat(30);

  const HDR =
    ' Method          │' +
    ' Size      │' +
    ' Transport  │' +
    ' Duration     │' +
    ' Throughput  │' +
    ' TTFB      │' +
    ' Bytes rcvd  │' +
    ' Status  │' +
    ' Error';

  console.log(`\n┌${LINE.replace(/┼/g, '─')}┐`);
  console.log(`│${HDR} │`);
  console.log(`├${LINE}┤`);

  for (const r of results) {
    const method = r.method.padEnd(16);
    const size = r.sizeLabel.padEnd(10);
    const transport = r.transport.padEnd(11);
    const duration = fmtDuration(r.durationMs).padEnd(13);
    const throughput = (
      r.status === 'ok' ? fmtThroughput(r.throughputMBps) : '—'
    ).padEnd(11);
    const ttfb = (r.ttfbMs !== null ? fmtDuration(r.ttfbMs) : '—').padEnd(10);
    const bytes = fmtBytes(r.bytesReceived).padEnd(12);
    const status = r.status.padEnd(8);
    const error = r.errorDetail ? r.errorDetail.slice(0, 28) : '—';

    console.log(
      `│ ${method}│ ${size}│ ${transport}│ ${duration}│ ${throughput}│ ${ttfb}│ ${bytes}│ ${status}│ ${error}`
    );
  }

  console.log(`└${LINE.replace(/┼/g, '─')}┘\n`);
}

/**
 * Create a binary test file of exactly `bytes` bytes in the sandbox.
 * Uses dd + /dev/urandom – fast and produces realistic binary content.
 * Returns the absolute path, or throws if creation fails.
 */
async function createFile(
  workerUrl: string,
  headers: Record<string, string>,
  dir: string,
  bytes: number
): Promise<string> {
  const path = `${dir}/bench-${bytes}.bin`;
  const blocks = Math.ceil(bytes / 1024);

  // dd then truncate to get an exact byte count
  const cmd = `dd if=/dev/urandom of=${path} bs=1024 count=${blocks} 2>/dev/null && truncate -s ${bytes} ${path}`;

  const res = await fetch(`${workerUrl}/api/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ command: cmd })
  });

  if (!res.ok) {
    throw new Error(`File creation HTTP ${res.status}`);
  }

  const data = (await res.json()) as { success: boolean; stderr?: string };
  if (!data.success) {
    throw new Error(`File creation failed: ${data.stderr ?? 'unknown'}`);
  }

  return path;
}

/**
 * Run readFile and return a BenchmarkResult.
 * Catches all errors so a single failure never stops the suite.
 */
async function runReadFile(
  workerUrl: string,
  headers: Record<string, string>,
  path: string,
  fileSizeBytes: number,
  sizeLabel: string
): Promise<BenchmarkResult> {
  const t0 = performance.now();

  try {
    const res = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path })
    });

    const durationMs = performance.now() - t0;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        method: 'readFile',
        sizeLabel,
        transport: SANDBOX_TRANSPORT,
        durationMs,
        throughputMBps: 0,
        ttfbMs: null,
        bytesReceived: 0,
        status: 'error',
        errorDetail: `HTTP ${res.status}: ${body.slice(0, 60)}`
      };
    }

    const data = (await res.json()) as {
      success: boolean;
      content?: string;
      encoding?: string;
      error?: string;
    };

    if (!data.success || !data.content) {
      return {
        method: 'readFile',
        sizeLabel,
        transport: SANDBOX_TRANSPORT,
        durationMs,
        throughputMBps: 0,
        ttfbMs: null,
        bytesReceived: 0,
        status: 'error',
        errorDetail: data.error ?? 'no content returned'
      };
    }

    // Approximate bytes received – base64 encoding inflates by ~33%
    const bytesReceived =
      data.encoding === 'base64'
        ? Math.floor((data.content.length * 3) / 4)
        : new TextEncoder().encode(data.content).byteLength;

    const throughputMBps =
      durationMs > 0 ? mb(bytesReceived) / (durationMs / 1000) : 0;

    return {
      method: 'readFile',
      sizeLabel,
      transport: SANDBOX_TRANSPORT,
      durationMs,
      throughputMBps,
      ttfbMs: null,
      bytesReceived,
      status: 'ok',
      errorDetail: ''
    };
  } catch (err) {
    const durationMs = performance.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout =
      msg.toLowerCase().includes('timeout') ||
      msg.toLowerCase().includes('abort');
    return {
      method: 'readFile',
      sizeLabel,
      transport: SANDBOX_TRANSPORT,
      durationMs,
      throughputMBps: 0,
      ttfbMs: null,
      bytesReceived: 0,
      status: isTimeout ? 'timeout' : 'error',
      errorDetail: msg.slice(0, 60)
    };
  }
}

/**
 * Run readFileStream and return a BenchmarkResult.
 * Parses the SSE event stream directly (no SDK dependency) so we measure the
 * raw wire performance.
 */
async function runReadFileStream(
  workerUrl: string,
  headers: Record<string, string>,
  path: string,
  fileSizeBytes: number,
  sizeLabel: string
): Promise<BenchmarkResult> {
  const t0 = performance.now();

  try {
    const res = await fetch(`${workerUrl}/api/read/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path })
    });

    if (!res.ok) {
      const durationMs = performance.now() - t0;
      const body = await res.text().catch(() => '');
      return {
        method: 'readFileStream',
        sizeLabel,
        transport: SANDBOX_TRANSPORT,
        durationMs,
        throughputMBps: 0,
        ttfbMs: null,
        bytesReceived: 0,
        status: 'error',
        errorDetail: `HTTP ${res.status}: ${body.slice(0, 60)}`
      };
    }

    if (!res.body) {
      return {
        method: 'readFileStream',
        sizeLabel,
        transport: SANDBOX_TRANSPORT,
        durationMs: performance.now() - t0,
        throughputMBps: 0,
        ttfbMs: null,
        bytesReceived: 0,
        status: 'error',
        errorDetail: 'no response body'
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let ttfbMs: number | null = null;
    let bytesReceived = 0;
    let isBinary = false;
    let done = false;
    let errorDetail = '';

    while (!done) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch (readErr) {
        const msg =
          readErr instanceof Error ? readErr.message : String(readErr);
        const isTimeout =
          msg.toLowerCase().includes('timeout') ||
          msg.toLowerCase().includes('abort');
        reader.releaseLock();
        return {
          method: 'readFileStream',
          sizeLabel,
          transport: SANDBOX_TRANSPORT,
          durationMs: performance.now() - t0,
          throughputMBps: 0,
          ttfbMs,
          bytesReceived,
          status: isTimeout ? 'timeout' : 'error',
          errorDetail: msg.slice(0, 60)
        };
      }

      if (chunk.done) break;

      if (ttfbMs === null) {
        ttfbMs = performance.now() - t0;
      }

      buffer += decoder.decode(chunk.value, { stream: true });

      // Parse complete SSE events (double-newline delimited)
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary === -1) break;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;

          let sseEvent: {
            type: string;
            data?: string;
            isBinary?: boolean;
            encoding?: string;
            error?: string;
          };
          try {
            sseEvent = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

          if (sseEvent.type === 'metadata') {
            isBinary = sseEvent.isBinary ?? false;
          } else if (sseEvent.type === 'chunk' && sseEvent.data) {
            if (isBinary || sseEvent.encoding === 'base64') {
              bytesReceived += Math.floor((sseEvent.data.length * 3) / 4);
            } else {
              bytesReceived += new TextEncoder().encode(
                sseEvent.data
              ).byteLength;
            }
          } else if (sseEvent.type === 'complete') {
            done = true;
          } else if (sseEvent.type === 'error') {
            errorDetail = sseEvent.error ?? 'stream error event';
            done = true;
          }
        }
      }
    }

    reader.releaseLock();

    const durationMs = performance.now() - t0;
    const throughputMBps =
      durationMs > 0 && bytesReceived > 0
        ? mb(bytesReceived) / (durationMs / 1000)
        : 0;

    return {
      method: 'readFileStream',
      sizeLabel,
      transport: SANDBOX_TRANSPORT,
      durationMs,
      throughputMBps,
      ttfbMs,
      bytesReceived,
      status: errorDetail ? 'error' : 'ok',
      errorDetail
    };
  } catch (err) {
    const durationMs = performance.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout =
      msg.toLowerCase().includes('timeout') ||
      msg.toLowerCase().includes('abort');
    return {
      method: 'readFileStream',
      sizeLabel,
      transport: SANDBOX_TRANSPORT,
      durationMs,
      throughputMBps: 0,
      ttfbMs: null,
      bytesReceived: 0,
      status: isTimeout ? 'timeout' : 'error',
      errorDetail: msg.slice(0, 60)
    };
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('File Transfer Benchmark', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let benchmarkDir: string;
  const results: BenchmarkResult[] = [];

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createHeaders(createUniqueSession());
    benchmarkDir = sandbox.uniquePath('benchmark');

    // Pre-create benchmark directory
    await fetch(`${workerUrl}/api/file/mkdir`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: benchmarkDir, recursive: true })
    });

    console.log(`\n[Benchmark] transport: ${SANDBOX_TRANSPORT}`);
    console.log(`[Benchmark] dir: ${benchmarkDir}`);
    console.log(
      `[Benchmark] sizes: ${FILE_SIZES.map((s) => s.label).join(', ')}\n`
    );
  }, 120_000);

  afterAll(() => {
    printTable(results);
  });

  // -------------------------------------------------------------------------
  // readFile
  // -------------------------------------------------------------------------

  describe('readFile', () => {
    for (const { bytes, label } of FILE_SIZES) {
      test(
        label,
        async () => {
          let path: string;
          try {
            path = await createFile(workerUrl, headers, benchmarkDir, bytes);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(
              `  [readFile] ${label}: skipped – file creation failed: ${msg}`
            );
            results.push({
              method: 'readFile',
              sizeLabel: label,
              transport: SANDBOX_TRANSPORT,
              durationMs: 0,
              throughputMBps: 0,
              ttfbMs: null,
              bytesReceived: 0,
              status: 'error',
              errorDetail: `file creation: ${msg.slice(0, 40)}`
            });
            return;
          }

          const result = await runReadFile(
            workerUrl,
            headers,
            path,
            bytes,
            label
          );
          results.push(result);

          console.log(
            `  [readFile] ${label}: ${fmtDuration(result.durationMs)}` +
              (result.status === 'ok'
                ? ` | ${fmtThroughput(result.throughputMBps)} | ${fmtBytes(result.bytesReceived)}`
                : ` | ${result.status}: ${result.errorDetail}`)
          );
        },
        TEST_TIMEOUT_MS
      );
    }
  });

  // -------------------------------------------------------------------------
  // readFileStream
  // -------------------------------------------------------------------------

  describe('readFileStream', () => {
    for (const { bytes, label } of FILE_SIZES) {
      test(
        label,
        async () => {
          let path: string;
          try {
            path = await createFile(workerUrl, headers, benchmarkDir, bytes);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(
              `  [readFileStream] ${label}: skipped – file creation failed: ${msg}`
            );
            results.push({
              method: 'readFileStream',
              sizeLabel: label,
              transport: SANDBOX_TRANSPORT,
              durationMs: 0,
              throughputMBps: 0,
              ttfbMs: null,
              bytesReceived: 0,
              status: 'error',
              errorDetail: `file creation: ${msg.slice(0, 40)}`
            });
            return;
          }

          const result = await runReadFileStream(
            workerUrl,
            headers,
            path,
            bytes,
            label
          );
          results.push(result);

          console.log(
            `  [readFileStream] ${label}: ${fmtDuration(result.durationMs)}` +
              (result.status === 'ok'
                ? ` | ttfb ${result.ttfbMs !== null ? fmtDuration(result.ttfbMs) : '—'} | ${fmtThroughput(result.throughputMBps)} | ${fmtBytes(result.bytesReceived)}`
                : ` | ${result.status}: ${result.errorDetail}`)
          );
        },
        TEST_TIMEOUT_MS
      );
    }
  });
});
