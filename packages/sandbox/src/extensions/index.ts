/**
 * Unified extension surface for the Cloudflare Sandbox SDK.
 *
 * Every extension \u2014 whether it just drives existing control sub-APIs or
 * ships its own container sidecar \u2014 shares one shape: a class extending
 * {@link SandboxExtension}, captured lazily via a `withX(this)` factory.
 *
 * - No sidecar? Extend {@link SandboxExtension} and use `this.exec()` or
 *   `this.withRuntime()` for scoped control APIs. Don't pass a package.
 * - Need a container sidecar? Pass an {@link ExtensionPackage} to `super()`.
 *   Then use {@link SandboxExtension.withSidecar} with the sidecar's typed
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
  ExecOptions,
  ExtensionHealth,
  ExtensionPackage,
  ProcessStatus,
  SandboxBackupAPI,
  SandboxCommand,
  SandboxExtensionsAPI,
  SandboxFilesAPI,
  SandboxPortsAPI,
  SandboxProcess,
  SandboxTerminalsAPI,
  SandboxTunnelsAPI,
  SandboxUtilsAPI,
  SandboxWatchAPI
} from '@repo/shared';
import { EXTENSION_TARBALL_REQUIRED } from '@repo/shared';
import { createSandboxProcess } from '../processes';
import type { ProcessRPCDescriptor } from '../processes/rpc-types';

// Re-export the wire types so consumers can author extensions from this
// subpath without reaching into `@repo/shared` directly.
export type { ExtensionHealth, ExtensionPackage } from '@repo/shared';

export type ExtensionRuntimeControl = {
  readonly files: SandboxFilesAPI;
  readonly ports: SandboxPortsAPI;
  readonly backup: SandboxBackupAPI;
  readonly watch: SandboxWatchAPI;
  readonly tunnels: SandboxTunnelsAPI;
  readonly terminals: SandboxTerminalsAPI;
  readonly extensions: SandboxExtensionsAPI;
  readonly utils: SandboxUtilsAPI;
};

type ExtensionRuntimeDomain =
  ExtensionRuntimeControl[keyof ExtensionRuntimeControl];

export type ExtensionRuntimeCallback = (
  control: ExtensionRuntimeControl
) => Promise<unknown>;

type ExtensionRuntimeResult<T> = T extends
  | ExtensionRuntimeControl
  | ExtensionRuntimeDomain
  ? never
  : T;

export type ExtensionRuntimeCallbackResult<
  Call extends ExtensionRuntimeCallback
> = Awaited<ReturnType<Call>>;

type RejectEscapingRuntimeCallback<Call extends ExtensionRuntimeCallback> =
  ExtensionRuntimeCallbackResult<Call> extends
    | ExtensionRuntimeControl
    | ExtensionRuntimeDomain
    ? never
    : unknown;

export type ExtensionRuntimeCall = <Call extends ExtensionRuntimeCallback>(
  operation: string,
  call: Call & RejectEscapingRuntimeCallback<Call>
) => Promise<ExtensionRuntimeCallbackResult<Call>>;

export const sandboxRuntimeCall: unique symbol = Symbol('sandboxRuntimeCall');

export interface HTTPAuthHostConfig {
  token: string;
  username?: string;
  type?: 'basic' | 'bearer';
}

export interface HTTPAuthInterceptorParams {
  hosts: Record<string, HTTPAuthHostConfig>;
}

export type SandboxLike = {
  readonly [sandboxRuntimeCall]: ExtensionRuntimeCall;
  readonly exec?: (
    command: SandboxCommand,
    options?: ExecOptions
  ) => Promise<SandboxProcess | ProcessRPCDescriptor>;
  readonly getProcess?: (
    processId: string
  ) => Promise<SandboxProcess | ProcessRPCDescriptor | null>;
  readonly listProcesses?: () => Promise<ProcessStatus[]>;
  readonly envVars?: Record<string, string>;
  registerGitAuthInterceptor?: (
    params: HTTPAuthInterceptorParams
  ) => Promise<void>;
};

export interface ExtensionProcessSandbox {
  exec(command: SandboxCommand, options?: ExecOptions): Promise<SandboxProcess>;
  getProcess(processId: string): Promise<SandboxProcess | null>;
  listProcesses(): Promise<ProcessStatus[]>;
}

function isProcessRPCDescriptor(
  process: SandboxProcess | ProcessRPCDescriptor
): process is ProcessRPCDescriptor {
  return 'capability' in process;
}

/** Normalize local RPC descriptors and caller-side handles for extensions. */
export function createExtensionProcessSandbox(
  sandbox: SandboxLike
): ExtensionProcessSandbox {
  return {
    async exec(command, options) {
      if (!sandbox.exec) {
        throw new Error(
          'Sandbox extension requires the exec surface from the owning Sandbox'
        );
      }
      const process = await sandbox.exec.call(sandbox, command, options);
      return isProcessRPCDescriptor(process)
        ? createSandboxProcess(process)
        : process;
    },
    async getProcess(processId) {
      if (!sandbox.getProcess) {
        throw new Error(
          'Sandbox extension requires the getProcess surface from the owning Sandbox'
        );
      }
      const process = await sandbox.getProcess.call(sandbox, processId);
      if (!process) return null;
      return isProcessRPCDescriptor(process)
        ? createSandboxProcess(process)
        : process;
    },
    listProcesses() {
      if (!sandbox.listProcesses) {
        throw new Error(
          'Sandbox extension requires the listProcesses surface from the owning Sandbox'
        );
      }
      return sandbox.listProcesses.call(sandbox);
    }
  };
}

/**
 * The one base class for *every* extension.
 *
 * - SDK-only: just drives existing sub-APIs.
 * - Sidecar: pass an {@link ExtensionPackage} to `super(sandbox, pkg)` and
 *   call `this.withSidecar<T>(operation, callback)` to use the typed capnweb stub inside one runtime callback.
 *
 * The sidecar helper throws a clear error if no package was supplied, so an
 * extension only "becomes" a sidecar extension when it opts in.
 *
 * ```ts
 * // SDK-only
 * class GitStatus extends SandboxExtension {
 *   constructor(s: SandboxLike) { super(s); }
 *   async status() {
 *     const process = await this.exec(['git', 'status']);
 *     return process.output({ encoding: 'utf8' });
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
 *     return this.withSidecar<MyAPI, string>('my-ext.run', (api) =>
 *       api.run(input)
 *     );
 *   }
 * }
 * ```
 *
 * RPC-safety: the sandbox lives in `#sandbox` and runtime control is reached
 * only through a symbol-keyed capability, so it is not exposed as a named RPC
 * method. Only the public methods you add form the extension's RPC surface.
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

  protected withRuntime<Call extends ExtensionRuntimeCallback>(
    operation: string,
    call: Call & RejectEscapingRuntimeCallback<Call>
  ): Promise<ExtensionRuntimeResult<ExtensionRuntimeCallbackResult<Call>>> {
    const guardedCall = async (runtimeControl: ExtensionRuntimeControl) => {
      const { control, revoke } = scopedRuntimeControl(runtimeControl);
      try {
        const result = await call(control);
        assertRuntimeControlDidNotEscape(result, control);
        return result;
      } finally {
        revoke();
      }
    };
    return this.#sandbox[sandboxRuntimeCall](
      operation,
      guardedCall as ExtensionRuntimeCallback
    ) as Promise<ExtensionRuntimeResult<ExtensionRuntimeCallbackResult<Call>>>;
  }

  /** Launch an argv process through the owning Sandbox. */
  protected exec(
    command: SandboxCommand,
    options?: ExecOptions
  ): Promise<SandboxProcess> {
    return createExtensionProcessSandbox(this.#sandbox).exec(command, options);
  }

  /** Sandbox-level environment applied to extension-launched processes. */
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
   * Provision/connect to the sidecar and use its typed capnweb remote inside
   * one runtime callback. The remote is invalid after `call` resolves or
   * rejects, so extension code cannot silently reconnect or keep using an old
   * runtime's sidecar.
   */
  protected async withSidecar<T extends object, Result>(
    operation: string,
    call: (api: T) => Promise<Result>
  ): Promise<Result> {
    const pkg = this.#requirePackage();
    const packageHash = await this.#hashOnce();
    const scopedCall = async (control: ExtensionRuntimeControl) => {
      const connected = await this.#connect<T>(
        control.extensions,
        pkg,
        packageHash
      );
      const { proxy, revoke } = scopedSidecarRemote<T>(connected);
      try {
        const result = await call(proxy);
        assertSidecarRemoteDidNotEscape(result);
        return detachPlainData(result) as Result;
      } finally {
        revoke();
      }
    };
    return (await this.withRuntime(
      operation,
      scopedCall as ExtensionRuntimeCallback
    )) as Result;
  }

  /** Health snapshot for this extension's sidecar. */
  protected async sidecarHealth(): Promise<ExtensionHealth> {
    const hash = await this.#hashOnce();
    return await this.withRuntime('extension.health', (control) =>
      control.extensions.health(hash)
    );
  }

  /**
   * Stop this extension's sidecar. The next `withSidecar()` call will respawn
   * it on demand.
   */
  protected async stopSidecar(): Promise<void> {
    const hash = await this.#hashOnce();
    await this.withRuntime('extension.stop', (control) =>
      control.extensions.stop(hash)
    );
  }

  // --- internals -----------------------------------------------------------

  async #connect<T extends object>(
    api: SandboxExtensionsAPI,
    pkg: ExtensionPackage,
    packageHash: string
  ): Promise<T> {
    try {
      return (await api.connect({
        packageHash,
        bin: pkg.bin,
        readinessTimeoutMs: pkg.readinessTimeoutMs,
        allowInstallScripts: pkg.allowInstallScripts
      })) as T;
    } catch (error) {
      if (!isTarballRequiredError(error)) throw error;
      try {
        return (await api.connect({
          packageHash,
          tarball: pkg.tarball,
          bin: pkg.bin,
          readinessTimeoutMs: pkg.readinessTimeoutMs,
          allowInstallScripts: pkg.allowInstallScripts
        })) as T;
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
function assertRuntimeControlDidNotEscape(
  result: unknown,
  control: ExtensionRuntimeControl
): void {
  const forbiddenHandles: unknown[] = [
    control,
    control.files,
    control.ports,
    control.backup,
    control.watch,
    control.tunnels,
    control.terminals,
    control.extensions,
    control.utils
  ].filter((handle) => handle !== undefined);

  if (!forbiddenHandles.includes(result)) return;

  throw new Error(
    'Sandbox extension runtime callbacks must not return runtime control handles'
  );
}

function scopedRuntimeControl(target: ExtensionRuntimeControl): {
  control: ExtensionRuntimeControl;
  revoke(): void;
} {
  let active = true;
  const inactiveError = () =>
    new Error(
      'Sandbox extension runtime control is no longer valid outside its runtime callback'
    );
  const wrappedDomains = new WeakMap<object, object>();
  const scopeDomain = <Domain extends object>(domain: Domain): Domain => {
    const existing = wrappedDomains.get(domain);
    if (existing) return existing as Domain;
    const proxy = new Proxy(domain, {
      get(domainTarget, property, receiver) {
        if (!active) return () => Promise.reject(inactiveError());
        const value = Reflect.get(domainTarget, property, receiver) as unknown;
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            if (!active) return Promise.reject(inactiveError());
            const result = Reflect.apply(value, domainTarget, args) as unknown;
            return scopeRuntimeResult(result);
          };
        }
        if (typeof value === 'object' && value !== null) {
          if (objectHasCallableMember(value)) return scopeDomain(value);
          return detachPlainData(value);
        }
        return value;
      }
    });
    wrappedDomains.set(domain, proxy);
    return proxy as Domain;
  };
  const scopeRuntimeResult = (result: unknown): unknown => {
    if (result instanceof Promise) {
      return result.then(scopeRuntimeResult);
    }
    if (typeof result === 'object' && result !== null) {
      if (objectHasCallableMember(result)) return scopeDomain(result);
      return detachPlainData(result);
    }
    return result;
  };

  const control: ExtensionRuntimeControl = {
    files: scopeDomain(target.files),
    ports: scopeDomain(target.ports),
    backup: scopeDomain(target.backup),
    watch: scopeDomain(target.watch),
    tunnels: scopeDomain(target.tunnels),
    terminals: scopeDomain(target.terminals),
    extensions: scopeDomain(target.extensions),
    utils: scopeDomain(target.utils)
  };
  return {
    control,
    revoke: () => {
      active = false;
    }
  };
}

const sidecarRemoteProxies = new WeakSet<object>();

function scopedSidecarRemote<T extends object>(
  target: T
): {
  proxy: T;
  revoke(): void;
} {
  let active = true;
  const wrappedTargets = new WeakMap<object, object>();
  const createProxy = <Value extends object>(currentTarget: Value): Value => {
    const existing = wrappedTargets.get(currentTarget);
    if (existing) return existing as Value;
    const proxy = new Proxy(currentTarget, {
      get(targetObject, property, receiver) {
        if (!active) {
          return () =>
            Promise.reject(
              new Error(
                'Sandbox extension sidecar remote is no longer valid outside its runtime callback'
              )
            );
        }
        const value = Reflect.get(targetObject, property, receiver) as unknown;
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            if (!active) {
              return Promise.reject(
                new Error(
                  'Sandbox extension sidecar remote is no longer valid outside its runtime callback'
                )
              );
            }
            const result = Reflect.apply(value, targetObject, args) as unknown;
            return wrapSidecarResult(result, createProxy);
          };
        }
        if (typeof value === 'object' && value !== null) {
          if (objectHasCallableMember(value)) return createProxy(value);
          return detachPlainData(value);
        }
        return value;
      }
    });
    wrappedTargets.set(currentTarget, proxy);
    sidecarRemoteProxies.add(proxy);
    return proxy as Value;
  };

  return {
    proxy: createProxy(target),
    revoke: () => {
      active = false;
    }
  };
}

function wrapSidecarResult(
  result: unknown,
  wrapObject: <Value extends object>(value: Value) => Value
): unknown {
  if (result instanceof Promise) {
    return result.then((value) => wrapSidecarResult(value, wrapObject));
  }
  if (typeof result === 'object' && result !== null) {
    if (objectHasCallableMember(result)) return wrapObject(result);
    return detachPlainData(result);
  }
  return result;
}

function objectHasCallableMember(value: object): boolean {
  if (Array.isArray(value))
    return value.some((entry) => typeof entry === 'function');
  let current: object | null = value;
  while (current && current !== Object.prototype) {
    for (const property of Reflect.ownKeys(current)) {
      if (property === 'constructor') continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
      if (!descriptor) continue;
      if (typeof descriptor.value === 'function') return true;
      if (typeof descriptor.get === 'function') return true;
    }
    current = Reflect.getPrototypeOf(current);
  }
  return false;
}

function assertSidecarRemoteDidNotEscape(result: unknown): void {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (sidecarRemoteProxies.has(value)) return true;
    if (Array.isArray(value)) return value.some(visit);
    return Object.values(value as Record<string, unknown>).some(visit);
  };

  if (!visit(result)) return;
  throw new Error(
    'Sandbox extension sidecar callbacks must not return sidecar remotes'
  );
}

function detachPlainData<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  return structuredClone(value) as T;
}

function isTarballRequiredError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; message?: unknown };
  if (candidate.name === EXTENSION_TARBALL_REQUIRED) return true;
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
