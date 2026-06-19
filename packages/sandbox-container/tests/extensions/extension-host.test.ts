import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoOpLogger } from '@repo/shared';
import { buildEchoManifest } from '../../src/extensions/echo-sidecar';
import { ExtensionHost } from '../../src/extensions/extension-host';
import type { ExtensionManifest } from '../../src/extensions/types';

/**
 * End-to-end validation of the extension framework: provision an asset, spawn a
 * real sidecar process, and round-trip calls/events over the unix-socket bridge.
 */
describe('ExtensionHost', () => {
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

  it('provisions, spawns, and round-trips a call to the echo sidecar', async () => {
    const h = makeHost();
    await h.register(buildEchoManifest());

    const result = await h.call('echo', 'echo', ['hello']);

    expect(result).toBe('hello');
  });

  it('forwards streaming events before the final response', async () => {
    const h = makeHost();
    await h.register(buildEchoManifest());

    const events: Array<{ event: string; data: unknown }> = [];
    const result = await h.call('echo', 'echo', ['streamed'], (event, data) => {
      events.push({ event, data });
    });

    expect(result).toBe('streamed');
    expect(events).toEqual([{ event: 'echo', data: 'streamed' }]);
  });

  it('awaits async event delivery before resolving the result', async () => {
    const h = makeHost();
    await h.register(buildEchoManifest());

    let eventDelivered = false;
    const result = await h.call('echo', 'echo', ['x'], async () => {
      // Simulate a slow (async) callback, e.g. an RPC back to the SDK.
      await new Promise((r) => setTimeout(r, 30));
      eventDelivered = true;
    });

    // The result must not resolve until the event callback has completed.
    expect(eventDelivered).toBe(true);
    expect(result).toBe('x');
  });

  it('reports health with a live ping once started', async () => {
    const h = makeHost();
    await h.register(buildEchoManifest());

    // No work until first use.
    let health = await h.health('echo');
    expect(health.registered).toBe(true);
    expect(health.running).toBe(false);

    await h.call('echo', 'echo', ['warm']);

    health = await h.health('echo');
    expect(health.running).toBe(true);
    expect(health.responsive).toBe(true);
    expect(health.pid).toBeGreaterThan(0);
  });

  it('rejects calls to unknown methods with the sidecar error', async () => {
    const h = makeHost();
    await h.register(buildEchoManifest());

    await expect(h.call('echo', 'nope', [])).rejects.toThrow(
      /Unknown method: nope/
    );
  });

  it('throws when calling an unregistered extension', async () => {
    const h = makeHost();
    await expect(h.call('missing', 'echo', [])).rejects.toThrow(
      /not registered/
    );
  });

  it('restarts the sidecar transparently after it exits', async () => {
    const h = makeHost();
    await h.register(buildEchoManifest());

    await h.call('echo', 'echo', ['first']);
    const firstHealth = await h.health('echo');
    expect(firstHealth.running).toBe(true);

    // Kill the sidecar out from under the host.
    await h.stop('echo');
    const stopped = await h.health('echo');
    expect(stopped.running).toBe(false);

    // Next call should re-provision + respawn.
    const result = await h.call('echo', 'echo', ['second']);
    expect(result).toBe('second');
  });

  it('is idempotent on re-registering the same id+version', async () => {
    const h = makeHost();
    const manifest: ExtensionManifest = buildEchoManifest();
    await h.register(manifest);
    await h.register({ ...manifest, command: ['definitely-missing-binary'] });

    const result = await h.call('echo', 'echo', ['again']);
    expect(result).toBe('again');
  });

  it('rejects invalid manifests before provisioning', async () => {
    const h = makeHost();
    const manifest = buildEchoManifest();

    await expect(h.register({ ...manifest, id: '../bad' })).rejects.toThrow(
      /manifest id/
    );
    await expect(h.register({ ...manifest, command: [] })).rejects.toThrow(
      /command must not be empty/
    );
    await expect(
      h.register({ ...manifest, assets: [{ path: '../escape', content: 'x' }] })
    ).rejects.toThrow(/asset path must be relative/);
    await expect(
      h.register({
        ...manifest,
        assets: [{ path: '/tmp/escape', content: 'x' }]
      })
    ).rejects.toThrow(/asset path must be relative/);
  });

  it('rejects cleanly when the sidecar command cannot spawn', async () => {
    const h = makeHost();
    await h.register({
      ...buildEchoManifest(),
      command: ['definitely-missing-extension-binary'],
      readinessTimeoutMs: 500
    });

    await expect(h.call('echo', 'echo', ['x'])).rejects.toThrow();
    const health = await h.health('echo');
    expect(health.running).toBe(false);
  });

  it('rejects (does not hang) when a call exceeds its timeout', async () => {
    const h = makeHost();
    await h.register(buildEchoManifest());

    await expect(h.call('echo', 'hang', [], undefined, 200)).rejects.toThrow(
      /timed out after 200ms/
    );
  });

  it('recovers when the sidecar drops the connection but stays alive', async () => {
    const h = makeHost();
    await h.register(buildEchoManifest());

    // Warm it up, then ask the sidecar to drop the socket without exiting.
    await h.call('echo', 'echo', ['warm']);
    await expect(h.call('echo', 'drop', [])).rejects.toThrow(/closed/);

    // The next call must transparently reconnect rather than hang on a dead socket.
    const result = await h.call('echo', 'echo', ['after-drop']);
    expect(result).toBe('after-drop');
  });
});
