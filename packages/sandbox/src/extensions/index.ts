/**
 * Unified extension surface for the Cloudflare Sandbox SDK.
 *
 * Every extension — whether it just drives existing control sub-APIs or ships
 * its own container sidecar — shares one shape: a class that extends
 * {@link SandboxExtension}, captured lazily via a `withX(this)` factory.
 *
 * - No sidecar? Extend {@link SandboxExtension} and use `this.client.<subApi>`
 *   (`commands`, `files`, `git`, `interpreter`, …). Don't pass a manifest.
 * - Need a container sidecar? Pass an {@link ExtensionManifest} to `super()`;
 *   the `call` / `health` / `stop` helpers then register the manifest once
 *   (lazily) and bridge to the sidecar over `sandbox.client.extensions` (the
 *   low-level {@link Extensions} client). Stream by passing `{ onEvent }` to
 *   `call`.
 */

import { RpcTarget } from 'cloudflare:workers';
import type {
  ExtensionHealth,
  ExtensionManifest,
  SandboxAPI,
  SandboxExtensionsAPI
} from '@repo/shared';

// Re-export the wire types so consumers can author manifests from this subpath.
export type {
  ExtensionAsset,
  ExtensionHealth,
  ExtensionManifest
} from '@repo/shared';

/** Callback for streaming events surfaced by a sidecar during a call. */
export type ExtensionEventHandler = (
  event: string,
  data: unknown
) => void | Promise<void>;

/**
 * Per-call options. Providing `onEvent` switches the call to streaming mode:
 * events are delivered to the handler before the final result resolves. Omit it
 * for a plain buffered call.
 */
export interface ExtensionCallOptions {
  onEvent?: ExtensionEventHandler;
  timeoutMs?: number;
}

/**
 * The slice of the Sandbox an extension captures: just its control `client`.
 * Narrow on purpose — an extension never holds the whole instance.
 */
export type SandboxLike = {
  readonly client: SandboxAPI;
};

/**
 * Minimal shape the low-level {@link Extensions} client needs: just the
 * `extensions` sub-API. A full {@link SandboxLike} satisfies it, so base
 * classes can pass their captured sandbox straight through.
 */
export type ExtensionsClientLike = {
  readonly client: { readonly extensions: SandboxExtensionsAPI };
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;

/**
 * A failed attempt is retryable only when the sidecar was not yet reachable —
 * i.e. the bridge connection had not been established when the call was made
 * (sidecar still spawning, or being restarted by the host after a crash/wake).
 *
 * These are specifically *pre-execution* failures: a connect timeout, or a call
 * issued before the bridge was connected. We deliberately do NOT match the
 * mid-life "bridge socket closed" / "bridge closed" errors, because those can
 * fire after a `callStream` has already emitted events — retrying then would
 * duplicate output.
 */
function isReadinessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /did not accept a bridge connection/i.test(message) ||
    /bridge is not connected/i.test(message) ||
    /bridge unavailable/i.test(message) ||
    /not ready/i.test(message)
  );
}

async function withReadinessRetry<T>(
  fn: () => Promise<T>,
  canRetry: () => boolean = () => true
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < DEFAULT_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (
        !isReadinessError(error) ||
        !canRetry() ||
        attempt === DEFAULT_MAX_ATTEMPTS - 1
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, DEFAULT_RETRY_DELAY_MS * (attempt + 1))
      );
    }
  }
  throw lastError;
}

/**
 * Typed client over the container's extension host. Extends `RpcTarget` so it
 * follows the canonical extension shape and keeps the door open for direct
 * Worker pipelining.
 */
export class Extensions extends RpcTarget {
  // ECMAScript private field: never readable across the Workers RPC boundary.
  readonly #sandbox: ExtensionsClientLike;

  constructor(sandbox: ExtensionsClientLike) {
    super();
    this.#sandbox = sandbox;
  }

  // Lazy: dereference the control client per-call, never in the constructor.
  get #api(): SandboxExtensionsAPI {
    return this.#sandbox.client.extensions;
  }

  /** Register (or re-register) a manifest. Idempotent; spawns nothing. */
  async register(manifest: ExtensionManifest): Promise<void> {
    await this.#api.register(manifest);
  }

  /**
   * Invoke a sidecar method, starting the sidecar on demand. Pass
   * `options.onEvent` to stream events; otherwise the call is buffered.
   */
  async call(
    id: string,
    method: string,
    args: unknown[] = [],
    options: ExtensionCallOptions = {}
  ): Promise<unknown> {
    const onEvent = options.onEvent;
    const timeoutMs = options.timeoutMs;
    if (!onEvent) {
      return withReadinessRetry(() =>
        timeoutMs === undefined
          ? this.#api.call(id, method, args)
          : this.#api.call(id, method, args, timeoutMs)
      );
    }
    // Once any event has been delivered, stop retrying: a later failure could
    // re-run the sidecar method and replay events the caller already saw.
    let emitted = false;
    const guardedOnEvent: ExtensionEventHandler = (event, data) => {
      emitted = true;
      return onEvent(event, data);
    };
    return withReadinessRetry(
      () =>
        timeoutMs === undefined
          ? this.#api.callStream(id, method, args, guardedOnEvent)
          : this.#api.callStream(id, method, args, guardedOnEvent, timeoutMs),
      () => !emitted
    );
  }

  /** Health snapshot for a registered extension. */
  async health(id: string): Promise<ExtensionHealth> {
    return this.#api.health(id);
  }

  /** Stop a sidecar and release its bridge. */
  async stop(id: string): Promise<void> {
    await this.#api.stop(id);
  }
}

/** Factory — the consumer-facing API. */
export function withExtensions(sandbox: ExtensionsClientLike): Extensions {
  return new Extensions(sandbox);
}

/**
 * The one base class for *every* extension.
 *
 * - Need only existing control sub-APIs? Extend it and use `this.client`.
 * - Need a container sidecar? Pass a manifest to `super(sandbox, manifest)` and
 *   the sidecar methods (`call` / `callStream` / `health` / `stop`) light up —
 *   registration happens once, lazily, on first use.
 *
 * The sidecar methods throw a clear error if no manifest was provided, so an
 * extension only "becomes" a sidecar extension when it opts in by supplying one.
 *
 * ```ts
 * // SDK-only: just drives existing sub-APIs
 * class Git extends SandboxExtension {
 *   constructor(s: SandboxLike) { super(s); }
 *   status(sid: string) { return this.client.commands.execute('git status', sid); }
 * }
 *
 * // Sidecar: opt in with a manifest, then use call/callStream
 * class Interpreter extends SandboxExtension {
 *   constructor(s: SandboxLike) { super(s, buildInterpreterManifest()); }
 *   runCode(code: string) { return this.call('runCode', [code]); }
 * }
 * ```
 *
 * RPC-safety: the sandbox lives in `#sandbox` and is reached only through the
 * `protected` `client` getter (a prototype accessor, not an own property), so it
 * is never serialised across RPC. Only the public methods you add form the
 * extension's RPC surface.
 */
export abstract class SandboxExtension extends RpcTarget {
  readonly #sandbox: SandboxLike;
  readonly #extensions: Extensions;
  readonly #manifest: ExtensionManifest | undefined;
  #registered: Promise<void> | undefined;

  protected constructor(sandbox: SandboxLike, manifest?: ExtensionManifest) {
    super();
    this.#sandbox = sandbox;
    this.#extensions = withExtensions(sandbox);
    this.#manifest = manifest;
  }

  /** The container control client. Use inside your own methods, lazily. */
  protected get client(): SandboxAPI {
    return this.#sandbox.client;
  }

  /** This extension's sidecar id. Throws if the extension has no manifest. */
  protected get extensionId(): string {
    return this.#requireManifest().id;
  }

  /**
   * Invoke a sidecar method, registering + starting it on demand. Pass
   * `options.onEvent` to stream events; otherwise the call is buffered.
   */
  protected async call(
    method: string,
    args: unknown[] = [],
    options: ExtensionCallOptions = {}
  ): Promise<unknown> {
    const manifest = this.#requireManifest();
    await this.#ensureRegistered(manifest);
    return this.#extensions.call(manifest.id, method, args, options);
  }

  /** Health snapshot for this extension's sidecar. */
  protected async health(): Promise<ExtensionHealth> {
    const manifest = this.#requireManifest();
    await this.#ensureRegistered(manifest);
    return this.#extensions.health(manifest.id);
  }

  /** Stop this extension's sidecar. */
  protected async stop(): Promise<void> {
    const manifest = this.#requireManifest();
    await this.#ensureRegistered(manifest);
    await this.#extensions.stop(manifest.id);
  }

  #requireManifest(): ExtensionManifest {
    if (!this.#manifest) {
      throw new Error(
        'This extension has no sidecar manifest. Pass one to `super(sandbox, manifest)` to use call/health/stop.'
      );
    }
    return this.#manifest;
  }

  // Register exactly once. A failed attempt clears the cache so the next call
  // retries rather than caching a permanent rejection (register is idempotent).
  #ensureRegistered(manifest: ExtensionManifest): Promise<void> {
    if (!this.#registered) {
      this.#registered = this.#extensions.register(manifest).catch((error) => {
        this.#registered = undefined;
        throw error;
      });
    }
    return this.#registered;
  }
}
