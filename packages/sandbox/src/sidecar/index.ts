/**
 * Helpers for authoring a Cloudflare Sandbox SDK extension's **sidecar**
 * process \u2014 the program the container spawns inside the sandbox and that
 * exchanges capnweb RPC with the host over a unix socket.
 *
 * This subpath is loaded only inside the sidecar (it depends on Node-style
 * built-ins like `node:net`); the SDK-side `@cloudflare/sandbox/extensions`
 * surface never imports it.
 *
 * Authoring contract:
 *  - Extend {@link SandboxSidecar}. The base implements `__ping__` so the
 *    host's health probe round-trips without per-sidecar boilerplate.
 *  - Pass an instance to {@link serveSandboxSidecar}. The helper opens the
 *    unix socket at `EXT_SOCKET` and serves a fresh capnweb session per
 *    connection.
 */

import net from 'node:net';
import { RpcSession, RpcTarget } from 'capnweb';
import { SocketTransport } from './socket-transport.js';

export { SocketTransport } from './socket-transport.js';

/**
 * Base class for a sidecar's main capnweb RpcTarget. Subclasses add their
 * own methods \u2014 these become the typed remote main visible to the SDK.
 *
 * `__ping__` is reserved for host health probes; do not override it.
 */
export abstract class SandboxSidecar extends RpcTarget {
  /**
   * Health probe \u2014 the container's `ExtensionHost.health()` calls this and
   * expects the literal string `'pong'`. The host bounds the call with its
   * own timeout so a misbehaving sidecar cannot hang the probe.
   */
  __ping__(): 'pong' {
    return 'pong';
  }
}

/**
 * Options for {@link serveSandboxSidecar}. Mostly defaults; the socket path
 * is always taken from `process.env.EXT_SOCKET` (set by the container's
 * `ExtensionHost`) so authors do not have to plumb it themselves.
 */
export interface ServeSidecarOptions {
  /**
   * Override the diagnostic log line printed to stdout after the sidecar opens
   * its socket. Readiness is determined by the host's successful capnweb
   * connection, not by this line. Defaults to `sandbox sidecar listening`.
   */
  readyMessage?: string;
}

/**
 * Open the sidecar's unix socket and serve capnweb sessions backed by
 * `target`. Each inbound connection gets its own `RpcSession`; the `target`
 * instance is shared across all sessions, so authors can keep per-sidecar
 * state on it without sync.
 *
 * Idiomatic usage:
 *
 * ```ts
 * import {
 *   SandboxSidecar,
 *   serveSandboxSidecar
 * } from '@cloudflare/sandbox/sidecar';
 *
 * class MyApi extends SandboxSidecar {
 *   async isOdd(n: number): Promise<boolean> {
 *     return n % 2 === 1;
 *   }
 * }
 *
 * serveSandboxSidecar(new MyApi());
 * ```
 */
export function serveSandboxSidecar(
  target: SandboxSidecar,
  options: ServeSidecarOptions = {}
): net.Server {
  const socketPath = process.env.EXT_SOCKET;
  if (!socketPath) {
    throw new Error(
      'EXT_SOCKET is not set \u2014 sidecars are spawned by the container ExtensionHost, which injects this env var'
    );
  }

  const server = net.createServer((socket) => {
    // One capnweb session per connection. The shared `target` is exposed as
    // each session's local main; capnweb hands a typed stub of it to the
    // host on connect via `session.getRemoteMain()`.
    new RpcSession(new SocketTransport(socket), target);
  });

  server.once('error', (error) => {
    process.stderr.write(
      `sandbox sidecar failed to listen on ${socketPath}: ${error.message}\n`
    );
    process.exit(1);
  });

  server.listen(socketPath, () => {
    const message = options.readyMessage ?? 'sandbox sidecar listening';
    process.stdout.write(`${message}\n`);
  });

  // Stay alive on terminal signals so the host's own SIGTERM \u2192 SIGKILL
  // sequence is what tears us down (not a default Node handler).
  const onSignal = () => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return server;
}
