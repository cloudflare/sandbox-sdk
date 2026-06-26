import { RpcTarget } from 'cloudflare:workers';
import { createLogger } from '@repo/shared';
import type { Sandbox } from '../sandbox';
import { createOpencodeServer } from './opencode';
import type { OpencodeOptions, OpencodeServer } from './types';

const DEFAULT_PORT = 4096;

/** Resolved server metadata that is safe to return across the RPC boundary. */
export interface OpenCodeServerInfo {
  port: number;
  url: string;
}

/** Snapshot of the resolved lifecycle configuration. */
export interface OpenCodeConfig {
  port: number;
  directory?: string;
}

/** Current server status as observed in the container. */
export interface OpenCodeStatus extends OpenCodeServerInfo {
  running: boolean;
}

/**
 * The slice of `DurableObjectStorage` the handle uses to persist desired-state.
 * Pass `this.ctx.storage` from the Sandbox subclass to survive DO eviction.
 */
export interface OpenCodeStateStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

const STATE_KEY_PREFIX = 'opencode:desired-state:';

/** Recognise the retryable container-unavailable error across RPC. */
function isContainerUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { name?: unknown }).name === 'ContainerUnavailableError';
}

/** Stable process id for the OpenCode server on a given port. */
function defaultProcessId(port: number): string {
  return `opencode-${port}`;
}

/**
 * DO-resident lifecycle handle for an OpenCode server. Owns the durable
 * `opencode serve` process: start/reuse, stop, status, and request proxying.
 *
 * It is an {@link RpcTarget} so the DO stub naturally exposes it as
 * `sandbox.opencode` without any changes to sandbox core. `createOpenCodeClient`
 * consumes the same handle from either the Worker stub or the in-DO object.
 *
 * Construction is lazy — no RPC fires until a method is called.
 */
export class OpenCodeHandle extends RpcTarget {
  readonly #sandbox: Sandbox<unknown>;
  readonly #defaults: OpencodeOptions;
  readonly #storage: OpenCodeStateStorage | undefined;
  readonly #stateKey: string;
  #server: OpencodeServer | undefined;
  #lastOptions: OpencodeOptions | undefined;

  constructor(
    sandbox: Sandbox<unknown>,
    defaults: OpencodeOptions = {},
    storage?: OpenCodeStateStorage,
    stateIndex = 0
  ) {
    super();
    this.#sandbox = sandbox;
    this.#defaults = defaults;
    this.#storage = storage;
    this.#stateKey = `${STATE_KEY_PREFIX}${stateIndex}`;
  }

  /**
   * Start or reuse the OpenCode server. Returns RPC-safe metadata. Retries
   * once on a transient `CONTAINER_UNAVAILABLE` (e.g. a rollout in flight).
   */
  async ensure(options?: OpencodeOptions): Promise<OpenCodeServerInfo> {
    const resolved = { ...this.#defaults, ...options };
    this.#lastOptions = resolved;
    await this.#persist(resolved);

    let server: OpencodeServer;
    try {
      server = await createOpencodeServer(this.#sandbox, resolved);
    } catch (error) {
      if (!isContainerUnavailable(error)) throw error;
      server = await createOpencodeServer(this.#sandbox, resolved);
    }

    this.#server = server;
    return { port: server.port, url: server.url };
  }

  /** Stop the running server, if one was started through this handle. */
  async stop(): Promise<void> {
    if (!this.#server) return;
    await this.#server.close();
    this.#server = undefined;
  }

  /** Report whether the named OpenCode server is currently running. */
  async status(): Promise<OpenCodeStatus> {
    const resolved = { ...this.#defaults, ...this.#lastOptions };
    const port = resolved.port ?? DEFAULT_PORT;
    const processId = resolved.processId ?? defaultProcessId(port);
    const proc = await this.#sandbox.getProcess(processId);
    const running =
      proc !== null &&
      (proc.status === 'running' || proc.status === 'starting');
    return { running, port, url: `http://localhost:${port}` };
  }

  /** Snapshot of the resolved configuration the client builder reads. */
  async config(): Promise<OpenCodeConfig> {
    const resolved = { ...this.#defaults, ...this.#lastOptions };
    return {
      port: resolved.port ?? DEFAULT_PORT,
      directory: resolved.directory
    };
  }

  /**
   * Ensure the server then route a request into the container. This is the
   * transport the SDK client's `fetch` adapter uses, so it works identically
   * from the Worker stub (one RPC hop) or in-DO (local).
   */
  async fetch(request: Request): Promise<Response> {
    const server = await this.ensure();
    return this.#sandbox.containerFetch(request, server.port);
  }

  /**
   * Re-ensure the server after a container (re)start. Called from the
   * OpenCode-aware `Sandbox` base's `onStart`. No-op until the server has been
   * started at least once, so a cold DO doesn't spawn an unconfigured server.
   */
  async onContainerStart(): Promise<void> {
    const options = this.#lastOptions ?? (await this.#loadPersisted());
    if (!options) return;
    await this.ensure(options);
  }

  /** Persist resolved desired-state so a cold DO can recover it. Best-effort. */
  async #persist(options: OpencodeOptions): Promise<void> {
    if (!this.#storage) return;
    await this.#storage.put(this.#stateKey, options);
  }

  /** Read persisted desired-state, if any, after a DO eviction. */
  async #loadPersisted(): Promise<OpencodeOptions | undefined> {
    if (!this.#storage) return undefined;
    return this.#storage.get<OpencodeOptions>(this.#stateKey);
  }
}

/**
 * Tracks the handles created for each sandbox so the OpenCode-aware `Sandbox`
 * base can re-ensure them on container start without knowing the field name the
 * user chose. Keyed weakly so handles are collected with their sandbox.
 */
const handleRegistry = new WeakMap<Sandbox<unknown>, Set<OpenCodeHandle>>();

/**
 * Factory — attach as a field on a Sandbox subclass:
 * `opencode = withOpenCode(this, defaults, this.ctx.storage)`.
 *
 * Pass `this.ctx.storage` to persist desired-state so the server is recovered
 * after a DO eviction (cold start), not just a container restart. The
 * per-sandbox registration order keys each handle's state deterministically, so
 * a rebuilt DO with the same field-initializer order recovers each server.
 */
export function withOpenCode(
  sandbox: Sandbox<unknown>,
  defaults?: OpencodeOptions,
  storage?: OpenCodeStateStorage
): OpenCodeHandle {
  let handles = handleRegistry.get(sandbox);
  if (!handles) {
    handles = new Set();
    handleRegistry.set(sandbox, handles);
  }
  const handle = new OpenCodeHandle(sandbox, defaults, storage, handles.size);
  handles.add(handle);
  return handle;
}

/**
 * Re-ensure every OpenCode handle registered for a sandbox. Called from the
 * OpenCode-aware `Sandbox` base's `onStart` so durable servers come back after
 * a container sleep or rollout. No-op for sandboxes with no handles.
 *
 * Best-effort: a handle that fails to re-ensure (e.g. a missing binary or a
 * container that is not ready) is logged and skipped so it never poisons the
 * container's `onStart`. Every handle is attempted regardless of the others.
 */
export async function reEnsureOpenCodeHandles(
  sandbox: Sandbox<unknown>
): Promise<void> {
  const handles = handleRegistry.get(sandbox);
  if (!handles) return;
  const results = await Promise.allSettled(
    [...handles].map((handle) => handle.onContainerStart())
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      createLogger({
        component: 'sandbox-do',
        operation: 'opencode'
      }).error(
        'Failed to re-ensure OpenCode server on container start',
        result.reason instanceof Error
          ? result.reason
          : new Error(String(result.reason))
      );
    }
  }
}
