import {
  SandboxExtension,
  type SandboxLike
} from '@cloudflare/sandbox/extensions';
import { createOpenCodeServer, type OpenCodeSandboxLike } from './opencode';
import type { OpenCodeOptions, OpenCodeServer } from './types';

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
 * Pass `this.ctx.storage` so the server config survives a Durable Object
 * eviction (cold start) and is recovered lazily on the next `start()`.
 */
export interface OpenCodeStateStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/** Options for {@link withOpenCode}: server defaults plus optional storage. */
export interface WithOpenCodeOptions extends OpenCodeOptions {
  /** Persist desired-state here so it survives DO eviction. */
  storage?: OpenCodeStateStorage;
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
 * It extends {@link SandboxExtension}, so the DO stub exposes it as
 * `sandbox.opencode` and method calls dispatch through `callExtension` — the
 * same path the interpreter extension uses. `createOpenCodeClient` consumes the
 * same handle from either the Worker stub or the in-DO object.
 *
 * The server starts lazily: nothing runs until `start()` (or `fetch()`, which
 * calls it) is invoked. To start optimistically, call `opencode.start()` from
 * your Sandbox subclass's `onStart`.
 */
export class OpenCodeHandle extends SandboxExtension {
  readonly #sandbox: OpenCodeSandboxLike;
  readonly #defaults: OpenCodeOptions;
  readonly #storage: OpenCodeStateStorage | undefined;
  readonly #stateKey: string;
  #server: OpenCodeServer | undefined;
  #lastOptions: OpenCodeOptions | undefined;

  constructor(
    sandbox: OpenCodeSandboxLike,
    defaults: OpenCodeOptions = {},
    storage?: OpenCodeStateStorage,
    stateIndex = 0
  ) {
    super(sandbox as SandboxLike);
    this.#sandbox = sandbox;
    this.#defaults = defaults;
    this.#storage = storage;
    this.#stateKey = `${STATE_KEY_PREFIX}${stateIndex}`;
  }

  /**
   * Start or reuse the OpenCode server, returning RPC-safe metadata. With no
   * options it reuses the last-used config, recovering persisted desired-state
   * after a cold start. Retries once on a transient `CONTAINER_UNAVAILABLE`
   * (e.g. a rollout in flight).
   */
  async start(options?: OpenCodeOptions): Promise<OpenCodeServerInfo> {
    const recovered =
      options ?? this.#lastOptions ?? (await this.#loadPersisted());
    const resolved = { ...this.#defaults, ...recovered };
    this.#lastOptions = resolved;
    await this.#persist(resolved);

    let server: OpenCodeServer;
    try {
      server = await createOpenCodeServer(this.#sandbox, resolved);
    } catch (error) {
      if (!isContainerUnavailable(error)) throw error;
      server = await createOpenCodeServer(this.#sandbox, resolved);
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
    const status = proc ? await proc.status() : null;
    const running = status === 'running' || status === 'starting';
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
   * Start the server then route a request into the container. This is the
   * transport the SDK client's `fetch` adapter and the Worker proxy use, so it
   * works identically from the Worker stub (one RPC hop) or in-DO (local).
   */
  async fetch(request: Request): Promise<Response> {
    const server = await this.start();
    return this.#sandbox.containerFetch(request, server.port);
  }

  /**
   * Persist resolved desired-state so a cold DO can recover it. Best-effort.
   *
   * Secret-bearing fields (`config`, `env`) are never written to storage. They
   * are sourced fresh from the handle's defaults — which the Sandbox rebuilds
   * from the environment on every construction — so a cold start always uses
   * current credentials rather than a durable copy.
   */
  async #persist(options: OpenCodeOptions): Promise<void> {
    if (!this.#storage) return;
    const { config: _config, env: _env, ...safe } = options;
    await this.#storage.put(this.#stateKey, safe);
  }

  /** Read persisted desired-state, if any, after a DO eviction. */
  async #loadPersisted(): Promise<OpenCodeOptions | undefined> {
    if (!this.#storage) return undefined;
    return this.#storage.get<OpenCodeOptions>(this.#stateKey);
  }
}

/**
 * Assigns each handle a stable per-sandbox index so its persisted state key is
 * deterministic across DO reconstruction (field initializers run in the same
 * order each time). Keyed weakly so it is collected with the sandbox.
 */
const stateIndexCounter = new WeakMap<OpenCodeSandboxLike, number>();

/**
 * Factory — attach as a field on a Sandbox subclass:
 * `opencode = withOpenCode(this, { directory, config, storage: this.ctx.storage })`.
 *
 * Pass `storage` to persist desired-state so the server is recovered after a DO
 * eviction (cold start). The server starts lazily on first use.
 */
export function withOpenCode(
  sandbox: OpenCodeSandboxLike,
  options: WithOpenCodeOptions = {}
): OpenCodeHandle {
  const { storage, ...defaults } = options;
  const index = stateIndexCounter.get(sandbox) ?? 0;
  stateIndexCounter.set(sandbox, index + 1);
  return new OpenCodeHandle(sandbox, defaults, storage, index);
}
