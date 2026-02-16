import { getSandbox, type Sandbox, streamFile } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
  BACKUP_BUCKET: R2Bucket;
};

const SRC_DIR = '/workspace/sandbox-sdk';
const TMP_DIR = '/tmp/bench';
const CHUNK_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per R2 multipart part
const ARCHIVE_TIMEOUT = 600_000; // 10 min for large archives
const READ_CONCURRENCY = 4;

type SandboxInstance = ReturnType<typeof getSandbox>;

interface TimedResult<T> {
  result: T;
  ms: number;
}

async function timed<T>(fn: () => Promise<T>): Promise<TimedResult<T>> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: round(performance.now() - start) };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function bytesToMB(bytes: number): number {
  return round(bytes / (1024 * 1024));
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

async function ensureTmpDir(sandbox: SandboxInstance): Promise<void> {
  await sandbox.exec(`rm -rf ${TMP_DIR} && mkdir -p ${TMP_DIR}/chunks`);
}

async function getFileSize(
  sandbox: SandboxInstance,
  path: string
): Promise<number> {
  const r = await sandbox.exec(`stat -c%s ${path}`);
  return parseInt(r.stdout.trim(), 10);
}

async function cleanupTmp(sandbox: SandboxInstance): Promise<void> {
  await sandbox.exec(`rm -rf ${TMP_DIR}`);
}

async function getSourceInfo(sandbox: SandboxInstance) {
  const [sizeRes, countRes] = await Promise.all([
    sandbox.exec(`du -sb ${SRC_DIR} | cut -f1`),
    sandbox.exec(`find ${SRC_DIR} -type f | wc -l`)
  ]);
  const bytes = parseInt(sizeRes.stdout.trim(), 10);
  return {
    path: SRC_DIR,
    bytes,
    mb: bytesToMB(bytes),
    fileCount: parseInt(countRes.stdout.trim(), 10)
  };
}

// ---------------------------------------------------------------------------
// Core: archive → split → chunked read → R2 multipart upload
// ---------------------------------------------------------------------------

interface ChunkedUploadResult {
  strategy: string;
  chunks: number;
  steps: {
    archiveMs: number;
    splitMs: number;
    uploadMs: number;
  };
  totalMs: number;
  archiveBytes: number;
  archiveMB: number;
}

async function archiveAndUpload(
  sandbox: SandboxInstance,
  bucket: R2Bucket,
  strategy: string,
  archiveCmd: string,
  r2Key: string
): Promise<ChunkedUploadResult> {
  await ensureTmpDir(sandbox);
  const archive = `${TMP_DIR}/backup`;
  const chunksDir = `${TMP_DIR}/chunks`;

  const { ms: archiveMs, result: archiveRes } = await timed(() =>
    sandbox.exec(`${archiveCmd} ${archive} -C /workspace sandbox-sdk`, {
      timeout: ARCHIVE_TIMEOUT
    })
  );
  if (!archiveRes.success)
    throw new Error(`${strategy} archive failed: ${archiveRes.stderr}`);

  const archiveBytes = await getFileSize(sandbox, archive);

  const { ms: splitMs } = await timed(async () => {
    const r = await sandbox.exec(
      `split -b ${CHUNK_SIZE_BYTES} ${archive} ${chunksDir}/part-`
    );
    if (!r.success) throw new Error(`split failed: ${r.stderr}`);
  });

  const listRes = await sandbox.exec(`ls -1 ${chunksDir} | sort`);
  const chunkNames = listRes.stdout.trim().split('\n').filter(Boolean);

  const multipart = await bucket.createMultipartUpload(r2Key);

  const { ms: uploadMs, result: parts } = await timed(async () => {
    const uploaded: R2UploadedPart[] = [];

    for (let i = 0; i < chunkNames.length; i += READ_CONCURRENCY) {
      const batch = chunkNames.slice(i, i + READ_CONCURRENCY);
      const batchParts = await Promise.all(
        batch.map(async (name, batchIdx) => {
          const partNum = i + batchIdx + 1;
          const chunk = await sandbox.readFile(`${chunksDir}/${name}`, {
            encoding: 'base64'
          });
          return multipart.uploadPart(partNum, base64ToBytes(chunk.content));
        })
      );
      uploaded.push(...batchParts);
    }
    return uploaded;
  });

  await multipart.complete(parts);
  await cleanupTmp(sandbox);

  return {
    strategy,
    chunks: chunkNames.length,
    steps: { archiveMs, splitMs, uploadMs },
    totalMs: round(archiveMs + splitMs + uploadMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes)
  };
}

// ---------------------------------------------------------------------------
// Core: archive → readFileStream → streamFile → R2.put (single object)
// ---------------------------------------------------------------------------

interface StreamUploadResult {
  strategy: string;
  steps: {
    archiveMs: number;
    streamUploadMs: number;
  };
  totalMs: number;
  archiveBytes: number;
  archiveMB: number;
}

async function archiveAndStream(
  sandbox: SandboxInstance,
  bucket: R2Bucket,
  strategy: string,
  archiveCmd: string,
  r2Key: string
): Promise<StreamUploadResult> {
  await ensureTmpDir(sandbox);
  const archive = `${TMP_DIR}/backup`;

  const { ms: archiveMs, result: archiveRes } = await timed(() =>
    sandbox.exec(`${archiveCmd} ${archive} -C /workspace sandbox-sdk`, {
      timeout: ARCHIVE_TIMEOUT
    })
  );
  if (!archiveRes.success)
    throw new Error(`${strategy} archive failed: ${archiveRes.stderr}`);

  const archiveBytes = await getFileSize(sandbox, archive);

  // Stream archive from container → Worker → R2 in one pass
  const { ms: streamUploadMs } = await timed(async () => {
    const sseStream = await sandbox.readFileStream(archive);
    const fixedStream = new FixedLengthStream(archiveBytes);
    // Pump decoded chunks into the writable side
    const pumpPromise = (async () => {
      const writer = fixedStream.writable.getWriter();
      try {
        for await (const chunk of streamFile(sseStream)) {
          if (chunk instanceof Uint8Array) {
            await writer.write(chunk);
          } else {
            await writer.write(new TextEncoder().encode(chunk));
          }
        }
        await writer.close();
      } catch (err) {
        await writer.abort(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    })();
    // R2 consumes the readable side concurrently
    await Promise.all([bucket.put(r2Key, fixedStream.readable), pumpPromise]);
  });

  await cleanupTmp(sandbox);

  return {
    strategy,
    steps: { archiveMs, streamUploadMs },
    totalMs: round(archiveMs + streamUploadMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes)
  };
}

// ---------------------------------------------------------------------------
// Core: archive → Bun file server → containerFetch (raw binary) → R2.put
// ---------------------------------------------------------------------------

interface DirectFetchResult {
  strategy: string;
  steps: {
    archiveMs: number;
    fetchUploadMs: number;
  };
  totalMs: number;
  archiveBytes: number;
  archiveMB: number;
}

const SERVE_PORT = 8080;

async function archiveAndDirectFetch(
  sandbox: SandboxInstance,
  bucket: R2Bucket,
  strategy: string,
  archiveCmd: string,
  r2Key: string
): Promise<DirectFetchResult> {
  await ensureTmpDir(sandbox);
  const archive = `${TMP_DIR}/backup`;

  const { ms: archiveMs, result: archiveRes } = await timed(() =>
    sandbox.exec(`${archiveCmd} ${archive} -C /workspace sandbox-sdk`, {
      timeout: ARCHIVE_TIMEOUT
    })
  );
  if (!archiveRes.success)
    throw new Error(`${strategy} archive failed: ${archiveRes.stderr}`);

  const archiveBytes = await getFileSize(sandbox, archive);

  // Start a minimal Bun file server (Bun.file streams lazily with correct Content-Length)
  await sandbox.exec(
    `bun -e "Bun.serve({port: ${SERVE_PORT}, fetch: () => new Response(Bun.file('${archive}'))})" &>/dev/null &`,
    { timeout: 5000 }
  );
  await sandbox.exec('sleep 0.3');

  const { ms: fetchUploadMs } = await timed(async () => {
    const resp = await sandbox.containerFetch(
      new Request(`http://localhost:${SERVE_PORT}/`),
      SERVE_PORT
    );
    if (!resp.ok) throw new Error(`containerFetch failed: ${resp.status}`);
    if (!resp.body) throw new Error('containerFetch returned no body');

    const fixedStream = new FixedLengthStream(archiveBytes);

    const pumpPromise = (async () => {
      const writer = fixedStream.writable.getWriter();
      const reader = resp.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
        await writer.close();
      } catch (err) {
        await writer.abort(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    })();

    await Promise.all([bucket.put(r2Key, fixedStream.readable), pumpPromise]);
  });

  await sandbox.exec(`pkill -f 'bun.*${SERVE_PORT}' || true`);
  await cleanupTmp(sandbox);

  return {
    strategy,
    steps: { archiveMs, fetchUploadMs },
    totalMs: round(archiveMs + fetchUploadMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes)
  };
}

// ---------------------------------------------------------------------------
// Core: tar|compress piped directly into HTTP response → R2 multipart
// No intermediate file on disk. Archive + transfer happen simultaneously.
// ---------------------------------------------------------------------------

interface PipeResult {
  strategy: string;
  steps: {
    pipeUploadMs: number;
  };
  totalMs: number;
  uploadedBytes: number;
  uploadedMB: number;
  parts: number;
}

const PIPE_PORT = 8081;
const MULTIPART_PART_SIZE = 10 * 1024 * 1024; // R2 requires all non-final parts to be the same size

async function pipeArchiveAndUpload(
  sandbox: SandboxInstance,
  bucket: R2Bucket,
  strategy: string,
  pipeCmd: string,
  r2Key: string
): Promise<PipeResult> {
  await sandbox.exec(`mkdir -p ${TMP_DIR}`);

  const serverScript = `
const server = Bun.serve({
  port: ${PIPE_PORT},
  fetch() {
    const proc = Bun.spawn(["bash", "-c", ${JSON.stringify(pipeCmd)}], { stdout: "pipe" });
    return new Response(proc.stdout);
  }
});
console.log("pipe-server listening on " + server.port);
`;
  await sandbox.writeFile(`${TMP_DIR}/pipe-server.ts`, serverScript);
  await sandbox.exec(`pkill -9 -f pipe-server || true`);
  await sandbox.exec('sleep 0.2');
  await sandbox.exec(`bun ${TMP_DIR}/pipe-server.ts &>/dev/null &`, {
    timeout: 5000
  });
  await sandbox.exec('sleep 0.5');

  const {
    ms: pipeUploadMs,
    result: { uploadedBytes, partCount }
  } = await timed(async () => {
    const resp = await sandbox.containerFetch(
      new Request(`http://localhost:${PIPE_PORT}/`),
      PIPE_PORT
    );
    if (!resp.ok) throw new Error(`containerFetch failed: ${resp.status}`);
    if (!resp.body) throw new Error('containerFetch returned no body');

    // Collect the full stream, then upload via multipart
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        totalBytes += value.length;
      }
    }

    // Concatenate all chunks into a single buffer
    const full = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      full.set(chunk, offset);
      offset += chunk.length;
    }

    // Upload fixed-size parts (R2 requires all non-final parts to be identical size)
    const multipart = await bucket.createMultipartUpload(r2Key);
    const parts: R2UploadedPart[] = [];
    let partNum = 1;

    for (let i = 0; i < totalBytes; i += MULTIPART_PART_SIZE) {
      const end = Math.min(i + MULTIPART_PART_SIZE, totalBytes);
      parts.push(await multipart.uploadPart(partNum++, full.slice(i, end)));
    }

    await multipart.complete(parts);
    return { uploadedBytes: totalBytes, partCount: parts.length };
  });

  await sandbox.exec(`pkill -9 -f pipe-server || true`);

  return {
    strategy,
    steps: { pipeUploadMs },
    totalMs: round(pipeUploadMs),
    uploadedBytes,
    uploadedMB: bytesToMB(uploadedBytes),
    parts: partCount
  };
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

type BenchResult =
  | ChunkedUploadResult
  | StreamUploadResult
  | DirectFetchResult
  | PipeResult;

// Chunked multipart strategies (archive → split → readFile chunks → R2 multipart)
const benchTar = (s: SandboxInstance, b: R2Bucket) =>
  archiveAndUpload(s, b, 'tar-chunked', 'tar cf', 'bench/chunked/snapshot.tar');

const benchTarGz = (s: SandboxInstance, b: R2Bucket) =>
  archiveAndUpload(
    s,
    b,
    'tar-gz-chunked',
    'tar czf',
    'bench/chunked/snapshot.tar.gz'
  );

const benchTarZst = (s: SandboxInstance, b: R2Bucket) =>
  archiveAndUpload(
    s,
    b,
    'tar-zst-chunked',
    "tar -I 'zstd -T0' -cf",
    'bench/chunked/snapshot.tar.zst'
  );

const benchTarZstFast = (s: SandboxInstance, b: R2Bucket) =>
  archiveAndUpload(
    s,
    b,
    'tar-zst-fast-chunked',
    "tar -I 'zstd -T0 -1' -cf",
    'bench/chunked/snapshot-fast.tar.zst'
  );

// Streaming strategies (archive → readFileStream → streamFile → R2.put)
const benchTarStream = (s: SandboxInstance, b: R2Bucket) =>
  archiveAndStream(s, b, 'tar-stream', 'tar cf', 'bench/stream/snapshot.tar');

const benchTarGzStream = (s: SandboxInstance, b: R2Bucket) =>
  archiveAndStream(
    s,
    b,
    'tar-gz-stream',
    'tar czf',
    'bench/stream/snapshot.tar.gz'
  );

const benchTarZstStream = (s: SandboxInstance, b: R2Bucket) =>
  archiveAndStream(
    s,
    b,
    'tar-zst-stream',
    "tar -I 'zstd -T0' -cf",
    'bench/stream/snapshot.tar.zst'
  );

const benchTarZstFastStream = (s: SandboxInstance, b: R2Bucket) =>
  archiveAndStream(
    s,
    b,
    'tar-zst-fast-stream',
    "tar -I 'zstd -T0 -1' -cf",
    'bench/stream/snapshot-fast.tar.zst'
  );

// Direct fetch strategies (archive → Bun file server → containerFetch raw binary → R2.put)
const benchTarDirect = (s: SandboxInstance, b: R2Bucket) =>
  archiveAndDirectFetch(
    s,
    b,
    'tar-direct',
    'tar cf',
    'bench/direct/snapshot.tar'
  );

const benchTarGzDirect = (s: SandboxInstance, b: R2Bucket) =>
  archiveAndDirectFetch(
    s,
    b,
    'tar-gz-direct',
    'tar czf',
    'bench/direct/snapshot.tar.gz'
  );

const benchTarZstDirect = (s: SandboxInstance, b: R2Bucket) =>
  archiveAndDirectFetch(
    s,
    b,
    'tar-zst-direct',
    "tar -I 'zstd -T0' -cf",
    'bench/direct/snapshot.tar.zst'
  );

const benchTarZstFastDirect = (s: SandboxInstance, b: R2Bucket) =>
  archiveAndDirectFetch(
    s,
    b,
    'tar-zst-fast-direct',
    "tar -I 'zstd -T0 -1' -cf",
    'bench/direct/snapshot-fast.tar.zst'
  );

const benchTarPipe = (s: SandboxInstance, b: R2Bucket) =>
  pipeArchiveAndUpload(
    s,
    b,
    'tar-pipe',
    `tar cf - -C /workspace sandbox-sdk`,
    'bench/pipe/snapshot.tar'
  );

const benchTarZstPipe = (s: SandboxInstance, b: R2Bucket) =>
  pipeArchiveAndUpload(
    s,
    b,
    'tar-zst-pipe',
    `tar cf - -C /workspace sandbox-sdk | zstd -T0 -3`,
    'bench/pipe/snapshot.tar.zst'
  );

const benchTarZstFastPipe = (s: SandboxInstance, b: R2Bucket) =>
  pipeArchiveAndUpload(
    s,
    b,
    'tar-zst-fast-pipe',
    `tar cf - -C /workspace sandbox-sdk | zstd -T0 -1`,
    'bench/pipe/snapshot-fast.tar.zst'
  );

const STRATEGIES: Record<
  string,
  (s: SandboxInstance, b: R2Bucket) => Promise<BenchResult>
> = {
  'tar-chunked': benchTar,
  'tar-gz-chunked': benchTarGz,
  'tar-zst-chunked': benchTarZst,
  'tar-zst-fast-chunked': benchTarZstFast,
  'tar-stream': benchTarStream,
  'tar-gz-stream': benchTarGzStream,
  'tar-zst-stream': benchTarZstStream,
  'tar-zst-fast-stream': benchTarZstFastStream,
  'tar-direct': benchTarDirect,
  'tar-gz-direct': benchTarGzDirect,
  'tar-zst-direct': benchTarZstDirect,
  'tar-zst-fast-direct': benchTarZstFastDirect,
  'tar-pipe': benchTarPipe,
  'tar-zst-pipe': benchTarZstPipe,
  'tar-zst-fast-pipe': benchTarZstFastPipe
};

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, 'bench-sandbox');

    if (url.pathname === '/info') {
      return Response.json(await getSourceInfo(sandbox));
    }

    if (url.pathname === '/benchmark/all') {
      const info = await getSourceInfo(sandbox);
      const results: (BenchResult | { strategy: string; error: string })[] = [];

      for (const [name, fn] of Object.entries(STRATEGIES)) {
        try {
          results.push(await fn(sandbox, env.BACKUP_BUCKET));
        } catch (err) {
          results.push({ strategy: name, error: String(err) });
        }
      }

      return Response.json({ source: info, results });
    }

    const match = url.pathname.match(/^\/benchmark\/(.+)$/);
    if (match) {
      const name = match[1];
      const fn = STRATEGIES[name];
      if (!fn) {
        return Response.json(
          {
            error: `Unknown strategy: ${name}`,
            available: Object.keys(STRATEGIES)
          },
          { status: 400 }
        );
      }
      try {
        const [info, result] = await Promise.all([
          getSourceInfo(sandbox),
          fn(sandbox, env.BACKUP_BUCKET)
        ]);
        return Response.json({ source: info, result });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    return Response.json({
      endpoints: {
        '/info': 'Source directory stats',
        '/benchmark/<strategy>': 'Run a single strategy',
        '/benchmark/all': 'Run all strategies sequentially',
        strategies: {
          chunked: {
            'tar-chunked': 'tar → split → readFile base64 → R2 multipart',
            'tar-gz-chunked': 'tar.gz → split → readFile base64 → R2 multipart',
            'tar-zst-chunked':
              'tar.zst → split → readFile base64 → R2 multipart',
            'tar-zst-fast-chunked':
              'tar.zst -1 → split → readFile base64 → R2 multipart'
          },
          streaming: {
            'tar-stream': 'tar → readFileStream SSE → R2.put',
            'tar-gz-stream': 'tar.gz → readFileStream SSE → R2.put',
            'tar-zst-stream': 'tar.zst → readFileStream SSE → R2.put',
            'tar-zst-fast-stream': 'tar.zst -1 → readFileStream SSE → R2.put'
          },
          direct: {
            'tar-direct': 'tar → containerFetch raw binary → R2.put',
            'tar-gz-direct': 'tar.gz → containerFetch raw binary → R2.put',
            'tar-zst-direct': 'tar.zst → containerFetch raw binary → R2.put',
            'tar-zst-fast-direct':
              'tar.zst -1 → containerFetch raw binary → R2.put'
          },
          pipe: {
            'tar-pipe':
              'tar piped → containerFetch → R2 multipart (no intermediate file)',
            'tar-zst-pipe':
              'tar|zstd piped → containerFetch → R2 multipart (no intermediate file)',
            'tar-zst-fast-pipe':
              'tar|zstd -1 piped → containerFetch → R2 multipart (no intermediate file)'
          }
        }
      }
    });
  }
};
