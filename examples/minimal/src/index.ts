import { getSandbox, type Sandbox, streamFile } from '@cloudflare/sandbox';
import { AwsClient } from 'aws4fetch';

export { Sandbox } from '@cloudflare/sandbox';

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
  BACKUP_BUCKET: R2Bucket;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  CLOUDFLARE_ACCOUNT_ID: string;
};

const SRC_DIR = '/workspace/sandbox-sdk';
const TMP_DIR = '/tmp/bench';
const RESTORE_DIR = '/tmp/restore';
const CHUNK_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per R2 multipart part
const ARCHIVE_TIMEOUT = 600_000; // 10 min for large archives
const READ_CONCURRENCY = 4;

const SERVE_PORT = 8080;
const PIPE_PORT = 8081;
const RESTORE_PORT = 8082;

const MULTIPART_PART_SIZE = 10 * 1024 * 1024;

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

async function killPort(sandbox: SandboxInstance, port: number): Promise<void> {
  await sandbox.exec(`pkill -9 -f '${port}' || true`);
  await sandbox.exec('sleep 0.2');
}

// ---------------------------------------------------------------------------
// BACKUP: archive → split → chunked read → R2 multipart upload
// ---------------------------------------------------------------------------

interface ChunkedUploadResult {
  strategy: string;
  type: 'backup';
  method: 'chunked';
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
    type: 'backup',
    method: 'chunked',
    chunks: chunkNames.length,
    steps: { archiveMs, splitMs, uploadMs },
    totalMs: round(archiveMs + splitMs + uploadMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes)
  };
}

// ---------------------------------------------------------------------------
// BACKUP: archive → readFileStream → streamFile → R2.put (single object)
// ---------------------------------------------------------------------------

interface StreamUploadResult {
  strategy: string;
  type: 'backup';
  method: 'stream';
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

  const { ms: streamUploadMs } = await timed(async () => {
    const sseStream = await sandbox.readFileStream(archive);
    const fixedStream = new FixedLengthStream(archiveBytes);
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
    await Promise.all([bucket.put(r2Key, fixedStream.readable), pumpPromise]);
  });

  await cleanupTmp(sandbox);

  return {
    strategy,
    type: 'backup',
    method: 'stream',
    steps: { archiveMs, streamUploadMs },
    totalMs: round(archiveMs + streamUploadMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes)
  };
}

// ---------------------------------------------------------------------------
// BACKUP: archive → Bun file server → containerFetch (raw binary) → R2.put
// ---------------------------------------------------------------------------

interface DirectFetchResult {
  strategy: string;
  type: 'backup';
  method: 'direct';
  steps: {
    archiveMs: number;
    fetchUploadMs: number;
  };
  totalMs: number;
  archiveBytes: number;
  archiveMB: number;
}

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

  await killPort(sandbox, SERVE_PORT);
  await cleanupTmp(sandbox);

  return {
    strategy,
    type: 'backup',
    method: 'direct',
    steps: { archiveMs, fetchUploadMs },
    totalMs: round(archiveMs + fetchUploadMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes)
  };
}

// ---------------------------------------------------------------------------
// BACKUP: tar|compress piped directly into HTTP response → R2 multipart
// ---------------------------------------------------------------------------

interface PipeResult {
  strategy: string;
  type: 'backup';
  method: 'pipe';
  steps: {
    pipeUploadMs: number;
  };
  totalMs: number;
  uploadedBytes: number;
  uploadedMB: number;
  parts: number;
}

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
  await killPort(sandbox, PIPE_PORT);
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

    const full = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      full.set(chunk, offset);
      offset += chunk.length;
    }

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

  await killPort(sandbox, PIPE_PORT);

  return {
    strategy,
    type: 'backup',
    method: 'pipe',
    steps: { pipeUploadMs },
    totalMs: round(pipeUploadMs),
    uploadedBytes,
    uploadedMB: bytesToMB(uploadedBytes),
    parts: partCount
  };
}

// ---------------------------------------------------------------------------
// BACKUP: mksquashfs → file on disk → containerFetch → R2.put
// ---------------------------------------------------------------------------

interface SquashfsDirectResult {
  strategy: string;
  type: 'backup';
  method: 'squashfs-direct';
  steps: {
    archiveMs: number;
    fetchUploadMs: number;
  };
  totalMs: number;
  archiveBytes: number;
  archiveMB: number;
}

async function squashfsDirectBackup(
  sandbox: SandboxInstance,
  bucket: R2Bucket,
  strategy: string,
  compFlag: string,
  r2Key: string
): Promise<SquashfsDirectResult> {
  await ensureTmpDir(sandbox);
  const archive = `${TMP_DIR}/backup.squashfs`;

  const { ms: archiveMs, result: archiveRes } = await timed(() =>
    sandbox.exec(
      `mksquashfs ${SRC_DIR} ${archive} -comp ${compFlag} -no-progress`,
      { timeout: ARCHIVE_TIMEOUT }
    )
  );
  if (!archiveRes.success)
    throw new Error(`${strategy} mksquashfs failed: ${archiveRes.stderr}`);

  const archiveBytes = await getFileSize(sandbox, archive);

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

  await killPort(sandbox, SERVE_PORT);
  await cleanupTmp(sandbox);

  return {
    strategy,
    type: 'backup',
    method: 'squashfs-direct',
    steps: { archiveMs, fetchUploadMs },
    totalMs: round(archiveMs + fetchUploadMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes)
  };
}

// ---------------------------------------------------------------------------
// BACKUP: mksquashfs piped to stdout → HTTP → R2 multipart
// mksquashfs supports -o (offset) but not stdout pipe — use file + stream
// Actually mksquashfs cannot pipe to stdout, so we use a two-step approach:
// mksquashfs writes to tmpfs → Bun streams the file as it's being written
// For true piping we'd need sqfstar (squashfs from tar stdin), not available
// on Ubuntu 22.04. So squashfs only gets the "direct" strategy.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// BACKUP: OverlayFS incremental — mount overlay, simulate changes, tar diff
// ---------------------------------------------------------------------------

interface OverlayResult {
  strategy: string;
  type: 'backup';
  method: 'overlay';
  steps: {
    setupMs: number;
    simulateMs: number;
    archiveMs: number;
    uploadMs: number;
  };
  totalMs: number;
  archiveBytes: number;
  archiveMB: number;
  diffFileCount: number;
}

async function overlayIncrementalBackup(
  sandbox: SandboxInstance,
  bucket: R2Bucket,
  strategy: string,
  archiveFlag: string,
  r2Key: string
): Promise<OverlayResult> {
  await ensureTmpDir(sandbox);
  const upperDir = `${TMP_DIR}/overlay-upper`;
  const workDir = `${TMP_DIR}/overlay-work`;
  const mergedDir = `${TMP_DIR}/overlay-merged`;
  const archive = `${TMP_DIR}/diff-backup`;

  const { ms: setupMs, result: setupRes } = await timed(() =>
    sandbox.exec(
      [
        `mkdir -p ${upperDir} ${workDir} ${mergedDir}`,
        `mount -t overlay overlay -o lowerdir=${SRC_DIR},upperdir=${upperDir},workdir=${workDir} ${mergedDir}`
      ].join(' && ')
    )
  );
  if (!setupRes.success)
    throw new Error(`overlay mount failed: ${setupRes.stderr}`);

  // Simulate realistic changes in the merged view (writes go to upper)
  const { ms: simulateMs, result: simRes } = await timed(() =>
    sandbox.exec(
      [
        `echo 'modified' > ${mergedDir}/README.md`,
        `mkdir -p ${mergedDir}/new-feature`,
        `dd if=/dev/urandom of=${mergedDir}/new-feature/data.bin bs=1M count=5 2>/dev/null`,
        `cp -r ${mergedDir}/packages/shared ${mergedDir}/new-feature/shared-copy 2>/dev/null || true`,
        `rm -rf ${mergedDir}/node_modules/.cache 2>/dev/null || true`
      ].join(' && '),
      { timeout: 30_000 }
    )
  );
  if (!simRes.success)
    throw new Error(`overlay simulate failed: ${simRes.stderr}`);

  const countRes = await sandbox.exec(
    `find ${upperDir} -type f 2>/dev/null | wc -l`
  );
  const diffFileCount = parseInt(countRes.stdout.trim(), 10);

  const archiveCmd = archiveFlag
    ? `tar -I '${archiveFlag}' -cf ${archive} -C ${upperDir} .`
    : `tar cf ${archive} -C ${upperDir} .`;

  const { ms: archiveMs, result: archiveRes } = await timed(() =>
    sandbox.exec(archiveCmd, { timeout: ARCHIVE_TIMEOUT })
  );
  if (!archiveRes.success)
    throw new Error(`overlay archive failed: ${archiveRes.stderr}`);

  const archiveBytes = await getFileSize(sandbox, archive);

  await sandbox.exec(
    `bun -e "Bun.serve({port: ${SERVE_PORT}, fetch: () => new Response(Bun.file('${archive}'))})" &>/dev/null &`,
    { timeout: 5000 }
  );
  await sandbox.exec('sleep 0.3');

  const { ms: uploadMs } = await timed(async () => {
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

  await killPort(sandbox, SERVE_PORT);
  await sandbox.exec(`umount ${mergedDir} 2>/dev/null || true`);
  await cleanupTmp(sandbox);

  return {
    strategy,
    type: 'backup',
    method: 'overlay',
    steps: { setupMs, simulateMs, archiveMs, uploadMs },
    totalMs: round(setupMs + simulateMs + archiveMs + uploadMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes),
    diffFileCount
  };
}

// ===========================================================================
// RESTORE BENCHMARKS
// ===========================================================================

// ---------------------------------------------------------------------------
// RESTORE: create archive in-container → time extraction
// containerFetch cannot send large request bodies (JSRPC limitation), so we
// create the archive locally and benchmark the extraction/mount step directly.
// The R2 transfer speed is ~symmetric with backup and already measured above.
// ---------------------------------------------------------------------------

interface RestoreResult {
  strategy: string;
  type: 'restore';
  steps: {
    archiveMs: number;
    extractMs: number;
  };
  totalMs: number;
  archiveBytes: number;
  archiveMB: number;
  fileCount: number;
}

async function restoreTarBenchmark(
  sandbox: SandboxInstance,
  strategy: string,
  archiveCmd: string,
  extractCmd: string
): Promise<RestoreResult> {
  await sandbox.exec(
    `rm -rf ${RESTORE_DIR} ${TMP_DIR} && mkdir -p ${RESTORE_DIR} ${TMP_DIR}`
  );
  const archive = `${TMP_DIR}/restore-archive`;

  const { ms: archiveMs, result: archiveRes } = await timed(() =>
    sandbox.exec(`${archiveCmd} ${archive} -C /workspace sandbox-sdk`, {
      timeout: ARCHIVE_TIMEOUT
    })
  );
  if (!archiveRes.success)
    throw new Error(`${strategy} archive failed: ${archiveRes.stderr}`);

  const archiveBytes = await getFileSize(sandbox, archive);

  const { ms: extractMs, result: extractRes } = await timed(() =>
    sandbox.exec(`${extractCmd} ${archive} -C ${RESTORE_DIR}`, {
      timeout: ARCHIVE_TIMEOUT
    })
  );
  if (!extractRes.success)
    throw new Error(`${strategy} extract failed: ${extractRes.stderr}`);

  const countRes = await sandbox.exec(`find ${RESTORE_DIR} -type f | wc -l`);
  await sandbox.exec(`rm -rf ${RESTORE_DIR} ${TMP_DIR}`);

  return {
    strategy,
    type: 'restore',
    steps: { archiveMs, extractMs },
    totalMs: round(archiveMs + extractMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes),
    fileCount: parseInt(countRes.stdout.trim(), 10)
  };
}

// ---------------------------------------------------------------------------
// RESTORE: pipe decompress+extract (archive piped directly into tar extract)
// ---------------------------------------------------------------------------

interface RestorePipeResult {
  strategy: string;
  type: 'restore';
  method: 'pipe';
  steps: {
    pipeExtractMs: number;
  };
  totalMs: number;
  archiveBytes: number;
  archiveMB: number;
  fileCount: number;
}

async function restoreTarPipeBenchmark(
  sandbox: SandboxInstance,
  strategy: string,
  pipeCmd: string
): Promise<RestorePipeResult> {
  await sandbox.exec(`rm -rf ${RESTORE_DIR} && mkdir -p ${RESTORE_DIR}`);

  const { ms: pipeExtractMs, result: pipeRes } = await timed(() =>
    sandbox.exec(pipeCmd, { timeout: ARCHIVE_TIMEOUT })
  );
  if (!pipeRes.success)
    throw new Error(`${strategy} pipe extract failed: ${pipeRes.stderr}`);

  const sizeRes = await sandbox.exec(`du -sb ${RESTORE_DIR} | cut -f1`);
  const archiveBytes = parseInt(sizeRes.stdout.trim(), 10);

  const countRes = await sandbox.exec(`find ${RESTORE_DIR} -type f | wc -l`);
  await sandbox.exec(`rm -rf ${RESTORE_DIR}`);

  return {
    strategy,
    type: 'restore',
    method: 'pipe',
    steps: { pipeExtractMs },
    totalMs: round(pipeExtractMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes),
    fileCount: parseInt(countRes.stdout.trim(), 10)
  };
}

// ---------------------------------------------------------------------------
// RESTORE: SquashFS — unsquashfs (extract) and mount -t squashfs (mountable)
// ---------------------------------------------------------------------------

interface RestoreSquashfsResult {
  strategy: string;
  type: 'restore';
  method: 'unsquashfs' | 'squashfs-mount';
  steps: {
    archiveMs: number;
    restoreMs: number;
  };
  totalMs: number;
  archiveBytes: number;
  archiveMB: number;
  fileCount: number;
}

async function restoreSquashfsBenchmark(
  sandbox: SandboxInstance,
  strategy: string,
  compFlag: string,
  mode: 'extract' | 'mount'
): Promise<RestoreSquashfsResult> {
  await sandbox.exec(
    `rm -rf ${RESTORE_DIR} ${TMP_DIR} && mkdir -p ${RESTORE_DIR} ${TMP_DIR}`
  );
  const archive = `${TMP_DIR}/restore.squashfs`;

  const { ms: archiveMs, result: archiveRes } = await timed(() =>
    sandbox.exec(
      `mksquashfs ${SRC_DIR} ${archive} -comp ${compFlag} -no-progress`,
      { timeout: ARCHIVE_TIMEOUT }
    )
  );
  if (!archiveRes.success)
    throw new Error(`${strategy} mksquashfs failed: ${archiveRes.stderr}`);

  const archiveBytes = await getFileSize(sandbox, archive);

  let restoreMs: number;
  if (mode === 'extract') {
    const { ms, result: res } = await timed(() =>
      sandbox.exec(`unsquashfs -d ${RESTORE_DIR}/data -f ${archive}`, {
        timeout: ARCHIVE_TIMEOUT
      })
    );
    if (!res.success) throw new Error(`unsquashfs failed: ${res.stderr}`);
    restoreMs = ms;
  } else {
    const { ms, result: res } = await timed(() =>
      sandbox.exec(`mount -t squashfs ${archive} ${RESTORE_DIR} -o ro`, {
        timeout: 30_000
      })
    );
    if (!res.success) throw new Error(`squashfs mount failed: ${res.stderr}`);
    restoreMs = ms;
  }

  const countPath = mode === 'extract' ? `${RESTORE_DIR}/data` : RESTORE_DIR;
  const countRes = await sandbox.exec(`find ${countPath} -type f | wc -l`);

  if (mode === 'mount') {
    await sandbox.exec(`umount ${RESTORE_DIR} 2>/dev/null || true`);
  }
  await sandbox.exec(`rm -rf ${RESTORE_DIR} ${TMP_DIR}`);

  return {
    strategy,
    type: 'restore',
    method: mode === 'extract' ? 'unsquashfs' : 'squashfs-mount',
    steps: { archiveMs, restoreMs },
    totalMs: round(archiveMs + restoreMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes),
    fileCount: parseInt(countRes.stdout.trim(), 10)
  };
}

// ---------------------------------------------------------------------------
// PRESIGNED URL RESTORE: R2 → container direct via presigned GET URL
// ---------------------------------------------------------------------------

interface PresignedRestoreResult {
  strategy: string;
  type: 'restore';
  method: 'presigned-curl';
  steps: {
    downloadMs: number;
    restoreMs: number;
  };
  totalMs: number;
  archiveBytes: number;
  archiveMB: number;
  fileCount: number;
}

function generatePresignedGetUrl(
  env: Env,
  r2Key: string,
  expiresSeconds = 3600
): Promise<string> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY
  });
  const r2Url = `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/sandbox-backups/${r2Key}?X-Amz-Expires=${expiresSeconds}`;
  return client
    .sign(new Request(r2Url), { aws: { signQuery: true } })
    .then((signed) => signed.url.toString());
}

async function presignedRestoreTarZst(
  sandbox: SandboxInstance,
  env: Env,
  strategy: string,
  r2Key: string
): Promise<PresignedRestoreResult> {
  const url = await generatePresignedGetUrl(env, r2Key);

  await sandbox.exec(
    `rm -rf ${RESTORE_DIR} ${TMP_DIR} && mkdir -p ${RESTORE_DIR} ${TMP_DIR}`
  );

  const { ms: downloadMs, result: dlRes } = await timed(() =>
    sandbox.exec(`curl -sf '${url}' -o ${TMP_DIR}/restore.tar.zst`, {
      timeout: ARCHIVE_TIMEOUT
    })
  );
  if (!dlRes.success)
    throw new Error(`${strategy} download failed: ${dlRes.stderr}`);

  const archiveBytes = await getFileSize(sandbox, `${TMP_DIR}/restore.tar.zst`);

  const { ms: restoreMs, result: restoreRes } = await timed(() =>
    sandbox.exec(
      `tar -I 'zstd -T0 -d' -xf ${TMP_DIR}/restore.tar.zst -C ${RESTORE_DIR}`,
      { timeout: ARCHIVE_TIMEOUT }
    )
  );
  if (!restoreRes.success)
    throw new Error(`${strategy} extract failed: ${restoreRes.stderr}`);

  const countRes = await sandbox.exec(`find ${RESTORE_DIR} -type f | wc -l`);
  await sandbox.exec(`rm -rf ${RESTORE_DIR} ${TMP_DIR}/restore.tar.zst`);

  return {
    strategy,
    type: 'restore',
    method: 'presigned-curl',
    steps: { downloadMs, restoreMs },
    totalMs: round(downloadMs + restoreMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes),
    fileCount: parseInt(countRes.stdout.trim(), 10)
  };
}

async function presignedRestoreTarZstPipe(
  sandbox: SandboxInstance,
  env: Env,
  strategy: string,
  r2Key: string
): Promise<PresignedRestoreResult> {
  const url = await generatePresignedGetUrl(env, r2Key);

  await sandbox.exec(`rm -rf ${RESTORE_DIR} && mkdir -p ${RESTORE_DIR}`);

  const { ms: downloadMs, result: dlRes } = await timed(() =>
    sandbox.exec(
      `curl -sf '${url}' | zstd -T0 -d | tar xf - -C ${RESTORE_DIR}`,
      { timeout: ARCHIVE_TIMEOUT }
    )
  );
  if (!dlRes.success)
    throw new Error(`${strategy} pipe restore failed: ${dlRes.stderr}`);

  // No separate restoreMs — download and extract are overlapped in the pipe
  const sizeRes = await sandbox.exec(`du -sb ${RESTORE_DIR} | cut -f1`);
  const archiveBytes = parseInt(sizeRes.stdout.trim(), 10);
  const countRes = await sandbox.exec(`find ${RESTORE_DIR} -type f | wc -l`);
  await sandbox.exec(`rm -rf ${RESTORE_DIR}`);

  return {
    strategy,
    type: 'restore',
    method: 'presigned-curl',
    steps: { downloadMs, restoreMs: 0 },
    totalMs: round(downloadMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes),
    fileCount: parseInt(countRes.stdout.trim(), 10)
  };
}

async function presignedRestoreSquashfsMount(
  sandbox: SandboxInstance,
  env: Env,
  strategy: string,
  r2Key: string
): Promise<PresignedRestoreResult> {
  const url = await generatePresignedGetUrl(env, r2Key);

  await sandbox.exec(
    `rm -rf ${RESTORE_DIR} ${TMP_DIR} && mkdir -p ${RESTORE_DIR} ${TMP_DIR}`
  );

  const { ms: downloadMs, result: dlRes } = await timed(() =>
    sandbox.exec(`curl -sf '${url}' -o ${TMP_DIR}/restore.squashfs`, {
      timeout: ARCHIVE_TIMEOUT
    })
  );
  if (!dlRes.success)
    throw new Error(`${strategy} download failed: ${dlRes.stderr}`);

  const archiveBytes = await getFileSize(
    sandbox,
    `${TMP_DIR}/restore.squashfs`
  );

  const { ms: restoreMs, result: mountRes } = await timed(() =>
    sandbox.exec(
      `mount -t squashfs ${TMP_DIR}/restore.squashfs ${RESTORE_DIR}`,
      { timeout: 30_000 }
    )
  );
  if (!mountRes.success)
    throw new Error(`${strategy} mount failed: ${mountRes.stderr}`);

  const countRes = await sandbox.exec(`find ${RESTORE_DIR} -type f | wc -l`);

  await sandbox.exec(`umount ${RESTORE_DIR} 2>/dev/null || true`);
  await sandbox.exec(`rm -rf ${RESTORE_DIR} ${TMP_DIR}`);

  return {
    strategy,
    type: 'restore',
    method: 'presigned-curl',
    steps: { downloadMs, restoreMs },
    totalMs: round(downloadMs + restoreMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes),
    fileCount: parseInt(countRes.stdout.trim(), 10)
  };
}

async function presignedRestoreSquashfsExtract(
  sandbox: SandboxInstance,
  env: Env,
  strategy: string,
  r2Key: string
): Promise<PresignedRestoreResult> {
  const url = await generatePresignedGetUrl(env, r2Key);

  await sandbox.exec(
    `rm -rf ${RESTORE_DIR} ${TMP_DIR} && mkdir -p ${RESTORE_DIR} ${TMP_DIR}`
  );

  const { ms: downloadMs, result: dlRes } = await timed(() =>
    sandbox.exec(`curl -sf '${url}' -o ${TMP_DIR}/restore.squashfs`, {
      timeout: ARCHIVE_TIMEOUT
    })
  );
  if (!dlRes.success)
    throw new Error(`${strategy} download failed: ${dlRes.stderr}`);

  const archiveBytes = await getFileSize(
    sandbox,
    `${TMP_DIR}/restore.squashfs`
  );

  const { ms: restoreMs, result: extractRes } = await timed(() =>
    sandbox.exec(
      `unsquashfs -d ${RESTORE_DIR}/data -f ${TMP_DIR}/restore.squashfs`,
      { timeout: ARCHIVE_TIMEOUT }
    )
  );
  if (!extractRes.success)
    throw new Error(`${strategy} unsquashfs failed: ${extractRes.stderr}`);

  const countRes = await sandbox.exec(
    `find ${RESTORE_DIR}/data -type f | wc -l`
  );
  await sandbox.exec(`rm -rf ${RESTORE_DIR} ${TMP_DIR}`);

  return {
    strategy,
    type: 'restore',
    method: 'presigned-curl',
    steps: { downloadMs, restoreMs },
    totalMs: round(downloadMs + restoreMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes),
    fileCount: parseInt(countRes.stdout.trim(), 10)
  };
}

// ===========================================================================
// STRATEGY REGISTRIES
// ===========================================================================

type BackupResult =
  | ChunkedUploadResult
  | StreamUploadResult
  | DirectFetchResult
  | PipeResult
  | SquashfsDirectResult
  | OverlayResult;

type AnyRestoreResult =
  | RestoreResult
  | RestorePipeResult
  | RestoreSquashfsResult
  | PresignedRestoreResult;

type BenchResult = BackupResult | AnyRestoreResult;

// --- Backup strategies ---

const BACKUP_STRATEGIES: Record<
  string,
  {
    fn: (s: SandboxInstance, b: R2Bucket) => Promise<BackupResult>;
    desc: string;
  }
> = {
  'tar-chunked': {
    fn: (s, b) =>
      archiveAndUpload(
        s,
        b,
        'tar-chunked',
        'tar cf',
        'bench/chunked/snapshot.tar'
      ),
    desc: 'tar → split → readFile base64 → R2 multipart'
  },
  'tar-gz-chunked': {
    fn: (s, b) =>
      archiveAndUpload(
        s,
        b,
        'tar-gz-chunked',
        'tar czf',
        'bench/chunked/snapshot.tar.gz'
      ),
    desc: 'tar.gz → split → readFile base64 → R2 multipart'
  },
  'tar-zst-chunked': {
    fn: (s, b) =>
      archiveAndUpload(
        s,
        b,
        'tar-zst-chunked',
        "tar -I 'zstd -T0' -cf",
        'bench/chunked/snapshot.tar.zst'
      ),
    desc: 'tar.zst → split → readFile base64 → R2 multipart'
  },
  'tar-zst-fast-chunked': {
    fn: (s, b) =>
      archiveAndUpload(
        s,
        b,
        'tar-zst-fast-chunked',
        "tar -I 'zstd -T0 -1' -cf",
        'bench/chunked/snapshot-fast.tar.zst'
      ),
    desc: 'tar.zst -1 → split → readFile base64 → R2 multipart'
  },
  'tar-stream': {
    fn: (s, b) =>
      archiveAndStream(
        s,
        b,
        'tar-stream',
        'tar cf',
        'bench/stream/snapshot.tar'
      ),
    desc: 'tar → readFileStream SSE → R2.put'
  },
  'tar-gz-stream': {
    fn: (s, b) =>
      archiveAndStream(
        s,
        b,
        'tar-gz-stream',
        'tar czf',
        'bench/stream/snapshot.tar.gz'
      ),
    desc: 'tar.gz → readFileStream SSE → R2.put'
  },
  'tar-zst-stream': {
    fn: (s, b) =>
      archiveAndStream(
        s,
        b,
        'tar-zst-stream',
        "tar -I 'zstd -T0' -cf",
        'bench/stream/snapshot.tar.zst'
      ),
    desc: 'tar.zst → readFileStream SSE → R2.put'
  },
  'tar-zst-fast-stream': {
    fn: (s, b) =>
      archiveAndStream(
        s,
        b,
        'tar-zst-fast-stream',
        "tar -I 'zstd -T0 -1' -cf",
        'bench/stream/snapshot-fast.tar.zst'
      ),
    desc: 'tar.zst -1 → readFileStream SSE → R2.put'
  },
  'tar-direct': {
    fn: (s, b) =>
      archiveAndDirectFetch(
        s,
        b,
        'tar-direct',
        'tar cf',
        'bench/direct/snapshot.tar'
      ),
    desc: 'tar → containerFetch raw binary → R2.put'
  },
  'tar-gz-direct': {
    fn: (s, b) =>
      archiveAndDirectFetch(
        s,
        b,
        'tar-gz-direct',
        'tar czf',
        'bench/direct/snapshot.tar.gz'
      ),
    desc: 'tar.gz → containerFetch raw binary → R2.put'
  },
  'tar-zst-direct': {
    fn: (s, b) =>
      archiveAndDirectFetch(
        s,
        b,
        'tar-zst-direct',
        "tar -I 'zstd -T0' -cf",
        'bench/direct/snapshot.tar.zst'
      ),
    desc: 'tar.zst → containerFetch raw binary → R2.put'
  },
  'tar-zst-fast-direct': {
    fn: (s, b) =>
      archiveAndDirectFetch(
        s,
        b,
        'tar-zst-fast-direct',
        "tar -I 'zstd -T0 -1' -cf",
        'bench/direct/snapshot-fast.tar.zst'
      ),
    desc: 'tar.zst -1 → containerFetch raw binary → R2.put'
  },
  'tar-pipe': {
    fn: (s, b) =>
      pipeArchiveAndUpload(
        s,
        b,
        'tar-pipe',
        `tar cf - -C /workspace sandbox-sdk`,
        'bench/pipe/snapshot.tar'
      ),
    desc: 'tar piped → containerFetch → R2 multipart'
  },
  'tar-zst-pipe': {
    fn: (s, b) =>
      pipeArchiveAndUpload(
        s,
        b,
        'tar-zst-pipe',
        `tar cf - -C /workspace sandbox-sdk | zstd -T0 -3`,
        'bench/pipe/snapshot.tar.zst'
      ),
    desc: 'tar|zstd piped → containerFetch → R2 multipart'
  },
  'tar-zst-fast-pipe': {
    fn: (s, b) =>
      pipeArchiveAndUpload(
        s,
        b,
        'tar-zst-fast-pipe',
        `tar cf - -C /workspace sandbox-sdk | zstd -T0 -1`,
        'bench/pipe/snapshot-fast.tar.zst'
      ),
    desc: 'tar|zstd -1 piped → containerFetch → R2 multipart'
  },
  'squashfs-zstd': {
    fn: (s, b) =>
      squashfsDirectBackup(
        s,
        b,
        'squashfs-zstd',
        'zstd',
        'bench/squashfs/snapshot-zstd.squashfs'
      ),
    desc: 'mksquashfs -comp zstd → containerFetch → R2.put'
  },
  'squashfs-lzo': {
    fn: (s, b) =>
      squashfsDirectBackup(
        s,
        b,
        'squashfs-lzo',
        'lzo',
        'bench/squashfs/snapshot-lzo.squashfs'
      ),
    desc: 'mksquashfs -comp lzo → containerFetch → R2.put'
  },
  'squashfs-gzip': {
    fn: (s, b) =>
      squashfsDirectBackup(
        s,
        b,
        'squashfs-gzip',
        'gzip',
        'bench/squashfs/snapshot-gzip.squashfs'
      ),
    desc: 'mksquashfs -comp gzip → containerFetch → R2.put'
  },
  'overlay-tar': {
    fn: (s, b) =>
      overlayIncrementalBackup(
        s,
        b,
        'overlay-tar',
        '',
        'bench/overlay/diff.tar'
      ),
    desc: 'overlayfs diff → tar → containerFetch → R2.put'
  },
  'overlay-tar-zst': {
    fn: (s, b) =>
      overlayIncrementalBackup(
        s,
        b,
        'overlay-tar-zst',
        'zstd -T0',
        'bench/overlay/diff.tar.zst'
      ),
    desc: 'overlayfs diff → tar|zstd → containerFetch → R2.put'
  }
};

// --- Restore strategies ---

const RESTORE_STRATEGIES: Record<
  string,
  {
    fn: (s: SandboxInstance, env: Env) => Promise<AnyRestoreResult>;
    desc: string;
    needsR2Creds?: boolean;
  }
> = {
  'restore-tar': {
    fn: (s) => restoreTarBenchmark(s, 'restore-tar', 'tar cf', 'tar xf'),
    desc: 'tar cf → tar xf (uncompressed)'
  },
  'restore-tar-zst': {
    fn: (s) =>
      restoreTarBenchmark(
        s,
        'restore-tar-zst',
        "tar -I 'zstd -T0' -cf",
        "tar -I 'zstd -T0' -xf"
      ),
    desc: 'tar+zstd cf → tar+zstd xf'
  },
  'restore-tar-gz': {
    fn: (s) => restoreTarBenchmark(s, 'restore-tar-gz', 'tar czf', 'tar xzf'),
    desc: 'tar.gz cf → tar.gz xf'
  },
  'restore-tar-zst-pipe': {
    fn: (s) =>
      restoreTarPipeBenchmark(
        s,
        'restore-tar-zst-pipe',
        `tar cf - -C /workspace sandbox-sdk | zstd -T0 | zstd -T0 -d | tar xf - -C ${RESTORE_DIR}`
      ),
    desc: 'tar | zstd | zstd -d | tar xf (compress+decompress pipeline)'
  },
  'restore-squashfs-extract': {
    fn: (s) =>
      restoreSquashfsBenchmark(
        s,
        'restore-squashfs-extract',
        'zstd',
        'extract'
      ),
    desc: 'mksquashfs → unsquashfs (full extract)'
  },
  'restore-squashfs-mount': {
    fn: (s) =>
      restoreSquashfsBenchmark(s, 'restore-squashfs-mount', 'zstd', 'mount'),
    desc: 'mksquashfs → mount -t squashfs (instant, read-only)'
  },
  'presigned-tar-zst': {
    fn: (s, env) =>
      presignedRestoreTarZst(
        s,
        env,
        'presigned-tar-zst',
        'bench/direct/snapshot.tar.zst'
      ),
    desc: 'R2 presigned URL → curl → tar xf (zstd)',
    needsR2Creds: true
  },
  'presigned-tar-zst-pipe': {
    fn: (s, env) =>
      presignedRestoreTarZstPipe(
        s,
        env,
        'presigned-tar-zst-pipe',
        'bench/direct/snapshot.tar.zst'
      ),
    desc: 'R2 presigned URL → curl | zstd -d | tar xf (piped)',
    needsR2Creds: true
  },
  'presigned-squashfs-mount': {
    fn: (s, env) =>
      presignedRestoreSquashfsMount(
        s,
        env,
        'presigned-squashfs-mount',
        'bench/squashfs/snapshot-zstd.squashfs'
      ),
    desc: 'R2 presigned URL → curl → mount -t squashfs (instant)',
    needsR2Creds: true
  },
  'presigned-squashfs-extract': {
    fn: (s, env) =>
      presignedRestoreSquashfsExtract(
        s,
        env,
        'presigned-squashfs-extract',
        'bench/squashfs/snapshot-zstd.squashfs'
      ),
    desc: 'R2 presigned URL → curl → unsquashfs',
    needsR2Creds: true
  }
};

// ===========================================================================
// Worker entry
// ===========================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, 'bench-sandbox');

    if (url.pathname === '/info') {
      return Response.json(await getSourceInfo(sandbox));
    }

    // --- Run all backups ---
    if (url.pathname === '/backup/all') {
      const info = await getSourceInfo(sandbox);
      const results: (BackupResult | { strategy: string; error: string })[] =
        [];

      for (const [name, { fn }] of Object.entries(BACKUP_STRATEGIES)) {
        try {
          results.push(await fn(sandbox, env.BACKUP_BUCKET));
        } catch (err) {
          results.push({ strategy: name, error: String(err) });
        }
      }

      return Response.json({ source: info, results });
    }

    // --- Run all restores (requires backups to exist in R2) ---
    if (url.pathname === '/restore/all') {
      const results: (
        | AnyRestoreResult
        | { strategy: string; error: string }
      )[] = [];

      for (const [name, { fn }] of Object.entries(RESTORE_STRATEGIES)) {
        try {
          results.push(await fn(sandbox, env));
        } catch (err) {
          results.push({ strategy: name, error: String(err) });
        }
      }

      return Response.json({ results });
    }

    // --- Run everything: all backups then all restores ---
    if (url.pathname === '/benchmark/all') {
      const info = await getSourceInfo(sandbox);
      const backupResults: (
        | BackupResult
        | { strategy: string; error: string }
      )[] = [];
      const restoreResults: (
        | AnyRestoreResult
        | { strategy: string; error: string }
      )[] = [];

      for (const [name, { fn }] of Object.entries(BACKUP_STRATEGIES)) {
        try {
          backupResults.push(await fn(sandbox, env.BACKUP_BUCKET));
        } catch (err) {
          backupResults.push({ strategy: name, error: String(err) });
        }
      }

      for (const [name, { fn }] of Object.entries(RESTORE_STRATEGIES)) {
        try {
          restoreResults.push(await fn(sandbox, env));
        } catch (err) {
          restoreResults.push({ strategy: name, error: String(err) });
        }
      }

      return Response.json({
        source: info,
        backup: backupResults,
        restore: restoreResults
      });
    }

    // --- Single backup ---
    const backupMatch = url.pathname.match(/^\/backup\/(.+)$/);
    if (backupMatch) {
      const name = backupMatch[1];
      const entry = BACKUP_STRATEGIES[name];
      if (!entry) {
        return Response.json(
          {
            error: `Unknown backup strategy: ${name}`,
            available: Object.keys(BACKUP_STRATEGIES)
          },
          { status: 400 }
        );
      }
      try {
        const [info, result] = await Promise.all([
          getSourceInfo(sandbox),
          entry.fn(sandbox, env.BACKUP_BUCKET)
        ]);
        return Response.json({ source: info, result });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    // --- Single restore ---
    const restoreMatch = url.pathname.match(/^\/restore\/(.+)$/);
    if (restoreMatch) {
      const name = restoreMatch[1];
      const entry = RESTORE_STRATEGIES[name];
      if (!entry) {
        return Response.json(
          {
            error: `Unknown restore strategy: ${name}`,
            available: Object.keys(RESTORE_STRATEGIES)
          },
          { status: 400 }
        );
      }
      try {
        const result = await entry.fn(sandbox, env);
        return Response.json({ result });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    // --- Legacy route for backward compat ---
    const legacyMatch = url.pathname.match(/^\/benchmark\/(.+)$/);
    if (legacyMatch) {
      const name = legacyMatch[1];
      const backupEntry = BACKUP_STRATEGIES[name];
      if (backupEntry) {
        try {
          const [info, result] = await Promise.all([
            getSourceInfo(sandbox),
            backupEntry.fn(sandbox, env.BACKUP_BUCKET)
          ]);
          return Response.json({ source: info, result });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 500 });
        }
      }
    }

    // --- Index ---
    const backupDescriptions: Record<string, Record<string, string>> = {};
    for (const [name, { desc }] of Object.entries(BACKUP_STRATEGIES)) {
      const family = name.includes('squashfs')
        ? 'squashfs'
        : name.includes('overlay')
          ? 'overlay'
          : name.includes('pipe')
            ? 'pipe'
            : name.includes('direct')
              ? 'direct'
              : name.includes('stream')
                ? 'streaming'
                : 'chunked';
      if (!backupDescriptions[family]) backupDescriptions[family] = {};
      backupDescriptions[family][name] = desc;
    }

    const restoreDescriptions: Record<string, string> = {};
    for (const [name, { desc }] of Object.entries(RESTORE_STRATEGIES)) {
      restoreDescriptions[name] = desc;
    }

    return Response.json({
      endpoints: {
        '/info': 'Source directory stats',
        '/backup/<strategy>': 'Run a single backup strategy',
        '/backup/all': 'Run all backup strategies',
        '/restore/<strategy>':
          'Run a single restore strategy (requires corresponding backup in R2)',
        '/restore/all': 'Run all restore strategies',
        '/benchmark/all': 'Run all backups then all restores',
        '/benchmark/<strategy>': 'Legacy alias for /backup/<strategy>'
      },
      backup: backupDescriptions,
      restore: restoreDescriptions
    });
  }
};
