/**
 * End-to-end validation of the extension framework.
 *
 * Builds a real fixture tarball at test time, hands the bytes to
 * `ExtensionHost.connect()`, and round-trips capnweb calls through the
 * actual sidecar process.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import net, { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoOpLogger, EXTENSION_TARBALL_REQUIRED } from '@repo/shared';
import { RpcSession, RpcTarget } from 'capnweb';
import { CapnwebExtensionBridge } from '../../src/extensions/capnweb-bridge';
import { ExtensionHost } from '../../src/extensions/extension-host';
import { hashTarball } from '../../src/extensions/provision';
import { SocketTransport } from '../../src/extensions/socket-transport';

interface DemoSidecarAPI {
  echo(value: string): Promise<string>;
  env(name: string): Promise<string | undefined>;
  runJob(
    label: string,
    onEvent: (event: { kind: string; data: unknown }) => void | Promise<void>
  ): Promise<{ ok: true; label: string }>;
  fail(message: string): Promise<never>;
  __ping__(): Promise<string>;
}

class PingTarget extends RpcTarget {
  __ping__(): string {
    return 'pong';
  }
}

let tarballBytes: Uint8Array;
let packageHash: string;

const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'demo-sidecar');

beforeAll(async () => {
  // Bundle the sidecar with capnweb + SandboxSidecar helper inlined so the
  // tarball installs offline. `bun build --compile=false --target=node
  // --bundle` produces a self-contained ESM bundle.
  const distDir = join(FIXTURE_DIR, 'dist');
  const build = await Bun.build({
    entrypoints: [join(FIXTURE_DIR, 'src/sidecar.ts')],
    outdir: distDir,
    naming: 'sidecar.js',
    target: 'bun',
    format: 'esm'
  });
  if (!build.success) {
    throw new Error(
      `failed to bundle fixture sidecar:\n${build.logs.map((l) => l.message).join('\n')}`
    );
  }

  // `bun pm pack` writes the tarball into the package directory. We read
  // via Bun.file() because other tests in this suite globally mock
  // `node:fs` (see `cert.test.ts`), and bun's `mock.module` is process-wide.
  execFileSync('bun', ['pm', 'pack'], { cwd: FIXTURE_DIR, stdio: 'pipe' });
  const tarballPath = join(FIXTURE_DIR, 'demo-sidecar-1.0.0.tgz');
  tarballBytes = new Uint8Array(await Bun.file(tarballPath).arrayBuffer());
  packageHash = hashTarball(tarballBytes);
});

describe('ExtensionHost (capnweb + npm-tarball)', () => {
  let host: ExtensionHost | null = null;

  function makeHost(): ExtensionHost {
    const rootDir = mkdtempSync(join(tmpdir(), 'ext-host-test-'));
    host = new ExtensionHost(createNoOpLogger(), rootDir);
    return host;
  }

  afterEach(async () => {
    await host?.stopAll();
    host = null;
  });

  it('provisions, spawns, and round-trips a capnweb call', async () => {
    const h = makeHost();
    const stub = (await h.connect({
      packageHash,
      tarball: tarballBytes
    })) as DemoSidecarAPI;

    expect(await stub.echo('hello')).toBe('hello');
  });

  it('does not inherit arbitrary host environment variables', async () => {
    const h = makeHost();
    const envName = 'SANDBOX_EXTENSION_HOST_SECRET_TEST';
    process.env[envName] = 'hidden';

    try {
      const stub = (await h.connect({
        packageHash,
        tarball: tarballBytes
      })) as DemoSidecarAPI;
      expect(await stub.env(envName)).toBeUndefined();
      expect(typeof (await stub.env('PATH'))).toBe('string');
      expect(typeof (await stub.env('EXT_SOCKET'))).toBe('string');
      expect(typeof (await stub.env('EXT_DIR'))).toBe('string');
    } finally {
      delete process.env[envName];
    }
  });

  it('forwards a streaming callback through both capnweb hops', async () => {
    const h = makeHost();
    const stub = (await h.connect({
      packageHash,
      tarball: tarballBytes
    })) as DemoSidecarAPI;

    const events: Array<{ kind: string; data: unknown }> = [];
    const result = await stub.runJob('demo', async (event) => {
      events.push(event);
    });

    expect(result).toEqual({ ok: true, label: 'demo' });
    expect(events).toEqual([
      { kind: 'started', data: 'demo' },
      { kind: 'progress', data: 0.5 },
      { kind: 'progress', data: 1 }
    ]);
  });

  it('propagates sidecar errors across capnweb', async () => {
    const h = makeHost();
    const stub = (await h.connect({
      packageHash,
      tarball: tarballBytes
    })) as DemoSidecarAPI;

    // Wrap with Promise.resolve so bun's matcher sees a plain promise rather
    // than capnweb's `RpcPromise` proxy (which is also callable for pipelining).
    await expect(Promise.resolve(stub.fail('boom'))).rejects.toThrow(/boom/);
  });

  it('throws ExtensionTarballRequired when the host has not seen the hash and no bytes are sent', async () => {
    const h = makeHost();
    let thrown: unknown;
    try {
      await h.connect({ packageHash });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).name).toBe(EXTENSION_TARBALL_REQUIRED);
  });

  it('reuses the same provisioned dir for the second connect with the same hash', async () => {
    const h = makeHost();
    await h.connect({ packageHash, tarball: tarballBytes });

    // Second connect: hash-only, must not fail.
    const stub = (await h.connect({ packageHash })) as DemoSidecarAPI;
    expect(await stub.echo('again')).toBe('again');
  });

  it('rehydrates a provisioned extension from disk after host restart', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'ext-host-rehydrate-test-'));
    const first = new ExtensionHost(createNoOpLogger(), rootDir);
    host = first;
    await first.connect({ packageHash, tarball: tarballBytes });
    await first.stopAll();

    const second = new ExtensionHost(createNoOpLogger(), rootDir);
    host = second;
    const stub = (await second.connect({ packageHash })) as DemoSidecarAPI;
    expect(await stub.echo('rehydrated')).toBe('rehydrated');
  });

  it('serializes concurrent hash-only connects when rehydrating from disk', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'ext-host-rehydrate-race-'));
    const first = new ExtensionHost(createNoOpLogger(), rootDir);
    host = first;
    await first.connect({ packageHash, tarball: tarballBytes });
    await first.stopAll();

    const second = new ExtensionHost(createNoOpLogger(), rootDir);
    host = second;
    const [a, b, c] = await Promise.all([
      second.connect({ packageHash }),
      second.connect({ packageHash }),
      second.connect({ packageHash })
    ]);

    expect(await (a as DemoSidecarAPI).echo('a')).toBe('a');
    expect(await (b as DemoSidecarAPI).echo('b')).toBe('b');
    expect(await (c as DemoSidecarAPI).echo('c')).toBe('c');

    // A single stop() must fully tear the extension down; if a concurrent
    // connect had spawned an orphaned sidecar, the host would not track it.
    await second.stop(packageHash);
    expect((await second.health(packageHash)).running).toBe(false);
  });

  it('serializes concurrent first connects for the same hash', async () => {
    const h = makeHost();
    const [a, b, c] = await Promise.all([
      h.connect({ packageHash, tarball: tarballBytes }),
      h.connect({ packageHash, tarball: tarballBytes }),
      h.connect({ packageHash, tarball: tarballBytes })
    ]);

    expect(await (a as DemoSidecarAPI).echo('a')).toBe('a');
    expect(await (b as DemoSidecarAPI).echo('b')).toBe('b');
    expect(await (c as DemoSidecarAPI).echo('c')).toBe('c');
  });

  it('reports health with a live __ping__ once the sidecar is running', async () => {
    const h = makeHost();

    // No work until first connect.
    let health = await h.health(packageHash);
    expect(health.provisioned).toBe(false);
    expect(health.running).toBe(false);

    await h.connect({ packageHash, tarball: tarballBytes });

    health = await h.health(packageHash);
    expect(health.provisioned).toBe(true);
    expect(health.running).toBe(true);
    expect(health.responsive).toBe(true);
    expect(health.pid).toBeGreaterThan(0);
    expect(health.id).toBe('demo-sidecar');
    expect(health.version).toBe('1.0.0');
  });

  it('restarts the sidecar transparently after stop()', async () => {
    const h = makeHost();
    let stub = (await h.connect({
      packageHash,
      tarball: tarballBytes
    })) as DemoSidecarAPI;
    expect(await stub.echo('first')).toBe('first');

    await h.stop(packageHash);
    const stopped = await h.health(packageHash);
    expect(stopped.running).toBe(false);

    // Next connect must respawn (hash-only is sufficient \u2014 provisioned dir
    // is still on disk).
    stub = (await h.connect({ packageHash })) as DemoSidecarAPI;
    expect(await stub.echo('second')).toBe('second');
  });

  it('does not emit an unhandled rejection when a ready sidecar stops', async () => {
    const h = makeHost();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      await h.connect({ packageHash, tarball: tarballBytes });
      await h.stop(packageHash);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rejects a mismatched declared hash on first provision', async () => {
    const h = makeHost();
    await expect(
      h.connect({
        packageHash: '0'.repeat(64),
        tarball: tarballBytes
      })
    ).rejects.toThrow(/hash mismatch/);
  });

  // Sanity: the bundled fixture must really be installable. If this fails the
  // beforeAll didn't produce a valid tarball.
  it('produced a valid bundled fixture', async () => {
    const bundled = Bun.file(join(FIXTURE_DIR, 'dist', 'sidecar.js'));
    expect(await bundled.exists()).toBe(true);
    expect(tarballBytes.length).toBeGreaterThan(1024);
    expect(packageHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marks a bridge disconnected when the sidecar socket closes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-bridge-socket-'));
    const socketPath = join(dir, 'bridge.sock');
    const accepted: Socket[] = [];
    const server = net.createServer((socket) => {
      accepted.push(socket);
      new RpcSession(new SocketTransport(socket), new PingTarget());
    });

    try {
      await mkdir(dir, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      const bridge = new CapnwebExtensionBridge(
        'demo-sidecar',
        createNoOpLogger()
      );
      await bridge.connect(socketPath, 1000);
      expect(bridge.connected).toBe(true);

      accepted[0]?.destroy();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(bridge.connected).toBe(false);
      bridge.close();
    } finally {
      server.close();
      accepted[0]?.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
