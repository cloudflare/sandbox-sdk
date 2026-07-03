import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack as createTarPack } from 'tar-stream';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, 'src');
const sidecarDir = join(srcDir, 'sidecar');
const outFile = join(srcDir, 'sidecar-package.tgz');

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
const pythonExecutorSource = await Bun.file(
  join(sidecarDir, 'executors/python/ipython_executor.py')
).text();

const version = new Bun.CryptoHasher('sha1')
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

const tarball = Bun.gzipSync(
  Uint8Array.from(
    await createTarball([
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
  )
);

await Bun.write(outFile, tarball);

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

// `mtime` is pinned to the epoch so the tarball is byte-for-byte reproducible
// for a given set of sources (the version hash is derived from the sources).
async function createTarball(entries: TarEntry[]): Promise<Buffer> {
  const tar = createTarPack();
  for (const entry of entries) {
    const body = Buffer.from(entry.content);
    tar.entry(
      { name: entry.path, mode: entry.mode ?? 0o644, mtime: new Date(0) },
      body
    );
  }
  tar.finalize();

  const chunks: Buffer[] = [];
  for await (const chunk of tar) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
