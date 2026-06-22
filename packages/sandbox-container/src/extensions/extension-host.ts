import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXTENSION_TARBALL_REQUIRED,
  type ExtensionConnectRequest,
  type ExtensionHealth,
  type ExtensionRegistration,
  type Logger
} from '@repo/shared';
import { CapnwebExtensionBridge } from './capnweb-bridge';
import { hashTarball, provisionPackage } from './provision';

const DEFAULT_ROOT_DIR = '/var/lib/sandbox-extensions';
const STOP_GRACE_MS = 500;

interface ExtensionInstance {
  registration: ExtensionRegistration;
  provisionedDir: string;
  binAbsolutePath: string;
  socketPath: string;
  child: Bun.Subprocess | null;
  bridge: CapnwebExtensionBridge | null;
  startPromise: Promise<void> | null;
  generation: number;
  logger: Logger;
}

/**
 * Error the host throws when a `connect()` request arrives with only a
 * package hash and the host has not yet provisioned that hash. The SDK
 * recognises it by name and retries with the tarball bytes attached.
 *
 * Carrying it as a named subclass keeps the contract typed inside the
 * container; the wire reproduction is via `Error.name`, preserved by
 * capnweb across the session boundary.
 */
export class ExtensionTarballRequiredError extends Error {
  override readonly name = EXTENSION_TARBALL_REQUIRED;
  readonly packageHash: string;
  constructor(packageHash: string) {
    super(
      `Extension package '${packageHash}' is not provisioned; resend connect() with tarball bytes`
    );
    this.packageHash = packageHash;
  }
}

/**
 * Container-side host for sidecar extensions.
 *
 * Each registered extension is identified by a content hash of its
 * `.tgz` bytes; the host provisions on first connect, lazily spawns the
 * sidecar, and exposes its capnweb remote main to callers. Calls flow
 * Worker \u2192 DO \u2192 container (capnweb session A) \u2192 sidecar (capnweb
 * session B); capnweb proxies methods and callback stubs across both hops.
 *
 * Startup-optimised: unused extensions cost ~nothing. A connect for an
 * unknown hash with no tarball attached fails with
 * {@link ExtensionTarballRequiredError} so the SDK can resend with bytes;
 * once provisioned, the hash alone is enough for every subsequent connect.
 */
export class ExtensionHost {
  readonly #instancesByHash = new Map<string, ExtensionInstance>();
  readonly #provisioningByHash = new Map<string, Promise<ExtensionInstance>>();
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
   * Provision (if new) and return the sidecar's capnweb remote main as a
   * `.dup()`-ed stub. The duplicate lets the caller dispose freely without
   * tearing down the bridge's held reference.
   */
  async connect(req: ExtensionConnectRequest): Promise<object> {
    const instance = await this.#ensureProvisioned(req);
    await this.#ensureReady(instance);
    if (!instance.bridge) {
      throw new Error(
        `Extension '${instance.registration.id}' bridge unavailable`
      );
    }
    return instance.bridge.remoteMain();
  }

  /** Health snapshot, probing the sidecar with `__ping__` when running. */
  async health(packageHash: string): Promise<ExtensionHealth> {
    const instance = this.#instancesByHash.get(packageHash);
    if (!instance) {
      return {
        packageHash,
        id: '',
        version: '',
        provisioned: false,
        running: false,
        pid: null,
        responsive: false
      };
    }

    const running = instance.child !== null && instance.child.exitCode === null;
    let responsive = false;
    if (running && instance.bridge?.connected) {
      responsive = await instance.bridge.ping();
    }

    return {
      packageHash,
      id: instance.registration.id,
      version: instance.registration.version,
      provisioned: true,
      running,
      pid: instance.child?.pid ?? null,
      responsive
    };
  }

  /** Stop a single extension's sidecar and release its capnweb session. */
  async stop(packageHash: string): Promise<void> {
    const instance = this.#instancesByHash.get(packageHash);
    if (instance) {
      await this.#teardown(instance);
    }
  }

  /** Stop every sidecar. Called during container shutdown. */
  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.#instancesByHash.values()].map((instance) =>
        this.#teardown(instance)
      )
    );
    await rm(this.#socketDir, { recursive: true, force: true }).catch(() => {});
  }

  // --- internals -----------------------------------------------------------

  async #ensureProvisioned(
    req: ExtensionConnectRequest
  ): Promise<ExtensionInstance> {
    const existing = this.#instancesByHash.get(req.packageHash);
    if (existing) return existing;

    const inFlight = this.#provisioningByHash.get(req.packageHash);
    if (inFlight) return inFlight;

    if (!req.tarball) {
      throw new ExtensionTarballRequiredError(req.packageHash);
    }

    const promise = this.#provision(req).finally(() => {
      this.#provisioningByHash.delete(req.packageHash);
    });
    this.#provisioningByHash.set(req.packageHash, promise);
    return promise;
  }

  async #provision(req: ExtensionConnectRequest): Promise<ExtensionInstance> {
    const existing = this.#instancesByHash.get(req.packageHash);
    if (existing) return existing;

    if (!req.tarball) {
      throw new ExtensionTarballRequiredError(req.packageHash);
    }

    // Defensively re-hash the bytes: the host's identity for this instance is
    // what *we* see, not what the SDK claimed. Mismatched hashes signal a
    // corrupt or misrouted upload.
    const computedHash = hashTarball(req.tarball);
    if (computedHash !== req.packageHash) {
      throw new Error(
        `Extension tarball hash mismatch (declared ${req.packageHash.slice(0, 12)}\u2026, computed ${computedHash.slice(0, 12)}\u2026)`
      );
    }

    const dir = join(this.#rootDir, computedHash);
    const { registration, binAbsolutePath } = await provisionPackage({
      tarballBytes: req.tarball,
      packageHash: computedHash,
      dir,
      binOverride: req.bin,
      readinessTimeoutMsOverride: req.readinessTimeoutMs,
      allowInstallScripts: req.allowInstallScripts,
      logger: this.#logger
    });

    const instance: ExtensionInstance = {
      registration,
      provisionedDir: dir,
      binAbsolutePath,
      socketPath: this.#freshSocketPath(),
      child: null,
      bridge: null,
      startPromise: null,
      generation: 0,
      logger: this.#logger.child({
        extensionId: registration.id,
        packageHash: computedHash.slice(0, 12)
      })
    };
    this.#instancesByHash.set(computedHash, instance);
    return instance;
  }

  /**
   * Ensure the sidecar is spawned and bridged. Concurrent callers share a
   * single in-flight start; a dead sidecar (crash or container wake) is
   * transparently restarted on the next connect.
   */
  #ensureReady(instance: ExtensionInstance): Promise<void> {
    const alive =
      instance.child !== null &&
      instance.child.exitCode === null &&
      instance.bridge?.connected === true;
    if (alive) return Promise.resolve();

    if (instance.startPromise) return instance.startPromise;

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

    const spawned = await this.#spawn(instance);
    this.#assertCurrent(instance, generation);

    const bridge = new CapnwebExtensionBridge(
      instance.registration.id,
      instance.logger
    );
    try {
      await Promise.race([
        bridge.connect(
          instance.socketPath,
          instance.registration.readinessTimeoutMs
        ),
        spawned.failed
      ]);
      this.#assertCurrent(instance, generation);
    } catch (error) {
      bridge.close();
      await this.#stopChild(spawned.child, instance.logger);
      if (instance.child === spawned.child) instance.child = null;
      throw error;
    } finally {
      spawned.cleanup();
    }

    instance.bridge = bridge;
    instance.logger.debug('Extension sidecar ready', {
      pid: instance.child?.pid ?? null
    });
  }

  async #spawn(instance: ExtensionInstance): Promise<{
    child: Bun.Subprocess;
    failed: Promise<never>;
    cleanup: () => void;
  }> {
    // Fresh socket path per (re)spawn. A deterministic path would race the
    // previous sidecar's leftover socket file on restart: a unix bind() fails
    // with EADDRINUSE if the path still exists on disk, which a crashed/
    // SIGKILLed sidecar never unlinks.
    instance.socketPath = this.#freshSocketPath();
    await mkdir(this.#socketDir, { recursive: true, mode: 0o700 });
    // Bun-native I/O to dodge any test `mock.module('node:fs')` interference.
    if (await Bun.file(instance.socketPath).exists()) {
      await rm(instance.socketPath, { force: true });
    }

    let child: Bun.Subprocess;
    try {
      child = Bun.spawn({
        // Always invoke through `bun` so the runtime is consistent with the
        // container regardless of the bin shim's shebang.
        cmd: ['bun', instance.binAbsolutePath],
        cwd: instance.provisionedDir,
        env: {
          // Current sidecars are trusted in-repo code and inherit the container
          // environment. Before enabling third-party extensions, replace this
          // with an explicit allowlist so secrets are not exposed by default.
          ...process.env,
          EXT_SOCKET: instance.socketPath,
          EXT_DIR: instance.provisionedDir
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe'
      });
    } catch (error) {
      // Bun.spawn throws synchronously for missing binaries / spawn errors,
      // unlike node:child_process which emits 'error'. Surface both the same way.
      throw error instanceof Error ? error : new Error(String(error));
    }

    const failed = new Promise<never>((_, reject) => {
      child.exited.then((exitCode) => {
        reject(
          new Error(
            `Extension '${instance.registration.id}' sidecar exited before readiness (code ${exitCode ?? 'null'})`
          )
        );
      });
    });
    const cleanup = () => {
      // child.exited is a single promise we can't detach from; the host just
      // ignores the resolution after readiness. Kept as a function for
      // symmetry and future extension.
    };

    void this.#pipeStream(
      instance,
      child.stdout as ReadableStream<Uint8Array> | undefined,
      'stdout'
    );
    void this.#pipeStream(
      instance,
      child.stderr as ReadableStream<Uint8Array> | undefined,
      'stderr'
    );
    void child.exited.then((exitCode) => {
      instance.logger.warn('Extension sidecar exited', { exitCode });
      if (instance.child === child) {
        instance.child = null;
        instance.bridge?.close();
        instance.bridge = null;
      }
    });

    instance.child = child;
    return { child, failed, cleanup };
  }

  async #pipeStream(
    instance: ExtensionInstance,
    stream: ReadableStream<Uint8Array> | undefined,
    label: 'stdout' | 'stderr'
  ): Promise<void> {
    if (!stream) return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        instance.logger.debug(`sidecar ${label}`, {
          output: decoder.decode(chunk, { stream: true })
        });
      }
    } catch (error) {
      instance.logger.debug(`sidecar ${label} stream errored`, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #teardown(instance: ExtensionInstance): Promise<void> {
    instance.generation++;
    const startPromise = instance.startPromise;
    instance.startPromise = null;
    instance.bridge?.close();
    instance.bridge = null;
    const child = instance.child;
    instance.child = null;
    if (child) await this.#stopChild(child, instance.logger);
    await startPromise?.catch(() => {});
    // A start racing this teardown may have produced a fresh child after we
    // nulled the field. The generation guard aborts the start, but only
    // after spawn; reap any orphan so stop() never leaves one behind.
    const late = instance.child;
    instance.child = null;
    if (late) await this.#stopChild(late, instance.logger);
    if (await Bun.file(instance.socketPath).exists()) {
      await rm(instance.socketPath, { force: true }).catch(() => {});
    }
  }

  #assertCurrent(instance: ExtensionInstance, generation: number): void {
    if (instance.generation !== generation) {
      throw new Error(
        `Extension '${instance.registration.id}' start was cancelled`
      );
    }
  }

  async #stopChild(child: Bun.Subprocess, logger: Logger): Promise<void> {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    const stopped = await Promise.race([
      child.exited.then(() => true),
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
        child.exited,
        new Promise<void>((resolve) =>
          setTimeout(() => resolve(), STOP_GRACE_MS)
        )
      ]);
    }
  }

  /**
   * Short, unique socket path inside a private per-host temp directory.
   * Random suffix prevents collisions with leftover socket files from a
   * crashed predecessor; flat layout keeps paths well under the ~104-char
   * unix socket length limit.
   */
  #freshSocketPath(): string {
    return join(this.#socketDir, `${randomBytes(6).toString('hex')}.sock`);
  }
}
