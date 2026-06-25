/**
 * Test fixture sidecar.
 *
 * Self-contained capnweb sidecar used by `extension-host.test.ts`. Bundled
 * via `bun build --bundle` in the test's beforeAll so the tarball is a
 * real, install-ready npm package with no runtime dependency resolution.
 *
 * The capnweb / sidecar helper imports are pulled directly from the
 * monorepo workspaces so the fixture exercises the same code paths a real
 * `@cloudflare/sandbox/sidecar` consumer would.
 */

import {
  SandboxSidecar,
  serveSandboxSidecar
} from '@cloudflare/sandbox/sidecar';

class DemoSidecarAPI extends SandboxSidecar {
  async echo(value: string): Promise<string> {
    return value;
  }

  env(name: string): string | undefined {
    return process.env[name];
  }

  /**
   * Streaming-style call: capnweb stubs the callback so each invocation is
   * an RPC back to the SDK. The host-test asserts that all events arrive
   * before `runJob` resolves.
   */
  async runJob(
    label: string,
    onEvent: (event: { kind: string; data: unknown }) => void | Promise<void>
  ): Promise<{ ok: true; label: string }> {
    await onEvent({ kind: 'started', data: label });
    await onEvent({ kind: 'progress', data: 0.5 });
    await onEvent({ kind: 'progress', data: 1 });
    return { ok: true, label };
  }

  /** Throws so the test can assert errors propagate across capnweb. */
  async fail(message: string): Promise<never> {
    throw new Error(message);
  }
}

serveSandboxSidecar(new DemoSidecarAPI(), {
  readyMessage: 'demo sidecar listening'
});
