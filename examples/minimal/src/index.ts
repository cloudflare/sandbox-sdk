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

// OverlayFS layering
const OVERLAY_BASE = '/mnt/base';
const OVERLAY_UPPER = '/mnt/upper';
const OVERLAY_WORK = '/mnt/work';
const OVERLAY_MERGED = '/mnt/merged';
const OVERLAY_R2_PREFIX = 'bench/overlay/';

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
  const r = await sandbox.exec(`stat -c%s '${path}'`);
  const size = parseInt(r.stdout.trim(), 10);
  if (Number.isNaN(size)) {
    const check = await sandbox.exec(`ls -la '${path}' 2>&1`);
    throw new Error(
      `stat failed for ${path}: stdout=${JSON.stringify(r.stdout)}, stderr=${JSON.stringify(r.stderr)}, ls=${check.stdout.trim()}`
    );
  }
  return size;
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

function generatePresignedPutUrl(
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
    .sign(new Request(r2Url, { method: 'PUT' }), {
      aws: { signQuery: true }
    })
    .then((signed) => signed.url.toString());
}

interface PresignedBackupResult {
  strategy: string;
  type: 'backup';
  method: 'presigned-put';
  steps: {
    archiveMs: number;
    uploadMs: number;
  };
  totalMs: number;
  archiveBytes: number;
  archiveMB: number;
}

async function presignedPutBackup(
  sandbox: SandboxInstance,
  env: Env,
  strategy: string,
  archiveCmd: string,
  archivePath: string,
  r2Key: string
): Promise<PresignedBackupResult> {
  await ensureTmpDir(sandbox);

  const { ms: archiveMs, result: archiveRes } = await timed(() =>
    sandbox.exec(archiveCmd, { timeout: ARCHIVE_TIMEOUT })
  );
  if (!archiveRes.success)
    throw new Error(`${strategy} archive failed: ${archiveRes.stderr}`);

  const archiveBytes = await getFileSize(sandbox, archivePath);
  const putUrl = await generatePresignedPutUrl(env, r2Key);

  const { ms: uploadMs, result: uploadRes } = await timed(() =>
    sandbox.exec(
      `curl -s -w '\\n%{http_code}' -X PUT --data-binary @${archivePath} '${putUrl}'`,
      { timeout: ARCHIVE_TIMEOUT }
    )
  );
  const lines = uploadRes.stdout.trim().split('\n');
  const httpCode = lines[lines.length - 1];
  if (!uploadRes.success || (httpCode !== '200' && httpCode !== '201'))
    throw new Error(
      `${strategy} presigned PUT failed (HTTP ${httpCode}): ${uploadRes.stdout} ${uploadRes.stderr}`
    );

  await cleanupTmp(sandbox);

  return {
    strategy,
    type: 'backup',
    method: 'presigned-put',
    steps: { archiveMs: round(archiveMs), uploadMs: round(uploadMs) },
    totalMs: round(archiveMs + uploadMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes)
  };
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

function aria2cCmd(url: string, outPath: string): string {
  const lastSlash = outPath.lastIndexOf('/');
  const dir = outPath.substring(0, lastSlash);
  const file = outPath.substring(lastSlash + 1);
  return `aria2c -x4 -s4 --min-split-size=10M --file-allocation=none --allow-overwrite=true -d ${dir} -o ${file} '${url}' 2>&1`;
}

async function presignedDownloadAndMount(
  sandbox: SandboxInstance,
  env: Env,
  strategy: string,
  r2Key: string,
  opts: {
    downloadCmd: (url: string, outPath: string) => string;
    mountCmd: (archivePath: string, mountDir: string) => string;
    unmountCmd?: string;
  }
): Promise<PresignedRestoreResult> {
  const url = await generatePresignedGetUrl(env, r2Key);
  const archivePath = `${TMP_DIR}/restore.squashfs`;

  await sandbox.exec(
    `rm -rf ${RESTORE_DIR} ${TMP_DIR} && mkdir -p ${RESTORE_DIR} ${TMP_DIR}`
  );

  const { ms: downloadMs, result: dlRes } = await timed(() =>
    sandbox.exec(opts.downloadCmd(url, archivePath), {
      timeout: ARCHIVE_TIMEOUT
    })
  );
  if (!dlRes.success)
    throw new Error(`${strategy} download failed: ${dlRes.stderr}`);

  const archiveBytes = await getFileSize(sandbox, archivePath);

  const { ms: restoreMs, result: mountRes } = await timed(() =>
    sandbox.exec(opts.mountCmd(archivePath, RESTORE_DIR), { timeout: 30_000 })
  );
  if (!mountRes.success)
    throw new Error(`${strategy} mount failed: ${mountRes.stderr}`);

  const countRes = await sandbox.exec(`find ${RESTORE_DIR} -type f | wc -l`);
  const unmount =
    opts.unmountCmd ??
    `umount ${RESTORE_DIR} 2>/dev/null || fusermount -u ${RESTORE_DIR} 2>/dev/null || true`;
  await sandbox.exec(unmount);
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

interface FuseOverlayRestoreResult {
  strategy: string;
  type: 'restore';
  method: 'presigned-fuse-overlayfs';
  steps: {
    downloadMs: number;
    squashfuseMountMs: number;
    fuseOverlayMountMs: number;
  };
  totalMs: number;
  archiveBytes: number;
  archiveMB: number;
  fileCount: number;
  writeTestMs?: number;
}

async function presignedFuseOverlayfsRestore(
  sandbox: SandboxInstance,
  env: Env,
  r2Key: string
): Promise<FuseOverlayRestoreResult> {
  const url = await generatePresignedGetUrl(env, r2Key);
  const archivePath = `${TMP_DIR}/restore.squashfs`;
  const fuseLower = `${TMP_DIR}/fuse-lower`;
  const fuseUpper = `${TMP_DIR}/fuse-upper`;
  const fuseWork = `${TMP_DIR}/fuse-work`;

  await sandbox.exec(
    [
      `fusermount -u ${RESTORE_DIR} 2>/dev/null || true`,
      `fusermount -u ${TMP_DIR}/fuse-lower 2>/dev/null || true`,
      `rm -rf ${RESTORE_DIR} ${TMP_DIR}`,
      `mkdir -p ${RESTORE_DIR} ${TMP_DIR} ${fuseLower} ${fuseUpper} ${fuseWork}`
    ].join(' ; ')
  );

  const { ms: downloadMs, result: dlRes } = await timed(() =>
    sandbox.exec(`curl -sf '${url}' -o ${archivePath}`, {
      timeout: ARCHIVE_TIMEOUT
    })
  );
  if (!dlRes.success)
    throw new Error(`fuse-overlayfs download failed: ${dlRes.stderr}`);

  const archiveBytes = await getFileSize(sandbox, archivePath);

  await sandbox.exec('echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true');

  const { ms: squashfuseMountMs, result: sfRes } = await timed(() =>
    sandbox.exec(`squashfuse ${archivePath} ${fuseLower}`, { timeout: 30_000 })
  );
  if (!sfRes.success)
    throw new Error(`squashfuse mount failed: ${sfRes.stderr}`);

  const { ms: fuseOverlayMountMs, result: foRes } = await timed(() =>
    sandbox.exec(
      `fuse-overlayfs -o lowerdir=${fuseLower},upperdir=${fuseUpper},workdir=${fuseWork} ${RESTORE_DIR}`,
      { timeout: 30_000 }
    )
  );
  if (!foRes.success)
    throw new Error(`fuse-overlayfs mount failed: ${foRes.stderr}`);

  const countRes = await sandbox.exec(`find ${RESTORE_DIR} -type f | wc -l`);

  const { ms: writeTestMs } = await timed(() =>
    sandbox.exec(
      `dd if=/dev/zero of=${RESTORE_DIR}/__write_test bs=1M count=10 2>/dev/null && rm -f ${RESTORE_DIR}/__write_test`
    )
  );

  await sandbox.exec(
    [
      `fusermount -u ${RESTORE_DIR} 2>/dev/null || true`,
      `fusermount -u ${fuseLower} 2>/dev/null || true`,
      `rm -rf ${RESTORE_DIR} ${TMP_DIR}`
    ].join(' ; ')
  );

  return {
    strategy: 'presigned-fuse-overlayfs-mount',
    type: 'restore',
    method: 'presigned-fuse-overlayfs',
    steps: {
      downloadMs: round(downloadMs),
      squashfuseMountMs: round(squashfuseMountMs),
      fuseOverlayMountMs: round(fuseOverlayMountMs)
    },
    totalMs: round(downloadMs + squashfuseMountMs + fuseOverlayMountMs),
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes),
    fileCount: parseInt(countRes.stdout.trim(), 10),
    writeTestMs: round(writeTestMs)
  };
}

// ===========================================================================
// OVERLAY FILESYSTEM BENCHMARKS
// ===========================================================================

interface OverlaySetupResult {
  baseDownloadMs: number;
  baseMountMs: number;
  overlayMountMs: number;
  totalMs: number;
}

interface OverlaySimulateResult {
  size: string;
  description: string;
  durationMs: number;
  upperDirBytes: number;
  upperDirMB: number;
  upperFileCount: number;
}

interface OverlayStatusResult {
  mounted: boolean;
  upperDirBytes: number;
  upperDirMB: number;
  upperFileCount: number;
  mergedFileCount: number;
}

interface OverlayDeltaBackupResult {
  upperDirBytes: number;
  upperDirMB: number;
  upperFileCount: number;
  archiveBytes: number;
  archiveMB: number;
  archiveMs: number;
  uploadMs: number;
  totalMs: number;
  r2Key: string;
}

interface OverlayRestoreResult {
  baseDownloadMs: number;
  baseMountMs: number;
  deltaDownloadMs: number;
  deltaExtractMs: number;
  overlayMountMs: number;
  totalMs: number;
  mergedFileCount: number;
  deltaR2Key: string;
}

interface OverlayLifecycleResult {
  setup: OverlaySetupResult;
  simulate: OverlaySimulateResult;
  backup: OverlayDeltaBackupResult;
  restore: OverlayRestoreResult;
}

async function overlayTeardown(sandbox: SandboxInstance): Promise<void> {
  await sandbox.exec(
    [
      `umount ${OVERLAY_MERGED} 2>/dev/null || true`,
      `fusermount -u ${OVERLAY_BASE} 2>/dev/null || true`,
      `umount ${OVERLAY_BASE} 2>/dev/null || true`,
      `rm -rf ${OVERLAY_UPPER} ${OVERLAY_WORK} ${OVERLAY_MERGED}`,
      `mkdir -p ${OVERLAY_BASE} ${OVERLAY_UPPER} ${OVERLAY_WORK} ${OVERLAY_MERGED} ${TMP_DIR}`
    ].join(' ; '),
    { timeout: 10_000 }
  );
}

async function overlaySetup(
  sandbox: SandboxInstance,
  env: Env
): Promise<OverlaySetupResult> {
  await overlayTeardown(sandbox);

  const baseUrl = await generatePresignedGetUrl(
    env,
    'bench/squashfs/snapshot-zstd.squashfs'
  );

  const { ms: baseDownloadMs, result: dlRes } = await timed(() =>
    sandbox.exec(`curl -sf '${baseUrl}' -o ${TMP_DIR}/base.squashfs`, {
      timeout: ARCHIVE_TIMEOUT
    })
  );
  if (!dlRes.success) throw new Error(`Base download failed: ${dlRes.stderr}`);

  const { ms: baseMountMs, result: mRes } = await timed(() =>
    sandbox.exec(`squashfuse ${TMP_DIR}/base.squashfs ${OVERLAY_BASE}`)
  );
  if (!mRes.success) throw new Error(`squashfuse failed: ${mRes.stderr}`);

  const { ms: overlayMountMs, result: oRes } = await timed(() =>
    sandbox.exec(
      `mount -t overlay overlay -o lowerdir=${OVERLAY_BASE},upperdir=${OVERLAY_UPPER},workdir=${OVERLAY_WORK} ${OVERLAY_MERGED}`
    )
  );
  if (!oRes.success) throw new Error(`overlay mount failed: ${oRes.stderr}`);

  const total = round(baseDownloadMs + baseMountMs + overlayMountMs);
  return {
    baseDownloadMs: round(baseDownloadMs),
    baseMountMs: round(baseMountMs),
    overlayMountMs: round(overlayMountMs),
    totalMs: total
  };
}

type SimulateSize = 'small' | 'medium' | 'large';

async function overlaySimulate(
  sandbox: SandboxInstance,
  size: SimulateSize
): Promise<OverlaySimulateResult> {
  const dir = `${OVERLAY_MERGED}/__overlay_test`;
  let cmd: string;
  let desc: string;

  switch (size) {
    case 'small':
      cmd = [
        `for f in $(find ${OVERLAY_MERGED} -name '*.ts' -type f | head -5); do echo '// overlay-mod' >> "$f"; done`,
        `mkdir -p ${dir}`,
        `for i in $(seq 1 10); do dd if=/dev/urandom of=${dir}/s_$i.bin bs=10K count=1 2>/dev/null; done`
      ].join(' && ');
      desc = '5 modified .ts files + 10 new 10KB files (~100KB delta)';
      break;
    case 'medium':
      cmd = [
        `for f in $(find ${OVERLAY_MERGED} -name '*.json' -type f | head -10); do echo '{}' >> "$f"; done`,
        `mkdir -p ${dir}`,
        `for i in $(seq 1 50); do dd if=/dev/urandom of=${dir}/m_$i.bin bs=200K count=1 2>/dev/null; done`
      ].join(' && ');
      desc = '10 modified .json files + 50 new 200KB files (~10MB delta)';
      break;
    case 'large':
      cmd = [
        `for f in $(find ${OVERLAY_MERGED} -name '*.ts' -type f | head -50); do echo '// bulk-mod' >> "$f"; done`,
        `mkdir -p ${dir}`,
        `for i in $(seq 1 100); do dd if=/dev/urandom of=${dir}/l_$i.bin bs=1M count=1 2>/dev/null; done`
      ].join(' && ');
      desc = '50 modified .ts files + 100 new 1MB files (~100MB delta)';
      break;
  }

  const { ms } = await timed(() => sandbox.exec(cmd, { timeout: 60_000 }));

  const sizeRes = await sandbox.exec(`du -sb ${OVERLAY_UPPER} | cut -f1`);
  const countRes = await sandbox.exec(`find ${OVERLAY_UPPER} -type f | wc -l`);
  const upperBytes = parseInt(sizeRes.stdout.trim(), 10);

  return {
    size,
    description: desc,
    durationMs: round(ms),
    upperDirBytes: upperBytes,
    upperDirMB: bytesToMB(upperBytes),
    upperFileCount: parseInt(countRes.stdout.trim(), 10)
  };
}

async function overlayStatus(
  sandbox: SandboxInstance
): Promise<OverlayStatusResult> {
  const mountCheck = await sandbox.exec(
    `mount | grep ${OVERLAY_MERGED} | head -1`
  );
  const mounted = mountCheck.stdout.trim().length > 0;

  if (!mounted) {
    return {
      mounted: false,
      upperDirBytes: 0,
      upperDirMB: 0,
      upperFileCount: 0,
      mergedFileCount: 0
    };
  }

  const [sizeRes, upperCountRes, mergedCountRes] = await Promise.all([
    sandbox.exec(`du -sb ${OVERLAY_UPPER} | cut -f1`),
    sandbox.exec(`find ${OVERLAY_UPPER} -type f | wc -l`),
    sandbox.exec(`find ${OVERLAY_MERGED} -type f | wc -l`)
  ]);
  const upperBytes = parseInt(sizeRes.stdout.trim(), 10);

  return {
    mounted: true,
    upperDirBytes: upperBytes,
    upperDirMB: bytesToMB(upperBytes),
    upperFileCount: parseInt(upperCountRes.stdout.trim(), 10),
    mergedFileCount: parseInt(mergedCountRes.stdout.trim(), 10)
  };
}

async function overlayBackupDelta(
  sandbox: SandboxInstance,
  env: Env,
  deltaName: string
): Promise<OverlayDeltaBackupResult> {
  const sizeRes = await sandbox.exec(`du -sb ${OVERLAY_UPPER} | cut -f1`);
  const countRes = await sandbox.exec(`find ${OVERLAY_UPPER} -type f | wc -l`);
  const upperDirBytes = parseInt(sizeRes.stdout.trim(), 10);
  const upperFileCount = parseInt(countRes.stdout.trim(), 10);

  const archivePath = `${TMP_DIR}/delta.tar.zst`;
  const { ms: archiveMs, result: archRes } = await timed(() =>
    sandbox.exec(
      `rm -f ${archivePath} && tar -C ${OVERLAY_UPPER} -cf - . | zstd -T0 -o ${archivePath}`,
      { timeout: ARCHIVE_TIMEOUT }
    )
  );
  if (!archRes.success)
    throw new Error(`Delta archive failed: ${archRes.stderr}`);

  const archiveBytes = await getFileSize(sandbox, archivePath);
  const r2Key = `${OVERLAY_R2_PREFIX}${deltaName}.tar.zst`;

  await sandbox.exec(
    `bun -e "Bun.serve({port:${SERVE_PORT},fetch:()=>new Response(Bun.file('${archivePath}'))})" &>/dev/null &`,
    { timeout: 5_000 }
  );
  await sandbox.exec('sleep 0.3');

  const { ms: uploadMs } = await timed(async () => {
    const resp = await sandbox.containerFetch(
      new Request(`http://localhost:${SERVE_PORT}/`),
      SERVE_PORT
    );
    if (!resp.ok) throw new Error(`containerFetch failed: ${resp.status}`);
    if (!resp.body) throw new Error('No response body');

    const fixed = new FixedLengthStream(archiveBytes);
    const pump = (async () => {
      const writer = fixed.writable.getWriter();
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

    await Promise.all([
      env.BACKUP_BUCKET.put(r2Key, fixed.readable, {
        httpMetadata: { contentType: 'application/zstd' }
      }),
      pump
    ]);
  });

  await killPort(sandbox, SERVE_PORT);

  return {
    upperDirBytes,
    upperDirMB: bytesToMB(upperDirBytes),
    upperFileCount,
    archiveBytes,
    archiveMB: bytesToMB(archiveBytes),
    archiveMs: round(archiveMs),
    uploadMs: round(uploadMs),
    totalMs: round(archiveMs + uploadMs),
    r2Key
  };
}

async function overlayRestoreFull(
  sandbox: SandboxInstance,
  env: Env,
  deltaR2Key: string
): Promise<OverlayRestoreResult> {
  await overlayTeardown(sandbox);

  const [baseUrl, deltaUrl] = await Promise.all([
    generatePresignedGetUrl(env, 'bench/squashfs/snapshot-zstd.squashfs'),
    generatePresignedGetUrl(env, deltaR2Key)
  ]);

  const { ms: baseDownloadMs, result: baseDl } = await timed(() =>
    sandbox.exec(`curl -sf '${baseUrl}' -o ${TMP_DIR}/base.squashfs`, {
      timeout: ARCHIVE_TIMEOUT
    })
  );
  if (!baseDl.success)
    throw new Error(`Base download failed: ${baseDl.stderr}`);

  const { ms: baseMountMs, result: baseMount } = await timed(() =>
    sandbox.exec(`squashfuse ${TMP_DIR}/base.squashfs ${OVERLAY_BASE}`)
  );
  if (!baseMount.success)
    throw new Error(`squashfuse failed: ${baseMount.stderr}`);

  const { ms: deltaDownloadMs, result: deltaDl } = await timed(() =>
    sandbox.exec(
      `curl -sf '${deltaUrl}' | zstd -T0 -d | tar xf - -C ${OVERLAY_UPPER}`,
      { timeout: ARCHIVE_TIMEOUT }
    )
  );
  if (!deltaDl.success)
    throw new Error(`Delta restore failed: ${deltaDl.stderr}`);

  const { ms: overlayMountMs, result: oRes } = await timed(() =>
    sandbox.exec(
      `mount -t overlay overlay -o lowerdir=${OVERLAY_BASE},upperdir=${OVERLAY_UPPER},workdir=${OVERLAY_WORK} ${OVERLAY_MERGED}`
    )
  );
  if (!oRes.success) throw new Error(`Overlay mount failed: ${oRes.stderr}`);

  const countRes = await sandbox.exec(`find ${OVERLAY_MERGED} -type f | wc -l`);

  return {
    baseDownloadMs: round(baseDownloadMs),
    baseMountMs: round(baseMountMs),
    deltaDownloadMs: round(deltaDownloadMs),
    deltaExtractMs: 0,
    overlayMountMs: round(overlayMountMs),
    totalMs: round(
      baseDownloadMs + baseMountMs + deltaDownloadMs + overlayMountMs
    ),
    mergedFileCount: parseInt(countRes.stdout.trim(), 10),
    deltaR2Key
  };
}

async function overlayLifecycle(
  sandbox: SandboxInstance,
  env: Env,
  simulateSize: SimulateSize
): Promise<OverlayLifecycleResult> {
  const setup = await overlaySetup(sandbox, env);
  const simulate = await overlaySimulate(sandbox, simulateSize);
  const backup = await overlayBackupDelta(
    sandbox,
    env,
    `lifecycle-${simulateSize}`
  );

  await overlayTeardown(sandbox);
  await sandbox.exec(
    'sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true',
    { timeout: 10_000 }
  );

  const restore = await overlayRestoreFull(sandbox, env, backup.r2Key);

  await overlayTeardown(sandbox);

  return { setup, simulate, backup, restore };
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
  | OverlayResult
  | PresignedBackupResult;

type AnyRestoreResult =
  | RestoreResult
  | RestorePipeResult
  | RestoreSquashfsResult
  | PresignedRestoreResult
  | FuseOverlayRestoreResult;

type BenchResult = BackupResult | AnyRestoreResult;

// --- Backup strategies ---

const BACKUP_STRATEGIES: Record<
  string,
  {
    fn: (s: SandboxInstance, b: R2Bucket, env: Env) => Promise<BackupResult>;
    desc: string;
    needsR2Creds?: boolean;
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
  'squashfs-lz4': {
    fn: (s, b) =>
      squashfsDirectBackup(
        s,
        b,
        'squashfs-lz4',
        'lz4',
        'bench/squashfs/snapshot-lz4.squashfs'
      ),
    desc: 'mksquashfs -comp lz4 → containerFetch → R2.put'
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
  'presigned-squashfs-zstd': {
    fn: (s, _b, env) =>
      presignedPutBackup(
        s,
        env,
        'presigned-squashfs-zstd',
        `mksquashfs ${SRC_DIR} ${TMP_DIR}/backup.squashfs -comp zstd -no-progress`,
        `${TMP_DIR}/backup.squashfs`,
        'bench/presigned/snapshot-zstd.squashfs'
      ),
    desc: 'mksquashfs -comp zstd → curl presigned PUT → R2 direct',
    needsR2Creds: true
  },
  'presigned-squashfs-lz4': {
    fn: (s, _b, env) =>
      presignedPutBackup(
        s,
        env,
        'presigned-squashfs-lz4',
        `mksquashfs ${SRC_DIR} ${TMP_DIR}/backup.squashfs -comp lz4 -no-progress`,
        `${TMP_DIR}/backup.squashfs`,
        'bench/presigned/snapshot-lz4.squashfs'
      ),
    desc: 'mksquashfs -comp lz4 → curl presigned PUT → R2 direct',
    needsR2Creds: true
  },
  'presigned-tar-zst': {
    fn: (s, _b, env) =>
      presignedPutBackup(
        s,
        env,
        'presigned-tar-zst',
        `tar -C ${SRC_DIR} -cf - . | zstd -T0 -o ${TMP_DIR}/backup.tar.zst`,
        `${TMP_DIR}/backup.tar.zst`,
        'bench/presigned/snapshot.tar.zst'
      ),
    desc: 'tar+zstd → curl presigned PUT → R2 direct',
    needsR2Creds: true
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
  },
  'presigned-squashfs-mount-aria2c': {
    fn: (s, env) =>
      presignedDownloadAndMount(
        s,
        env,
        'presigned-squashfs-mount-aria2c',
        'bench/squashfs/snapshot-zstd.squashfs',
        {
          downloadCmd: (url, out) => aria2cCmd(url, out),
          mountCmd: (arch, dir) => `mount -t squashfs ${arch} ${dir} -o ro`
        }
      ),
    desc: 'R2 presigned → aria2c 4-conn → mount squashfs-zstd',
    needsR2Creds: true
  },
  'presigned-squashfs-lz4-mount': {
    fn: (s, env) =>
      presignedDownloadAndMount(
        s,
        env,
        'presigned-squashfs-lz4-mount',
        'bench/squashfs/snapshot-lz4.squashfs',
        {
          downloadCmd: (url, out) => `curl -sf '${url}' -o ${out}`,
          mountCmd: (arch, dir) => `mount -t squashfs ${arch} ${dir} -o ro`
        }
      ),
    desc: 'R2 presigned → curl → mount squashfs-lz4',
    needsR2Creds: true
  },
  'presigned-squashfs-lz4-mount-aria2c': {
    fn: (s, env) =>
      presignedDownloadAndMount(
        s,
        env,
        'presigned-squashfs-lz4-mount-aria2c',
        'bench/squashfs/snapshot-lz4.squashfs',
        {
          downloadCmd: (url, out) => aria2cCmd(url, out),
          mountCmd: (arch, dir) => `mount -t squashfs ${arch} ${dir} -o ro`
        }
      ),
    desc: 'R2 presigned → aria2c 4-conn → mount squashfs-lz4',
    needsR2Creds: true
  },
  'presigned-tar-zst1-pipe': {
    fn: (s, env) =>
      presignedRestoreTarZstPipe(
        s,
        env,
        'presigned-tar-zst1-pipe',
        'bench/direct/snapshot-fast.tar.zst'
      ),
    desc: 'R2 presigned → curl | zstd -d | tar xf (zstd -1 archive)',
    needsR2Creds: true
  },
  'presigned-squashfuse-mount': {
    fn: (s, env) =>
      presignedDownloadAndMount(
        s,
        env,
        'presigned-squashfuse-mount',
        'bench/squashfs/snapshot-zstd.squashfs',
        {
          downloadCmd: (url, out) => `curl -sf '${url}' -o ${out}`,
          mountCmd: (arch, dir) => `squashfuse ${arch} ${dir}`,
          unmountCmd: `fusermount -u ${RESTORE_DIR} 2>/dev/null || true`
        }
      ),
    desc: 'R2 presigned → curl → squashfuse FUSE mount',
    needsR2Creds: true
  },
  'presigned-fuse-overlayfs-mount': {
    fn: (s, env) =>
      presignedFuseOverlayfsRestore(
        s,
        env,
        'bench/squashfs/snapshot-zstd.squashfs'
      ),
    desc: 'R2 presigned → curl → squashfuse + fuse-overlayfs writable (PR #396 approach)',
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

    if (url.pathname === '/cleanup') {
      await sandbox.destroy();
      return Response.json({ destroyed: true });
    }

    if (url.pathname === '/probe') {
      const probeCmd = [
        'echo "=== Kernel ===" && uname -r',
        'echo "=== Filesystems ===" && cat /proc/filesystems',
        'echo "=== EROFS ===" && (modprobe erofs 2>&1 && echo "EROFS: OK" || echo "EROFS: FAIL")',
        'echo "=== FUSE ===" && (ls -la /dev/fuse 2>&1 || echo "/dev/fuse: NOT FOUND")',
        'echo "=== Tools ===" && which aria2c squashfuse curl zstd mksquashfs 2>&1',
        'echo "=== squashfs compressors ===" && mksquashfs --help 2>&1 | grep -A20 "Compressors available" || true'
      ].join(' && ');
      const result = await sandbox.exec(probeCmd, { timeout: 30_000 });
      return new Response(
        result.stdout +
          (result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''),
        { headers: { 'Content-Type': 'text/plain' } }
      );
    }

    // --- Run all backups ---
    if (url.pathname === '/backup/all') {
      const info = await getSourceInfo(sandbox);
      const results: (BackupResult | { strategy: string; error: string })[] =
        [];

      for (const [name, { fn }] of Object.entries(BACKUP_STRATEGIES)) {
        try {
          results.push(await fn(sandbox, env.BACKUP_BUCKET, env));
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
          backupResults.push(await fn(sandbox, env.BACKUP_BUCKET, env));
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
          entry.fn(sandbox, env.BACKUP_BUCKET, env)
        ]);
        return Response.json({ source: info, result });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    // --- Single restore ---
    // ?runs=N          → run N times (max 10), report stats
    // ?isolated=true   → fresh sandbox per run (true cold start)
    // default          → shared sandbox with page-cache drops between runs
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

      const runs = Math.min(
        Math.max(parseInt(url.searchParams.get('runs') ?? '1', 10) || 1, 1),
        10
      );
      const isolated = url.searchParams.get('isolated') === 'true';

      try {
        const results: (AnyRestoreResult & {
          startupMs?: number;
          sandboxId?: string;
        })[] = [];

        for (let i = 0; i < runs; i++) {
          if (isolated) {
            const freshId = `bench-iso-${name}-${Date.now()}-${i}`;
            const freshSandbox = getSandbox(env.Sandbox, freshId);
            const { ms: startupMs } = await timed(() =>
              freshSandbox.exec('echo ready', { timeout: 120_000 })
            );
            const result = await entry.fn(freshSandbox, env);
            results.push({
              ...result,
              startupMs: round(startupMs),
              sandboxId: freshId
            });
          } else {
            if (i > 0) {
              await sandbox.exec(
                'sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null; rm -rf /tmp/bench /tmp/restore',
                { timeout: 10_000 }
              );
            }
            results.push(await entry.fn(sandbox, env));
          }
        }

        if (runs === 1) {
          return Response.json({ result: results[0] });
        }

        const totals = results.map((r) => r.totalMs).sort((a, b) => a - b);
        const median =
          totals.length % 2 === 1
            ? totals[Math.floor(totals.length / 2)]
            : round(
                (totals[totals.length / 2 - 1] + totals[totals.length / 2]) / 2
              );

        const resp: Record<string, unknown> = {
          runs,
          isolated,
          results,
          stats: {
            medianMs: median,
            minMs: totals[0],
            maxMs: totals[totals.length - 1]
          }
        };

        if (isolated) {
          const startups = results
            .map((r) => r.startupMs ?? 0)
            .sort((a, b) => a - b);
          resp.startupStats = {
            medianMs:
              startups.length % 2 === 1
                ? startups[Math.floor(startups.length / 2)]
                : round(
                    (startups[startups.length / 2 - 1] +
                      startups[startups.length / 2]) /
                      2
                  ),
            minMs: startups[0],
            maxMs: startups[startups.length - 1]
          };
        }

        return Response.json(resp);
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    // --- Overlay filesystem endpoints ---
    const overlayMatch = url.pathname.match(/^\/overlay\/(.+)$/);
    if (overlayMatch) {
      const action = overlayMatch[1];
      try {
        switch (action) {
          case 'setup': {
            const result = await overlaySetup(sandbox, env);
            return Response.json({ action: 'setup', result });
          }
          case 'simulate': {
            const size = (url.searchParams.get('size') ??
              'medium') as SimulateSize;
            if (!['small', 'medium', 'large'].includes(size)) {
              return Response.json(
                {
                  error: `Invalid size: ${size}`,
                  available: ['small', 'medium', 'large']
                },
                { status: 400 }
              );
            }
            const result = await overlaySimulate(sandbox, size);
            return Response.json({ action: 'simulate', result });
          }
          case 'status': {
            const result = await overlayStatus(sandbox);
            return Response.json({ action: 'status', result });
          }
          case 'backup-delta': {
            const name = url.searchParams.get('name') ?? `delta-${Date.now()}`;
            const result = await overlayBackupDelta(sandbox, env, name);
            return Response.json({ action: 'backup-delta', result });
          }
          case 'restore': {
            const r2Key = url.searchParams.get('key');
            if (!r2Key) {
              return Response.json(
                { error: 'Missing ?key= parameter (R2 key for delta archive)' },
                { status: 400 }
              );
            }
            const runs = Math.min(
              Math.max(
                parseInt(url.searchParams.get('runs') ?? '1', 10) || 1,
                1
              ),
              10
            );
            const results: OverlayRestoreResult[] = [];
            for (let i = 0; i < runs; i++) {
              if (i > 0) {
                await sandbox.exec(
                  'sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true',
                  { timeout: 10_000 }
                );
              }
              results.push(await overlayRestoreFull(sandbox, env, r2Key));
            }
            if (runs === 1) {
              return Response.json({ action: 'restore', result: results[0] });
            }
            const totals = results.map((r) => r.totalMs).sort((a, b) => a - b);
            const median =
              totals.length % 2 === 1
                ? totals[Math.floor(totals.length / 2)]
                : round(
                    (totals[totals.length / 2 - 1] +
                      totals[totals.length / 2]) /
                      2
                  );
            return Response.json({
              action: 'restore',
              runs,
              results,
              stats: {
                medianMs: median,
                minMs: totals[0],
                maxMs: totals[totals.length - 1]
              }
            });
          }
          case 'teardown': {
            await overlayTeardown(sandbox);
            return Response.json({ action: 'teardown', ok: true });
          }
          case 'lifecycle': {
            const size = (url.searchParams.get('size') ??
              'medium') as SimulateSize;
            if (!['small', 'medium', 'large'].includes(size)) {
              return Response.json(
                {
                  error: `Invalid size: ${size}`,
                  available: ['small', 'medium', 'large']
                },
                { status: 400 }
              );
            }
            const result = await overlayLifecycle(sandbox, env, size);
            return Response.json({ action: 'lifecycle', result });
          }
          default:
            return Response.json(
              {
                error: `Unknown overlay action: ${action}`,
                available: [
                  'setup',
                  'simulate?size=small|medium|large',
                  'status',
                  'backup-delta?name=<name>',
                  'restore?key=<r2-key>&runs=N',
                  'teardown',
                  'lifecycle?size=small|medium|large'
                ]
              },
              { status: 400 }
            );
        }
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
            backupEntry.fn(sandbox, env.BACKUP_BUCKET, env)
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
        '/probe': 'Kernel, filesystem, and tool diagnostics',
        '/backup/<strategy>': 'Run a single backup strategy',
        '/backup/all': 'Run all backup strategies',
        '/restore/<strategy>?runs=N&isolated=true':
          'Run restore N times; isolated=true uses fresh sandbox per run',
        '/restore/all': 'Run all restore strategies',
        '/benchmark/all': 'Run all backups then all restores',
        '/benchmark/<strategy>': 'Legacy alias for /backup/<strategy>',
        '/overlay/setup': 'Mount base squashfs + overlayfs workspace',
        '/overlay/simulate?size=small|medium|large':
          'Simulate changes in overlay workspace',
        '/overlay/status': 'Show overlay delta size and file count',
        '/overlay/backup-delta?name=<name>': 'Backup overlay upper dir to R2',
        '/overlay/restore?key=<r2-key>&runs=N':
          'Full restore: base + delta + overlay mount',
        '/overlay/teardown': 'Unmount and clean up overlay',
        '/overlay/lifecycle?size=small|medium|large':
          'Full cycle: setup → simulate → backup → restore'
      },
      backup: backupDescriptions,
      restore: restoreDescriptions
    });
  }
};
