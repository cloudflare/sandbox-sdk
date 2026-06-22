import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const sidecarDir = join(here, 'sidecar');
const outFile = join(here, 'sidecar-package.tgz');

const packageName = '@cloudflare/sandbox-interpreter-sidecar';
const binName = 'sandbox-interpreter-sidecar';

async function bundle(entrypoint: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: 'node',
    format: 'esm',
    minify: true
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Failed to bundle ${entrypoint}`);
  }
  if (result.outputs.length !== 1) {
    throw new Error(
      `Expected a single bundle for ${entrypoint}, got ${result.outputs.length}`
    );
  }
  return await result.outputs[0].text();
}

const serverSource = await bundle(join(sidecarDir, 'server.ts'));
const nodeExecutorSource = await bundle(
  join(sidecarDir, 'executors/javascript/node_executor.ts')
);
const pythonExecutorSource = await readFile(
  join(sidecarDir, 'executors/python/ipython_executor.py'),
  'utf8'
);

const version = createHash('sha1')
  .update(serverSource)
  .update(nodeExecutorSource)
  .update(pythonExecutorSource)
  .digest('hex')
  .slice(0, 12);

const packageJson = `${JSON.stringify(
  {
    name: packageName,
    version: `0.0.0-${version}`,
    type: 'module',
    bin: {
      [binName]: './dist/server.mjs'
    },
    sandboxExtension: {
      bin: binName,
      readinessTimeoutMs: 30_000
    }
  },
  null,
  2
)}\n`;

const tarball = gzipSync(
  createTarball([
    { path: 'package/package.json', content: packageJson },
    { path: 'package/dist/server.mjs', content: serverSource, mode: 0o755 },
    {
      path: 'package/dist/executors/javascript/node_executor.mjs',
      content: nodeExecutorSource,
      mode: 0o755
    },
    {
      path: 'package/dist/executors/python/ipython_executor.py',
      content: pythonExecutorSource,
      mode: 0o755
    }
  ])
);
tarball.writeUInt32LE(0, 4);

await writeFile(outFile, tarball);

console.log(
  `Wrote ${outFile}\n  version ${version} (${(tarball.length / 1024).toFixed(
    1
  )} KB)`
);

interface TarEntry {
  path: string;
  content: string | Uint8Array;
  mode?: number;
}

function createTarball(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content);
    chunks.push(createTarHeader(entry.path, body.length, entry.mode ?? 0o644));
    chunks.push(body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function createTarHeader(path: string, size: number, mode: number): Buffer {
  const header = Buffer.alloc(512);
  writeString(header, path, 0, 100);
  writeOctal(header, mode, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeString(header, 'ustar', 257, 6);
  writeString(header, '00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeOctal(header, checksum, 148, 8);
  return header;
}

function writeString(
  buffer: Buffer,
  value: string,
  offset: number,
  length: number
): void {
  buffer.write(
    value,
    offset,
    Math.min(Buffer.byteLength(value), length),
    'utf8'
  );
}

function writeOctal(
  buffer: Buffer,
  value: number,
  offset: number,
  length: number
): void {
  const text = value
    .toString(8)
    .padStart(length - 1, '0')
    .slice(0, length - 1);
  buffer.write(text, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}
