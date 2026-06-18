import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Logger } from '@repo/shared';
import { ExtensionBridge } from './bridge';
import type {
  ExtensionEventHandler,
  ExtensionHealth,
  ExtensionManifest
} from './types';

const DEFAULT_ROOT_DIR = '/var/lib/sandbox-extensions';
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const MANIFEST_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Health probes must never hang the caller, so the ping is always bounded even
// though normal calls are unbounded by default.
const PING_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 500;

interface ExtensionInstance {
  manifest: ExtensionManifest;
  provisionedDir: string;
  socketPath: string;
  provisioned: boolean;
  child: ChildProcess | null;
  bridge: ExtensionBridge | null;
  startPromise: Promise<void> | null;
  generation: number;
  logger: Logger;
}

/**
 * Container-side host for sidecar extensions.
 *
 * Responsibilities:
 * - **provision** — materialise an extension's assets on disk, idempotently,
 *   keyed by `id`+`version`.
 * - **start** — spawn the sidecar process lazily (on first call), inject the
 *   bridge socket path, and connect a {@link ExtensionBridge}.
 * - **supervise** — detect sidecar exit and transparently re-provision +
 *   restart on the next call (also covers container sleep/wake).
 * - **bridge** — forward typed method calls (and streaming events) to the
 *   sidecar over a unix domain socket — never an exposed TCP port.
 *
 * Startup-optimised: registering an extension does no work; the sidecar is
 * only spawned when first invoked, so unused extensions add ~zero overhead.
 */
export class ExtensionHost {
  readonly #instances = new Map<string, ExtensionInstance>();
  readonly #logger: Logger;
  readonly #rootDir: string;
  readonly #socketDir: string;

  constructor(logger: Logger, rootDir: string = DEFAULT_ROOT_DIR) {
    this.#logger = logger.child({ subsystem: 'extension-host' });
    this.#rootDir = rootDir;
    this.#socketDir = join(
      tmpdir(),
      `sbx-ext-${randomBytes(8).toString('hex')}`
    );
  }

  /**
   * Register (or re-register) an extension manifest. Idempotent: re-registering
   * the same `id`+`version` is a no-op; a changed version replaces the entry
   * and stops the previous sidecar. Does not spawn anything.
   */
  async register(manifest: ExtensionManifest): Promise<void> {
    this.#validateManifest(manifest);
    const existing = this.#instances.get(manifest.id);
    if (existing && existing.manifest.version === manifest.version) {
      return;
    }
    if (existing) {
      await this.#teardown(existing);
    }

    this.#instances.set(manifest.id, {
      manifest,
      provisionedDir: join(this.#rootDir, manifest.id, manifest.version),
      socketPath: this.#socketPathFor(manifest),
      provisioned: false,
      child: null,
      bridge: null,
      startPromise: null,
      generation: 0,
      logger: this.#logger.child({ extensionId: manifest.id })
    });
  }

  /** Invoke a sidecar method, starting the sidecar on demand. */
  async call(
    id: string,
    method: string,
    args: unknown[],
    onEvent?: ExtensionEventHandler,
    timeoutMs?: number
  ): Promise<unknown> {
    const instance = this.#require(id);
    await this.#ensureReady(instance);
    if (!instance.bridge) {
      throw new Error(`Extension '${id}' bridge unavailable`);
    }
    return instance.bridge.call(method, args, onEvent, timeoutMs);
  }

  /** Health snapshot, optionally probing the bridge with a ping. */
  async health(id: string): Promise<ExtensionHealth> {
    const instance = this.#instances.get(id);
    if (!instance) {
      return {
        id,
        version: '',
        registered: false,
        running: false,
        pid: null,
        responsive: false
      };
    }

    const running = instance.child !== null && instance.child.exitCode === null;
    let responsive = false;
    if (running && instance.bridge?.connected) {
      try {
        responsive =
          (await instance.bridge.call(
            '__ping__',
            [],
            undefined,
            PING_TIMEOUT_MS
          )) === 'pong';
      } catch {
        responsive = false;
      }
    }

    return {
      id,
      version: instance.manifest.version,
      registered: true,
      running,
      pid: instance.child?.pid ?? null,
      responsive
    };
  }

  /** Stop a single extension's sidecar and release its bridge. */
  async stop(id: string): Promise<void> {
    const instance = this.#instances.get(id);
    if (instance) {
      await this.#teardown(instance);
    }
  }

  /** Stop every sidecar. Called during container shutdown. */
  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.#instances.values()].map((instance) => this.#teardown(instance))
    );
    await rm(this.#socketDir, { recursive: true, force: true }).catch(() => {});
  }

  // --- internals -----------------------------------------------------------

  #require(id: string): ExtensionInstance {
    const instance = this.#instances.get(id);
    if (!instance) {
      throw new Error(`Extension '${id}' is not registered`);
    }
    return instance;
  }

  /**
   * Ensure the sidecar is provisioned, spawned, and bridged. Concurrent callers
   * share a single in-flight start. A dead sidecar (crash or container wake) is
   * transparently restarted.
   */
  #ensureReady(instance: ExtensionInstance): Promise<void> {
    const alive =
      instance.child !== null &&
      instance.child.exitCode === null &&
      instance.bridge?.connected === true;
    if (alive) {
      return Promise.resolve();
    }
    if (instance.startPromise) {
      return instance.startPromise;
    }

    const startPromise = this.#start(instance).finally(() => {
      instance.startPromise = null;
    });
    instance.startPromise = startPromise;
    return startPromise;
  }

  async #start(instance: ExtensionInstance): Promise<void> {
    const generation = instance.generation;
    if (instance.child && instance.child.exitCode === null) {
      await this.#stopChild(instance.child, instance.logger);
    }
    instance.bridge?.close();
    instance.bridge = null;

    await this.#provision(instance);
    this.#assertCurrent(instance, generation);
    const spawned = await this.#spawn(instance);
    this.#assertCurrent(instance, generation);

    const bridge = new ExtensionBridge(instance.manifest.id, instance.logger);
    try {
      await Promise.race([
        bridge.connect(
          instance.socketPath,
          instance.manifest.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
        ),
        spawned.failed
      ]);
      this.#assertCurrent(instance, generation);
    } catch (error) {
      bridge.close();
      await this.#stopChild(spawned.child, instance.logger);
      if (instance.child === spawned.child) {
        instance.child = null;
      }
      throw error;
    } finally {
      spawned.cleanup();
    }
    instance.bridge = bridge;
    instance.logger.debug('Extension sidecar ready', {
      pid: instance.child?.pid ?? null
    });
  }

  /** Write the manifest's assets to disk once per version (idempotent). */
  async #provision(instance: ExtensionInstance): Promise<void> {
    if (instance.provisioned) return;

    await mkdir(instance.provisionedDir, { recursive: true });
    for (const asset of instance.manifest.assets ?? []) {
      const target = this.#assetTarget(instance, asset.path);
      await mkdir(dirname(target), { recursive: true });
      const data = Buffer.from(
        asset.content,
        asset.encoding === 'base64' ? 'base64' : 'utf8'
      );
      await writeFile(target, data, { mode: asset.mode });
    }
    instance.provisioned = true;
    instance.logger.debug('Extension assets provisioned', {
      dir: instance.provisionedDir
    });
  }

  async #spawn(instance: ExtensionInstance): Promise<{
    child: ChildProcess;
    failed: Promise<never>;
    cleanup: () => void;
  }> {
    // Use a fresh socket path for every (re)spawn. A deterministic path would
    // race the previous sidecar's leftover socket file on restart: a unix
    // bind() fails with EADDRINUSE if the path still exists on disk, which a
    // crashed/SIGKILLed sidecar never unlinks. A unique path sidesteps that.
    instance.socketPath = this.#socketPathFor(instance.manifest);
    await mkdir(dirname(instance.socketPath), { recursive: true, mode: 0o700 });
    // Defensive: a fresh path should never exist, but never inherit a stale one.
    if (existsSync(instance.socketPath)) {
      await rm(instance.socketPath, { force: true });
    }

    const argv = instance.manifest.command.map((part) =>
      part
        .replaceAll('{dir}', instance.provisionedDir)
        .replaceAll('{socket}', instance.socketPath)
    );
    const [command, ...args] = argv;

    const child = spawn(command, args, {
      cwd:
        instance.manifest.cwd?.replaceAll('{dir}', instance.provisionedDir) ??
        instance.provisionedDir,
      env: {
        ...process.env,
        ...instance.manifest.env,
        EXT_SOCKET: instance.socketPath,
        EXT_DIR: instance.provisionedDir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let cleanup = () => {};
    const failed = new Promise<never>((_, reject) => {
      const onError = (error: Error) => reject(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        reject(
          new Error(
            `Extension '${instance.manifest.id}' sidecar exited before readiness (code ${code ?? 'null'}, signal ${signal ?? 'null'})`
          )
        );
      child.once('error', onError);
      child.once('exit', onExit);
      cleanup = () => {
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
      };
    });

    child.stdout?.on('data', (chunk: Buffer) =>
      instance.logger.debug('sidecar stdout', { output: chunk.toString() })
    );
    child.stderr?.on('data', (chunk: Buffer) =>
      instance.logger.debug('sidecar stderr', { output: chunk.toString() })
    );
    child.on('error', (error) => {
      instance.logger.warn('Extension sidecar process error', {
        error: error.message
      });
      if (instance.child === child) {
        instance.child = null;
        instance.bridge?.close();
        instance.bridge = null;
      }
    });
    child.on('exit', (code, signal) => {
      instance.logger.warn('Extension sidecar exited', {
        code,
        signal
      });
      if (instance.child === child) {
        instance.child = null;
        instance.bridge?.close();
        instance.bridge = null;
      }
    });

    instance.child = child;
    return { child, failed, cleanup };
  }

  async #teardown(instance: ExtensionInstance): Promise<void> {
    instance.generation++;
    const startPromise = instance.startPromise;
    instance.startPromise = null;
    instance.bridge?.close();
    instance.bridge = null;
    const child = instance.child;
    instance.child = null;
    if (child) {
      await this.#stopChild(child, instance.logger);
    }
    await startPromise?.catch(() => {});
    // A start racing this teardown may have spawned a fresh child after we
    // nulled the field (the generation guard aborts it, but only after spawn,
    // and it never reaches the bridge assignment). Reap the child so stop()
    // never leaves an orphaned sidecar.
    const late = instance.child;
    instance.child = null;
    if (late) {
      await this.#stopChild(late, instance.logger);
    }
    if (existsSync(instance.socketPath)) {
      await rm(instance.socketPath, { force: true }).catch(() => {});
    }
  }

  #validateManifest(manifest: ExtensionManifest): void {
    this.#validateSlug('id', manifest.id);
    this.#validateSlug('version', manifest.version);
    if (manifest.command.length === 0 || manifest.command[0]?.length === 0) {
      throw new Error(
        `Extension '${manifest.id}' manifest command must not be empty`
      );
    }
    if (
      manifest.readinessTimeoutMs !== undefined &&
      (!Number.isFinite(manifest.readinessTimeoutMs) ||
        manifest.readinessTimeoutMs <= 0)
    ) {
      throw new Error(
        `Extension '${manifest.id}' readinessTimeoutMs must be positive`
      );
    }
    for (const asset of manifest.assets ?? []) {
      this.#validateAssetPath(manifest.id, asset.path);
    }
  }

  #validateSlug(field: 'id' | 'version', value: string): void {
    if (!MANIFEST_SLUG_PATTERN.test(value)) {
      throw new Error(
        `Extension manifest ${field} must match ${MANIFEST_SLUG_PATTERN}`
      );
    }
  }

  #validateAssetPath(id: string, path: string): void {
    if (
      !path ||
      path === '.' ||
      path.includes('\0') ||
      isAbsolute(path) ||
      path.split(/[\\/]/).includes('..')
    ) {
      throw new Error(`Extension '${id}' asset path must be relative`);
    }
  }

  #assetTarget(instance: ExtensionInstance, path: string): string {
    const root = resolve(instance.provisionedDir);
    const target = resolve(root, path);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error(
        `Extension '${instance.manifest.id}' asset path escapes its directory`
      );
    }
    return target;
  }

  #assertCurrent(instance: ExtensionInstance, generation: number): void {
    if (instance.generation !== generation) {
      throw new Error(
        `Extension '${instance.manifest.id}' start was cancelled`
      );
    }
  }

  async #stopChild(child: ChildProcess, logger: Logger): Promise<void> {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    child.kill('SIGTERM');
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), STOP_GRACE_MS)
      )
    ]);
    if (!stopped && child.exitCode === null) {
      logger.warn(
        'Extension sidecar did not stop after SIGTERM; sending SIGKILL'
      );
      child.kill('SIGKILL');
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS))
      ]);
    }
  }

  /**
   * Short, unique socket path in a private per-host temp directory. The hashed
   * id keeps the name readable and the random suffix makes every (re)spawn use
   * a distinct path — so a restart never collides with a leftover socket file.
   * Staying flat under the random `#socketDir` also keeps the path well under
   * the ~104-char unix socket length limit.
   */
  #socketPathFor(manifest: ExtensionManifest): string {
    const hash = createHash('sha1')
      .update(`${manifest.id}@${manifest.version}`)
      .digest('hex')
      .slice(0, 12);
    return join(
      this.#socketDir,
      `${hash}-${randomBytes(4).toString('hex')}.sock`
    );
  }
}
