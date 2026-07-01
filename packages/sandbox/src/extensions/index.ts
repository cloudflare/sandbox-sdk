/**
 * Unified extension surface for the Cloudflare Sandbox SDK.
 *
 * Every extension \u2014 whether it just drives existing control sub-APIs or
 * ships its own container sidecar \u2014 shares one shape: a class extending
 * {@link SandboxExtension}, captured lazily via a `withX(this)` factory.
 *
 * - No sidecar? Extend {@link SandboxExtension} and use `this.exec()` or
 *   `this.client.<subApi>` (`commands`, `files`, `interpreter`, \u2026). Don't pass
 *   a package.
 * - Need a container sidecar? Pass an {@link ExtensionPackage} to `super()`.
 *   Then call {@link SandboxExtension.sidecar} to obtain the sidecar's typed
 *   capnweb remote main. Calls on that stub stream through capnweb \u2014 callback
 *   parameters round-trip across both the DO\u2192container and container\u2192sidecar
 *   hops.
 *
 * `ExtensionPackage` carries tarball bytes produced by an extension build.
 * The SDK sends those bytes only when the container has not provisioned the
 * package hash yet.
 */

import { RpcTarget } from 'cloudflare:workers';
import type {
  ExtensionHealth,
  ExtensionPackage,
  SandboxAPI,
  SandboxExecOptions,
  SandboxProcessPromise
} from '@repo/shared';
import { EXTENSION_TARBALL_REQUIRED } from '@repo/shared';

// Re-export the wire types so consumers can author extensions from this
// subpath without reaching into `@repo/shared` directly.
export type { ExtensionHealth, ExtensionPackage } from '@repo/shared';

export interface HTTPAuthHostConfig {
  token: string;
  username?: string;
  type?: 'basic' | 'bearer';
}

export interface HTTPAuthInterceptorParams {
  hosts: Record<string, HTTPAuthHostConfig>;
}

/**
 * The slice of the Sandbox an extension captures: its control `client`, unified
 * `exec()` surface, and sandbox-level environment variables. Narrow on purpose
 * \u2014 an extension never holds the whole instance.
 *
 * `envVars` mirrors what the Sandbox applies to sessionless execution, so an
 * extension that drives commands through `client` directly can still honour
 * sandbox-level env (tokens, proxy settings) without an explicit session.
 */
export type SandboxLike = {
  readonly client: SandboxAPI;
  readonly exec?: (
    command: string | string[],
    options?: SandboxExecOptions
  ) => SandboxProcessPromise;
  readonly envVars?: Record<string, string>;
  registerGitAuthInterceptor?: (
    params: HTTPAuthInterceptorParams
  ) => Promise<void>;
};

/**
 * The one base class for *every* extension.
 *
 * - SDK-only: just drives existing sub-APIs.
 * - Sidecar: pass an {@link ExtensionPackage} to `super(sandbox, pkg)` and
 *   call `this.sidecar<T>()` to get a typed capnweb stub of the sidecar.
 *
 * The sidecar accessor throws a clear error if no package was supplied, so an
 * extension only "becomes" a sidecar extension when it opts in.
 *
 * ```ts
 * // SDK-only
 * class Git extends SandboxExtension {
 *   constructor(s: SandboxLike) { super(s); }
 *   async status(sid: string) {
 *     return this.exec('git status', { sessionId: sid }).output();
 *   }
 * }
 *
 * // Sidecar
 * import sidecarTarballBytes from './sidecar-package.tgz';
 * import type { MyAPI } from './shared';
 *
 * class MyExt extends SandboxExtension {
 *   constructor(s: SandboxLike) { super(s, { tarball: new Uint8Array(sidecarTarballBytes) }); }
 *   async run(input: string): Promise<string> {
 *     const api = await this.sidecar<MyAPI>();
 *     return api.run(input);
 *   }
 * }
 * ```
 *
 * RPC-safety: the sandbox lives in `#sandbox` and is reached only through the
 * `protected` `client` getter (a prototype accessor, not an own property),
 * so it is never serialised across RPC. Only the public methods you add form
 * the extension's RPC surface.
 */
export abstract class SandboxExtension extends RpcTarget {
  readonly #sandbox: SandboxLike;
  readonly #pkg: ExtensionPackage | undefined;
  #hashPromise: Promise<string> | undefined;

  protected constructor(sandbox: SandboxLike, pkg?: ExtensionPackage) {
    super();
    this.#sandbox = sandbox;
    this.#pkg = pkg;
  }

  /** The container control client. Use inside your own methods, lazily. */
  protected get client(): SandboxAPI {
    return this.#sandbox.client;
  }

  /** Unified process-handle exec surface from the owning Sandbox. */
  protected exec(
    command: string | string[],
    options?: SandboxExecOptions
  ): SandboxProcessPromise {
    const exec = this.#sandbox.exec;
    if (!exec) {
      throw new Error(
        'Sandbox extension requires the unified exec surface from the owning Sandbox'
      );
    }
    return exec.call(this.#sandbox, command, options);
  }

  /**
   * Sandbox-level environment variables. Apply these to sessionless execution
   * so commands driven straight through `client` still inherit sandbox env
   * (tokens, proxy settings) the way the Sandbox's own sessionless path does.
   */
  protected get envVars(): Record<string, string> {
    return this.#sandbox.envVars ?? {};
  }

  protected get httpAuthInterceptor():
    | ((params: HTTPAuthInterceptorParams) => Promise<void>)
    | undefined {
    const register = this.#sandbox.registerGitAuthInterceptor;
    return register
      ? (params) => register.call(this.#sandbox, params)
      : undefined;
  }

  /**
   * Return the sidecar's capnweb remote main, provisioning + spawning on
   * demand. `T` is the typed interface the sidecar exposes (its
   * `SandboxSidecar` subclass shape). Each call reconnects through the host
   * so a crashed sidecar can be restarted transparently on the next use.
   *
   * Streaming is just a method that takes a callback parameter: capnweb
   * stubs the callback and routes invocations back through the SDK\u2192container
   * \u2192sidecar hops.
   */
  protected sidecar<T extends object>(): Promise<T> {
    // Wrap the synchronous `#requirePackage` check in an async closure so a
    // missing-package error surfaces as a rejected promise, not a sync throw
    // -- callers always treat `sidecar()` as awaitable.
    return (async () => this.#connect(this.#requirePackage()))() as Promise<T>;
  }

  /** Health snapshot for this extension's sidecar. */
  protected async sidecarHealth(): Promise<ExtensionHealth> {
    const hash = await this.#hashOnce();
    return this.#sandbox.client.extensions.health(hash);
  }

  /**
   * Stop this extension's sidecar. The next `sidecar()` call will respawn on
   * demand.
   */
  protected async stopSidecar(): Promise<void> {
    const hash = await this.#hashOnce();
    await this.#sandbox.client.extensions.stop(hash);
  }

  // --- internals -----------------------------------------------------------

  async #connect(pkg: ExtensionPackage): Promise<object> {
    const packageHash = await this.#hashOnce();
    const api = this.#sandbox.client.extensions;

    // Hash-first: ask the host whether this process already has the package.
    // If it doesn't, retry once with the tarball bytes attached.
    try {
      return (await api.connect({
        packageHash,
        bin: pkg.bin,
        readinessTimeoutMs: pkg.readinessTimeoutMs,
        allowInstallScripts: pkg.allowInstallScripts
      })) as object;
    } catch (error) {
      if (!isTarballRequiredError(error)) throw error;
      try {
        return (await api.connect({
          packageHash,
          tarball: pkg.tarball,
          bin: pkg.bin,
          readinessTimeoutMs: pkg.readinessTimeoutMs,
          allowInstallScripts: pkg.allowInstallScripts
        })) as object;
      } catch (retryError) {
        throw createSidecarProvisioningError(packageHash, retryError);
      }
    }
  }

  #hashOnce(): Promise<string> {
    const pkg = this.#requirePackage();
    this.#hashPromise ??= sha256Hex(pkg.tarball);
    return this.#hashPromise;
  }

  #requirePackage(): ExtensionPackage {
    if (!this.#pkg) {
      throw new Error(
        'This extension has no sidecar package. Pass one to `super(sandbox, pkg)` to use sidecar/sidecarHealth/stopSidecar.'
      );
    }
    return this.#pkg;
  }
}

/**
 * Recognise the host's `ExtensionTarballRequired` error across the capnweb
 * boundary. There are two cases:
 *
 * 1. capnweb preserves `Error.name`, so the primary wire-safe contract is the
 *    string constant `EXTENSION_TARBALL_REQUIRED`.
 * 2. capnweb sometimes re-wraps the error as an `RPCTransportError`, discarding
 *    `name` but preserving the message text. We fall back to matching the
 *    message so the tarball retry still fires in that case.
 */
function isTarballRequiredError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
  };
  if (candidate.name === EXTENSION_TARBALL_REQUIRED) return true;
  if (candidate.code === EXTENSION_TARBALL_REQUIRED) return true;
  if (typeof candidate.message !== 'string') return false;
  return (
    candidate.message.includes(EXTENSION_TARBALL_REQUIRED) ||
    /Extension package '[0-9a-f]{64}' is not provisioned/.test(
      candidate.message
    )
  );
}

function createSidecarProvisioningError(
  packageHash: string,
  cause: unknown
): Error {
  const causeMessage =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : String(cause);
  return new Error(
    `Failed to provision sandbox sidecar package '${packageHash}'. The sidecar tarball was sent to the container, but the container could not install or start it. Check that the extension build generated a valid npm-style .tgz, that the .tgz is included in the Worker bundle, and that the sidecar package declares a valid package.json bin/sandboxExtension entry. Cause: ${causeMessage}`,
    { cause }
  );
}

/**
 * Hex sha256 of a tarball via Web Crypto, which is available in workerd and
 * every modern runtime. Avoids a Node-only path so this module stays
 * Worker-bundle-safe.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const view = new Uint8Array(digest);
  let hex = '';
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
