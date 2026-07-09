import { Container, getContainer, switchPort } from '@cloudflare/containers';
import type {
  BackupOptions,
  CheckChangesOptions,
  CheckChangesResult,
  CreateTerminalOptions,
  DirectoryBackup,
  ExecOptions,
  FileEncoding,
  ISandbox,
  ListFilesOptions,
  MountBucketOptions,
  PortWatchEvent,
  ProcessStatus,
  ReadFileResult,
  ReadFileStreamResult,
  RestoreBackupResult,
  SandboxCommand,
  SandboxOptions,
  Terminal,
  WaitForPortOptions,
  WatchOptions
} from '@repo/shared';
import {
  createLogger,
  getEnvString,
  logCanonicalEvent,
  partitionEnvVars,
  TraceContext
} from '@repo/shared';
import {
  getHttpStatus,
  getSuggestion,
  type OperationInterruptedContext
} from '@repo/shared/errors';
import {
  type BackupRestoreTestFault,
  BackupService
} from './backup/backup-service';
import { ContainerControlClient } from './container-control';
import { RuntimeControlClient } from './container-control/runtime-client';
import {
  CurrentRuntimeIdentity,
  type RuntimeIdentity
} from './current-runtime-identity';
import type { ErrorResponse } from './errors';
import {
  ContainerUnavailableError,
  ErrorCode,
  OperationInterruptedError,
  ProcessExitedBeforeReadyError,
  ProcessNotFoundError,
  ProcessReadyTimeoutError,
  SandboxError
} from './errors';
import type { HTTPAuthInterceptorParams as GitAuthInterceptorParams } from './extensions';
import { SandboxExtension } from './extensions';
import { collectFile, streamFile } from './file-stream';
import { isPlatformTransientError } from './platform-errors';
import { isPreviewProxyRequest } from './preview/protocol';
import {
  type PreviewForwardingContainer,
  PreviewService
} from './preview/service';
import { createSandboxProcess } from './processes';
import {
  type ProcessCapabilityControl,
  ProcessCapabilityTarget
} from './processes/process-capability';
import { ProcessLifecycle } from './processes/process-lifecycle';
import { openRemoteSubscription } from './processes/remote-subscription';
import type { ProcessRPCDescriptor } from './processes/rpc-types';
import { terminalHandle as terminalHandleFromSnapshot } from './pty';
import {
  ResourceActivityGate,
  type ResourceActivityOperation
} from './resource-activity-gate';
import { CurrentSandboxLifetime } from './sandbox-lifetime';
import {
  SandboxSecurityError,
  sanitizeSandboxId,
  validatePort
} from './security';
import { parseSSEStream } from './sse-parser';
import {
  BucketMountService,
  ContainerProxy,
  configureGitAuthInterceptor,
  type EgressContainerState,
  type MountOutboundHost
} from './storage-mount';
import { NamedTunnelConfigResolver } from './tunnels/named-tunnel-config';
import {
  createTunnelsHandle,
  type TunnelExitHandler,
  type TunnelsHandle,
  type TunnelsHandler
} from './tunnels/rpc-target';
import { SandboxControlCallbackImpl } from './tunnels/sandbox-control-callback';
import { SDK_VERSION } from './version';

export { ContainerProxy };

function validateExecArgv(command: SandboxCommand): SandboxCommand {
  if (!Array.isArray(command)) {
    throw invalidCommand('exec() requires argv as an array of strings.');
  }
  if (command.length === 0) {
    throw invalidCommand('exec() requires a non-empty argv command.');
  }
  const [executable] = command;
  if (typeof executable !== 'string' || executable.length === 0) {
    throw invalidCommand('exec() requires a non-empty executable.');
  }
  for (const [index, value] of command.entries()) {
    if (typeof value !== 'string') {
      throw invalidCommand(`exec() argv[${index}] must be a string.`);
    }
  }
  return command;
}

function invalidCommand(
  message: string
): SandboxError<Record<string, unknown>> {
  return new SandboxError({
    code: ErrorCode.INVALID_COMMAND,
    message,
    context: {},
    httpStatus: getHttpStatus(ErrorCode.INVALID_COMMAND),
    suggestion: getSuggestion(ErrorCode.INVALID_COMMAND, {}),
    timestamp: new Date().toISOString()
  });
}

function runtimeInterrupted(
  operation: string,
  effect: 'none' | 'unknown'
): OperationInterruptedError {
  const context: OperationInterruptedContext = {
    reason: 'runtime_replaced',
    operation,
    admitted: true,
    retryable: false,
    effect
  };
  return new OperationInterruptedError({
    code: ErrorCode.OPERATION_INTERRUPTED,
    message: `Sandbox operation ${operation} was interrupted because the runtime changed`,
    context,
    httpStatus: 409,
    timestamp: new Date().toISOString()
  });
}

function processCapabilityControl(
  client: ContainerControlClient
): ProcessCapabilityControl {
  const processes = client.processesWithoutActivity();
  return {
    getProcess: (id) => processes.get(id),
    openLogs: (id, options) => processes.openLogs(id, options),
    openPortWatch: (port, options) => client.ports.openWatch(port, options),
    kill: (id, signal) => processes.kill(id, signal)
  };
}

type SandboxConfiguration = {
  sandboxName?: {
    name: string;
    normalizeId?: boolean;
  };
  sleepAfter?: string | number;
  keepAlive?: boolean;
  containerTimeouts?: NonNullable<SandboxOptions['containerTimeouts']>;
};

type CachedSandboxConfiguration = {
  sandboxName?: string;
  normalizeId?: boolean;
  sleepAfter?: string | number;
  keepAlive?: boolean;
  containerTimeouts?: NonNullable<SandboxOptions['containerTimeouts']>;
};

type PreviewForwardingContainerState = DurableObjectState<{}> & {
  container?: PreviewForwardingContainer;
};

type PreviewForwardingLifecycleState = {
  inflightRequests?: number;
};

type ConfigurableSandboxStub = {
  configure?: (configuration: SandboxConfiguration) => Promise<void>;
  setSandboxName?: (name: string, normalizeId?: boolean) => Promise<void>;
  setSleepAfter?: (sleepAfter: string | number) => Promise<void>;
  setKeepAlive?: (keepAlive: boolean) => Promise<void>;
  setContainerTimeouts?: (
    timeouts: NonNullable<SandboxOptions['containerTimeouts']>
  ) => Promise<void>;
};

type SandboxProxyStub = ConfigurableSandboxStub & {
  fetch: (request: Request) => Promise<Response>;
  callExtension: (
    extensionName: string,
    method: string,
    args: unknown[]
  ) => Promise<unknown>;
  createTerminal: (options: CreateTerminalOptions) => Promise<Terminal>;
  getTerminal: (id: string) => Promise<Terminal | null>;
  listTerminals: () => Promise<Terminal[]>;
  exec: (
    command: SandboxCommand,
    options?: ExecOptions
  ) => Promise<ProcessRPCDescriptor>;
  getProcess: (id: string) => Promise<ProcessRPCDescriptor | null>;
  listProcesses: () => Promise<ProcessStatus[]>;
};

export type SandboxClient<T> = Omit<T, keyof ISandbox> & ISandbox;

const sandboxConfigurationCache = new WeakMap<
  object,
  Map<string, CachedSandboxConfiguration>
>();

const BACKUP_DEFAULT_TTL_SECONDS = 259200;
const BACKUP_MAX_NAME_LENGTH = 256;
const BACKUP_CONTAINER_DIR = '/var/backups';
const BACKUP_STORAGE_PREFIX = 'backups';
const BACKUP_ARCHIVE_OBJECT_NAME = 'data.sqsh';
const BACKUP_METADATA_OBJECT_NAME = 'meta.json';
const BACKUP_DEFAULT_COMPRESSION = 'lz4';
const BACKUP_DEFAULT_COMPRESS_THREADS = 8;
const BACKUP_MULTIPART_MIN_SIZE = 10 * 1024 * 1024;
const BACKUP_MULTIPART_TARGET_PARTS = 16;
const BACKUP_MULTIPART_MIN_PART_SIZE = 5 * 1024 * 1024;
const BACKUP_MULTIPART_MAX_PARTS = 64;
const BACKUP_DOWNLOAD_PARALLEL_PARTS = 8;
const BACKUP_DOWNLOAD_PARALLEL_MIN_SIZE = 10 * 1024 * 1024;
const BACKUP_DOWNLOAD_MAX_PARTS = 64;

function getNamespaceConfigurationCache(
  namespace: object
): Map<string, CachedSandboxConfiguration> {
  const existing = sandboxConfigurationCache.get(namespace);
  if (existing) {
    return existing;
  }

  const created = new Map<string, CachedSandboxConfiguration>();
  sandboxConfigurationCache.set(namespace, created);
  return created;
}

function sameContainerTimeouts(
  left?: NonNullable<SandboxOptions['containerTimeouts']>,
  right?: NonNullable<SandboxOptions['containerTimeouts']>
): boolean {
  return (
    left?.instanceGetTimeoutMS === right?.instanceGetTimeoutMS &&
    left?.portReadyTimeoutMS === right?.portReadyTimeoutMS &&
    left?.waitIntervalMS === right?.waitIntervalMS
  );
}

function buildSandboxConfiguration(
  effectiveId: string,
  options: SandboxOptions | undefined,
  cached: CachedSandboxConfiguration | undefined
): SandboxConfiguration {
  const configuration: SandboxConfiguration = {};

  if (
    cached?.sandboxName !== effectiveId ||
    cached.normalizeId !== options?.normalizeId
  ) {
    configuration.sandboxName = {
      name: effectiveId,
      normalizeId: options?.normalizeId
    };
  }

  if (
    options?.sleepAfter !== undefined &&
    cached?.sleepAfter !== options.sleepAfter
  ) {
    configuration.sleepAfter = options.sleepAfter;
  }

  if (
    options?.keepAlive !== undefined &&
    cached?.keepAlive !== options.keepAlive
  ) {
    configuration.keepAlive = options.keepAlive;
  }

  if (
    options?.containerTimeouts &&
    !sameContainerTimeouts(cached?.containerTimeouts, options.containerTimeouts)
  ) {
    configuration.containerTimeouts = options.containerTimeouts;
  }

  return configuration;
}

function hasSandboxConfiguration(configuration: SandboxConfiguration): boolean {
  return (
    configuration.sandboxName !== undefined ||
    configuration.sleepAfter !== undefined ||
    configuration.keepAlive !== undefined ||
    configuration.containerTimeouts !== undefined
  );
}

function mergeSandboxConfiguration(
  cached: CachedSandboxConfiguration | undefined,
  configuration: SandboxConfiguration
): CachedSandboxConfiguration {
  return {
    ...cached,
    ...(configuration.sandboxName && {
      sandboxName: configuration.sandboxName.name,
      normalizeId: configuration.sandboxName.normalizeId
    }),
    ...(configuration.sleepAfter !== undefined && {
      sleepAfter: configuration.sleepAfter
    }),
    ...(configuration.keepAlive !== undefined && {
      keepAlive: configuration.keepAlive
    }),
    ...(configuration.containerTimeouts !== undefined && {
      containerTimeouts: configuration.containerTimeouts
    })
  };
}

function applySandboxConfiguration(
  stub: ConfigurableSandboxStub,
  configuration: SandboxConfiguration
): Promise<void> {
  if (stub.configure) {
    return stub.configure(configuration);
  }

  const operations: Promise<void>[] = [];

  if (configuration.sandboxName) {
    operations.push(
      stub.setSandboxName?.(
        configuration.sandboxName.name,
        configuration.sandboxName.normalizeId
      ) ?? Promise.resolve()
    );
  }

  if (configuration.sleepAfter !== undefined) {
    operations.push(
      stub.setSleepAfter?.(configuration.sleepAfter) ?? Promise.resolve()
    );
  }

  if (configuration.keepAlive !== undefined) {
    operations.push(
      stub.setKeepAlive?.(configuration.keepAlive) ?? Promise.resolve()
    );
  }

  if (configuration.containerTimeouts !== undefined) {
    operations.push(
      stub.setContainerTimeouts?.(configuration.containerTimeouts) ??
        Promise.resolve()
    );
  }

  return Promise.all(operations).then(() => undefined);
}

function createPlatformInterruptedError(
  error: unknown,
  operation: string
): OperationInterruptedError | null {
  if (!isPlatformTransientError(error)) return null;

  const context: OperationInterruptedContext = {
    reason: 'runtime_replaced',
    operation,
    phase: 'durable_object_call',
    admitted: 'unknown',
    retryable: false
  };

  return new OperationInterruptedError({
    code: ErrorCode.OPERATION_INTERRUPTED,
    message: `Sandbox operation ${operation} was interrupted while the platform was updating the sandbox runtime`,
    context,
    httpStatus: getHttpStatus(ErrorCode.OPERATION_INTERRUPTED),
    suggestion: getSuggestion(
      ErrorCode.OPERATION_INTERRUPTED,
      context as unknown as Record<string, unknown>
    ),
    timestamp: new Date().toISOString()
  });
}

function translatePlatformInterruption(
  error: unknown,
  operation: string
): never {
  throw createPlatformInterruptedError(error, operation) ?? error;
}

function withSandboxOperationContext<TArgs extends unknown[], TResult>(
  operation: string,
  fn: (...args: TArgs) => TResult
): (...args: TArgs) => TResult {
  return (...args: TArgs): TResult => {
    try {
      const result = fn(...args);
      if (
        result != null &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        const caught = (result as unknown as Promise<unknown>).catch(
          (error: unknown) => translatePlatformInterruption(error, operation)
        );
        return caught as TResult;
      }
      return result;
    } catch (error) {
      translatePlatformInterruption(error, operation);
    }
  };
}

export function getSandbox<T extends Sandbox<any>>(
  ns: DurableObjectNamespace<T>,
  id: string,
  options?: SandboxOptions
): SandboxClient<T> {
  const sanitizedId = sanitizeSandboxId(id);
  const effectiveId = options?.normalizeId
    ? sanitizedId.toLowerCase()
    : sanitizedId;

  const hasUppercase = /[A-Z]/.test(sanitizedId);
  if (!options?.normalizeId && hasUppercase) {
    const logger = createLogger({ component: 'sandbox-do' });
    logger.warn(
      `Sandbox ID "${sanitizedId}" contains uppercase letters, which causes issues with preview URLs (hostnames are case-insensitive). ` +
        `normalizeId will default to true in a future version to prevent this. ` +
        `Use lowercase IDs or pass { normalizeId: true } to prepare.`
    );
  }

  const stub = getContainer(
    ns as unknown as DurableObjectNamespace<Container<Cloudflare.Env>>,
    effectiveId
  ) as unknown as T & SandboxProxyStub;

  const namespaceCache = getNamespaceConfigurationCache(ns);
  const cachedConfiguration = namespaceCache.get(effectiveId);
  const configuration = buildSandboxConfiguration(
    effectiveId,
    options,
    cachedConfiguration
  );

  if (hasSandboxConfiguration(configuration)) {
    const nextConfiguration = mergeSandboxConfiguration(
      cachedConfiguration,
      configuration
    );
    namespaceCache.set(effectiveId, nextConfiguration);

    void applySandboxConfiguration(stub, configuration).catch(() => {
      if (cachedConfiguration) {
        namespaceCache.set(effectiveId, cachedConfiguration);
        return;
      }

      namespaceCache.delete(effectiveId);
    });
  }

  const enhancedMethods = {
    fetch: (request: Request) => stub.fetch(request),
    exec: async (command: SandboxCommand, execOptions?: ExecOptions) =>
      createSandboxProcess(
        await stub.exec(command, sanitizeExecOptions(execOptions))
      ),
    getProcess: async (processId: string) => {
      const descriptor = await stub.getProcess(processId);
      return descriptor ? createSandboxProcess(descriptor) : null;
    },
    listProcesses: () => stub.listProcesses(),

    writeFile: (
      path: string,
      content: string | ReadableStream<Uint8Array>,
      fileOptions: { encoding?: string } = {}
    ) => stub.writeFile(path, content, fileOptions),
    readFile: (
      path: string,
      fileOptions:
        | { encoding: 'none' }
        | { encoding?: Exclude<FileEncoding, 'none'> } = {}
    ) => {
      if (fileOptions.encoding === 'none') {
        return stub.readFile(path, fileOptions);
      }
      return stub.readFile(path, fileOptions);
    },
    readFileStream: (path: string) => stub.readFileStream(path),
    mkdir: (path: string, mkdirOptions: { recursive?: boolean } = {}) =>
      stub.mkdir(path, mkdirOptions),
    deleteFile: (path: string) => stub.deleteFile(path),
    renameFile: (oldPath: string, newPath: string) =>
      stub.renameFile(oldPath, newPath),
    moveFile: (sourcePath: string, destinationPath: string) =>
      stub.moveFile(sourcePath, destinationPath),
    listFiles: (path: string, listOptions?: ListFilesOptions) =>
      stub.listFiles(path, listOptions),
    watch: (path: string, options: WatchOptions = {}) =>
      stub.watch(path, options),
    checkChanges: (path: string, options: CheckChangesOptions = {}) =>
      stub.checkChanges(path, options),
    createTerminal: (options: CreateTerminalOptions) =>
      stub.createTerminal(options),
    getTerminal: (id: string) => stub.getTerminal(id),
    listTerminals: () => stub.listTerminals(),
    wsConnect: connect(stub),
    tunnels: new Proxy({} as TunnelsHandler, {
      get: (_, method) => {
        if (typeof method !== 'string' || method === 'then') return undefined;
        return withSandboxOperationContext(
          `sandbox.tunnels.${method}`,
          (...args: unknown[]) => stub.callTunnels(method, args)
        );
      }
    })
  };

  // Proxy intercepts enhanced methods, passes all others to stub directly.
  // We must access target[prop] directly (not via Reflect.get with receiver)
  // to preserve the RPC stub's internal Proxy handling. The final assertion is
  // isolated to this Workers RPC boundary where process wire descriptors are
  // replaced by caller-local ISandbox handles.
  return new Proxy(stub, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in enhancedMethods) {
        const method = enhancedMethods[prop as keyof typeof enhancedMethods];
        if (typeof method === 'function') {
          return withSandboxOperationContext(
            `sandbox.${prop}`,
            method as (...args: unknown[]) => unknown
          );
        }
        return method;
      }
      if (typeof prop !== 'string' || prop === 'then') {
        // @ts-expect-error - RPC stub methods are Proxy-trapped, not visible to TypeScript
        return target[prop];
      }
      // @ts-expect-error - RPC stub methods are Proxy-trapped, not visible to TypeScript
      const value = target[prop];
      // Plain data properties (e.g. sleepAfter) pass through unchanged.
      if (value !== undefined && typeof value !== 'function') {
        return value;
      }
      // Methods and extension namespaces become a callable proxy: invoking it
      // forwards to the stub method (sandbox.method(...)), while a nested
      // access dispatches sandbox.<ext>.<method>(...) through callExtension.
      return new Proxy(
        (...args: unknown[]) => {
          // @ts-expect-error - RPC stub methods are Proxy-trapped, not visible to TypeScript
          return target[prop](...args);
        },
        {
          get: (_, method) => {
            if (typeof method !== 'string' || method === 'then') {
              return undefined;
            }
            return (...args: unknown[]) =>
              stub.callExtension(prop, method, args);
          }
        }
      );
    }
  }) as unknown as SandboxClient<T>;
}

function sanitizeExecOptions(options?: ExecOptions): ExecOptions | undefined {
  if (!options) return undefined;
  const sanitized: ExecOptions = {};
  if (options.cwd !== undefined) sanitized.cwd = options.cwd;
  if (options.env !== undefined) sanitized.env = options.env;
  if (options.timeout !== undefined) sanitized.timeout = options.timeout;
  return sanitized;
}

function getConcreteExtensionMethod(
  extension: SandboxExtension,
  method: string
): ((...args: unknown[]) => unknown) | undefined {
  const ownValue = (extension as unknown as Record<string, unknown>)[method];
  if (Object.hasOwn(extension, method) && typeof ownValue === 'function') {
    return ownValue as (...args: unknown[]) => unknown;
  }

  let prototype = Object.getPrototypeOf(extension) as object | null;
  while (
    prototype &&
    prototype !== SandboxExtension.prototype &&
    prototype !== Object.prototype
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
    if (typeof descriptor?.value === 'function') {
      return descriptor.value as (...args: unknown[]) => unknown;
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }

  return undefined;
}

export function connect(stub: {
  fetch: (request: Request) => Promise<Response>;
}) {
  return async (request: Request, port: number) => {
    if (!validatePort(port)) {
      throw new SandboxSecurityError(
        `Invalid port number: ${port}. Must be 1024-65535, excluding 3000 (sandbox control plane).`
      );
    }
    const portSwitchedRequest = switchPort(request, port);
    return await stub.fetch(portSwitchedRequest);
  };
}

export class Sandbox<Env = unknown> extends Container<Env> {
  defaultPort = 3000; // Default port for the container's Bun server
  sleepAfter: string | number = '10m'; // Sleep the sandbox if no requests are made in this timeframe

  client: ContainerControlClient;

  private sandboxName: string | null = null;
  // Tunnels subsystem handle. Lazily constructed on first access via the
  // `tunnels` getter or when sandbox lifecycle hooks need tunnel cleanup.
  // The public `tunnelsHandler` stays narrow while `tunnelServiceHandle`
  // carries internal runtime/destroy callbacks.
  private tunnelServiceHandle: TunnelsHandle | null = null;
  private tunnelsHandler: TunnelsHandler | null = null;
  private tunnelExitHandler: TunnelExitHandler | null = null;
  // capnweb localMain exposed to the container side of the RPC
  // session. Constructed once in the constructor (the lazy accessor
  // keeps it pointing at the current `tunnelExitHandler`), so the
  // container can call back into the DO without us re-binding the session.
  private readonly controlCallback: SandboxControlCallbackImpl;
  private normalizeId: boolean = false;
  envVars: Record<string, string> = {};
  private logger: ReturnType<typeof createLogger>;
  private keepAliveEnabled: boolean = false;
  private bucketMounts: BucketMountService;
  private currentRuntime: CurrentRuntimeIdentity;
  private currentLifetime: CurrentSandboxLifetime;
  private backupService: BackupService;
  private previewService: PreviewService;
  private resourceActivityGate: ResourceActivityGate;
  private runtimeControlClient: RuntimeControlClient;
  private processLifecycle: ProcessLifecycle;
  private controlSessionActivity: ResourceActivityOperation | null = null;

  private r2AccessKeyId: string | null = null;
  private r2SecretAccessKey: string | null = null;
  private namedTunnelConfigResolver: NamedTunnelConfigResolver;

  /**
   * Default container startup timeouts (conservative for production)
   * Based on Cloudflare docs: "Containers take several minutes to provision"
   */
  private readonly DEFAULT_CONTAINER_TIMEOUTS = {
    // Time to get container instance and launch VM
    // @cloudflare/containers default: 8s (too short for cold starts)
    instanceGetTimeoutMS: 30_000, // 30 seconds

    // Time for application to start and ports to be ready
    // @cloudflare/containers default: 20s
    portReadyTimeoutMS: 90_000, // 90 seconds (allows for heavy containers)

    // Polling interval for checking container readiness
    waitIntervalMS: 300
  };

  /**
   * Active container timeout configuration
   * Can be set via options, env vars, or defaults
   */
  private containerTimeouts = { ...this.DEFAULT_CONTAINER_TIMEOUTS };

  /**
   * True once containerTimeouts has been written to storage at least once
   * (either via setContainerTimeouts or restored on cold start). Gates the
   * idempotency check in setContainerTimeouts so a first explicit call
   * persists even when the requested values already equal the in-memory
   * defaults, distinguishing "user intent recorded" from "running on
   * env/SDK defaults".
   */
  private hasStoredContainerTimeouts = false;

  /**
   * Dispatch method for tunnel operations.
   * Called by the client-side proxy created in getSandbox() to provide
   * the `sandbox.tunnels` API without relying on RPC pipelining through
   * property getters, which vite-plugin does not currently support. This
   * local method dispatch uses standard function application, so new
   * Workers RPC pipelining traits on `TunnelsRpcTarget` also need an
   * explicit path here before the proxy can expose them.
   */
  async callTunnels(method: string, args: unknown[]): Promise<unknown> {
    if (!['get', 'list', 'destroy'].includes(method)) {
      throw new Error(`Unknown tunnels method: ${method}`);
    }
    const client = this.tunnels;
    const fn = client[method as keyof typeof client];
    if (typeof fn !== 'function') {
      throw new Error(`sandbox.tunnels missing method: ${method}`);
    }
    return (fn as (...a: unknown[]) => unknown).apply(client, args);
  }

  async callExtension(
    extensionName: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    if (method === 'constructor' || method === 'then') {
      throw new Error(`Unknown extension method: ${extensionName}.${method}`);
    }
    const extension = (this as unknown as Record<string, unknown>)[
      extensionName
    ];
    if (!(extension instanceof SandboxExtension)) {
      throw new Error(`Unknown sandbox extension: ${extensionName}`);
    }
    const fn = getConcreteExtensionMethod(extension, method);
    if (!fn) {
      throw new Error(`Unknown extension method: ${extensionName}.${method}`);
    }
    return fn.apply(extension, args);
  }

  /**
   * Compute the control-channel upgrade retry budget from current container
   * timeouts.
   *
   * The budget covers the full container startup window (instance provisioning
   * + port readiness) plus a 30s margin for the maximum single backoff delay.
   * The 120s floor preserves the default for short timeout configurations.
   */
  private computeRetryTimeoutMs(): number {
    const startupBudgetMs =
      this.containerTimeouts.instanceGetTimeoutMS +
      this.containerTimeouts.portReadyTimeoutMS;
    return Math.max(120_000, startupBudgetMs + 30_000);
  }

  private renewActivityTimeoutIfAvailable(): void {
    const renewActivityTimeout = this.renewActivityTimeout;
    if (typeof renewActivityTimeout === 'function') {
      renewActivityTimeout.call(this);
    }
  }

  /**
   * Create the single control-plane client used for all SDK operations.
   */
  private createClient(): ContainerControlClient {
    return new ContainerControlClient({
      stub: this,
      port: 3000,
      logger: this.logger,
      retryTimeoutMs: this.computeRetryTimeoutMs(),
      // localMain exposes the DO-side control callback (tunnel-exit
      // notifications, etc.) to the container side of the session.
      localMain: this.controlCallback,
      // The control channel multiplexes all work over a single capnweb
      // WebSocket, so we can't bracket per-request — and a method that
      // returns a ReadableStream resolves its promise long before the
      // stream is actually drained. Instead, ContainerControlClient polls
      // capnweb's session stats and reports busy/idle *transitions* of the
      // current session. The resource activity gate owns that operation
      // until the session returns to idle. See the file-level comment in
      // container-control/client.ts for details.
      onActivity: () => {
        this.resourceActivityGate.recordActivity();
      },
      onOperationStarted: () => {
        const activity = this.resourceActivityGate.beginOperation();
        return {
          beforeCall: activity.beforeCall.then(() =>
            this.ensureContainerRunning()
          ),
          finish: activity.finish
        };
      },
      onSessionBusy: () => {
        this.controlSessionActivity =
          this.resourceActivityGate.beginOperation();
      },
      onSessionIdle: () => {
        this.controlSessionActivity?.finish();
        this.controlSessionActivity = null;
      }
    });
  }

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);

    const envObj = env as Record<string, unknown>;
    const sandboxEnvKeys = ['SANDBOX_LOG_LEVEL', 'SANDBOX_LOG_FORMAT'] as const;
    sandboxEnvKeys.forEach((key) => {
      if (envObj?.[key]) {
        this.envVars[key] = String(envObj[key]);
      }
    });

    // Initialize timeouts with env var fallbacks
    this.containerTimeouts = this.getDefaultTimeouts(envObj);

    this.logger = createLogger({
      component: 'sandbox-do',
      sandboxId: this.ctx.id.toString()
    });

    this.currentRuntime = new CurrentRuntimeIdentity(
      this.ctx.storage,
      () => this.getState(),
      () => this.ctx.container?.running === true
    );
    this.currentLifetime = new CurrentSandboxLifetime(this.ctx.storage);
    this.namedTunnelConfigResolver = new NamedTunnelConfigResolver({
      getEnv: () => this.env
    });
    this.backupService = new BackupService({
      ctx: this.ctx,
      getEnv: () => this.env,
      logger: this.logger,
      getClient: () => this.client,
      currentRuntime: this.currentRuntime,
      currentLifetime: this.currentLifetime
    });

    this.r2AccessKeyId = getEnvString(envObj, 'R2_ACCESS_KEY_ID') ?? null;
    this.r2SecretAccessKey =
      getEnvString(envObj, 'R2_SECRET_ACCESS_KEY') ?? null;

    // Construct the control callback BEFORE the client — RPC clients
    // capture it as `localMain` on the capnweb session, and the
    // session is created eagerly in the connection's constructor.
    this.controlCallback = new SandboxControlCallbackImpl(
      () => this.tunnelExitHandler,
      this.logger
    );
    this.resourceActivityGate = new ResourceActivityGate(
      () => this.renewActivityTimeoutIfAvailable(),
      () => super.onActivityExpired()
    );
    this.runtimeControlClient = new RuntimeControlClient({
      getTcpPort: (port) => {
        const container = this.getPreviewForwardingContainer();
        if (!container) throw new Error('Container runtime is not available');
        return container.getTcpPort(port);
      },
      beginNonWakingOperation: () =>
        this.resourceActivityGate.beginNonWakingOperation(),
      logger: this.logger
    });
    this.currentRuntime.onChange(() => this.runtimeControlClient.dispose());
    this.processLifecycle = new ProcessLifecycle({
      currentRuntime: this.currentRuntime,
      runtimeClient: this.runtimeControlClient,
      beginNonWakingOperation: () =>
        this.resourceActivityGate.beginNonWakingOperation()
    });

    this.client = this.createClient();
    this.bucketMounts = new BucketMountService({
      getEnv: () => this.env,
      getEnvVars: () => this.envVars,
      getClient: () => this.client,
      logger: this.logger,
      currentRuntime: this.currentRuntime,
      currentLifetime: this.currentLifetime,
      getR2AccessKeyID: () => this.r2AccessKeyId,
      getR2SecretAccessKey: () => this.r2SecretAccessKey,
      getOutboundHost: () => this.getMountOutboundHost()
    });
    this.previewService = new PreviewService({
      storage: this.ctx.storage,
      logger: this.logger,
      currentRuntime: this.currentRuntime,
      getContainerState: () => this.getState(),
      getForwardingContainer: () => this.getPreviewForwardingContainer(),
      ensureRuntimeActiveForPreview: () => this.ensureRuntimeActiveForPreview(),
      getSandboxName: () => this.sandboxName,
      getNormalizeID: () => this.normalizeId,
      beginForward: () => this.beginPreviewForward(),
      renewActivity: () => this.renewActivityTimeout()
    });

    this.ctx.blockConcurrencyWhile(async () => {
      this.sandboxName =
        (await this.ctx.storage.get<string>('sandboxName')) ?? null;
      this.normalizeId =
        (await this.ctx.storage.get<boolean>('normalizeId')) ?? false;
      this.keepAliveEnabled =
        (await this.ctx.storage.get<boolean>('keepAliveEnabled')) ?? false;

      // Load saved timeout configuration (highest priority)
      const storedTimeouts =
        await this.ctx.storage.get<
          NonNullable<SandboxOptions['containerTimeouts']>
        >('containerTimeouts');
      if (storedTimeouts) {
        this.containerTimeouts = {
          ...this.containerTimeouts,
          ...storedTimeouts
        };
        this.hasStoredContainerTimeouts = true;
        // Update the control-channel retry budget to reflect stored timeouts.
        this.client.setRetryTimeoutMs(this.computeRetryTimeoutMs());
      }

      // Restore sleep timeout if previously set via RPC
      const storedSleepAfter = await this.ctx.storage.get<string | number>(
        'sleepAfter'
      );
      if (storedSleepAfter !== undefined) {
        this.sleepAfter = storedSleepAfter;
        this.renewActivityTimeout();
      }

      if (this.interceptHttps) {
        this.envVars = { ...this.envVars, SANDBOX_INTERCEPT_HTTPS: '1' };
      }
    });
  }

  // RPC method to set the sandbox name and normalizeId. Set-once — a
  // subsequent call is a no-op.
  //
  // sandboxName and normalizeId are one logical unit. Both storage.put
  // calls run without an intervening await, so they land in the same
  // in-memory write buffer and flush as a single atomic transaction on
  // SQLite-backed Durable Objects. In-memory state is updated only after
  // both writes commit.
  async setSandboxName(name: string, normalizeId?: boolean): Promise<void> {
    if (this.sandboxName !== null) return;
    const effectiveNormalizeId = normalizeId ?? false;

    await Promise.all([
      this.ctx.storage.put('sandboxName', name),
      this.ctx.storage.put('normalizeId', effectiveNormalizeId)
    ]);

    this.sandboxName = name;
    this.normalizeId = effectiveNormalizeId;
  }

  async configure(configuration: SandboxConfiguration): Promise<void> {
    if (configuration.sandboxName) {
      await this.setSandboxName(
        configuration.sandboxName.name,
        configuration.sandboxName.normalizeId
      );
    }

    if (configuration.sleepAfter !== undefined) {
      await this.setSleepAfter(configuration.sleepAfter);
    }

    if (configuration.keepAlive !== undefined) {
      await this.setKeepAlive(configuration.keepAlive);
    }

    if (configuration.containerTimeouts !== undefined) {
      await this.setContainerTimeouts(configuration.containerTimeouts);
    }
  }

  // RPC method to set the sleep timeout. Idempotent: re-applying the same
  // value returns early with no storage write and no timer reset. A real
  // change persists, then reschedules the activity timer against the new
  // window length.
  async setSleepAfter(sleepAfter: string | number): Promise<void> {
    if (this.sleepAfter === sleepAfter) return;
    await this.ctx.storage.put('sleepAfter', sleepAfter);
    this.sleepAfter = sleepAfter;
    this.renewActivityTimeout();
  }

  // RPC method to enable keepAlive mode. Idempotent: re-applying the same
  // value returns early. When disabling (true to false), the activity
  // timer is renewed so the inactivity window counts from now.
  async setKeepAlive(keepAlive: boolean): Promise<void> {
    if (this.keepAliveEnabled === keepAlive) return;
    await this.ctx.storage.put('keepAliveEnabled', keepAlive);
    this.keepAliveEnabled = keepAlive;

    if (!keepAlive) {
      this.renewActivityTimeout();
    }
  }

  async setEnvVars(envVars: Record<string, string | undefined>): Promise<void> {
    const { toSet, toUnset } = partitionEnvVars(envVars);

    for (const key of toUnset) {
      delete this.envVars[key];
    }
    this.envVars = { ...this.envVars, ...toSet };
  }

  async setContainerTimeouts(
    timeouts: NonNullable<SandboxOptions['containerTimeouts']>
  ): Promise<void> {
    const validated = { ...this.containerTimeouts };

    if (timeouts.instanceGetTimeoutMS !== undefined) {
      validated.instanceGetTimeoutMS = this.validateTimeout(
        timeouts.instanceGetTimeoutMS,
        'instanceGetTimeoutMS',
        5_000,
        300_000
      );
    }

    if (timeouts.portReadyTimeoutMS !== undefined) {
      validated.portReadyTimeoutMS = this.validateTimeout(
        timeouts.portReadyTimeoutMS,
        'portReadyTimeoutMS',
        10_000,
        600_000
      );
    }

    if (timeouts.waitIntervalMS !== undefined) {
      validated.waitIntervalMS = this.validateTimeout(
        timeouts.waitIntervalMS,
        'waitIntervalMS',
        100,
        5_000
      );
    }

    if (
      this.hasStoredContainerTimeouts &&
      validated.instanceGetTimeoutMS ===
        this.containerTimeouts.instanceGetTimeoutMS &&
      validated.portReadyTimeoutMS ===
        this.containerTimeouts.portReadyTimeoutMS &&
      validated.waitIntervalMS === this.containerTimeouts.waitIntervalMS
    ) {
      return;
    }

    await this.ctx.storage.put('containerTimeouts', validated);
    this.containerTimeouts = validated;
    this.hasStoredContainerTimeouts = true;
    this.client.setRetryTimeoutMs(this.computeRetryTimeoutMs());
    this.logger.debug('Container timeouts updated', this.containerTimeouts);
  }

  private validateTimeout(
    value: number,
    name: string,
    min: number,
    max: number
  ): number {
    if (
      typeof value !== 'number' ||
      Number.isNaN(value) ||
      !Number.isFinite(value)
    ) {
      throw new Error(`${name} must be a valid finite number, got ${value}`);
    }

    if (value < min || value > max) {
      throw new Error(
        `${name} must be between ${min}-${max}ms, got ${value}ms`
      );
    }

    return value;
  }

  private getDefaultTimeouts(
    env: Record<string, unknown>
  ): typeof this.DEFAULT_CONTAINER_TIMEOUTS {
    const parseAndValidate = (
      envVar: string | undefined,
      name: keyof typeof this.DEFAULT_CONTAINER_TIMEOUTS,
      min: number,
      max: number
    ): number => {
      const defaultValue = this.DEFAULT_CONTAINER_TIMEOUTS[name];

      if (envVar === undefined) {
        return defaultValue;
      }

      const parsed = parseInt(envVar, 10);

      if (Number.isNaN(parsed)) {
        this.logger.warn(
          `Invalid ${name}: "${envVar}" is not a number. Using default: ${defaultValue}ms`
        );
        return defaultValue;
      }

      if (parsed < min || parsed > max) {
        this.logger.warn(
          `Invalid ${name}: ${parsed}ms. Must be ${min}-${max}ms. Using default: ${defaultValue}ms`
        );
        return defaultValue;
      }

      return parsed;
    };

    return {
      instanceGetTimeoutMS: parseAndValidate(
        getEnvString(env, 'SANDBOX_INSTANCE_TIMEOUT_MS'),
        'instanceGetTimeoutMS',
        5_000,
        300_000
      ),
      portReadyTimeoutMS: parseAndValidate(
        getEnvString(env, 'SANDBOX_PORT_TIMEOUT_MS'),
        'portReadyTimeoutMS',
        10_000,
        600_000
      ),
      waitIntervalMS: parseAndValidate(
        getEnvString(env, 'SANDBOX_POLL_INTERVAL_MS'),
        'waitIntervalMS',
        100,
        5_000
      )
    };
  }

  /**
   * Mount an S3-compatible bucket as a local directory.
   */
  async mountBucket(
    bucket: string,
    mountPath: string,
    options: MountBucketOptions
  ): Promise<void> {
    return this.bucketMounts.mountBucket(bucket, mountPath, options);
  }

  /**
   * Manually unmount a bucket filesystem.
   */
  async unmountBucket(mountPath: string): Promise<void> {
    return this.bucketMounts.unmountBucket(mountPath);
  }

  /**
   * In-flight `destroy()` promise. While set, concurrent callers coalesce
   * onto the same teardown instead of triggering a second one. Cleared when
   * the underlying work settles, so a later call that genuinely needs to
   * recreate a destroyed sandbox still runs.
   *
   * If the underlying teardown hangs (e.g. `super.destroy()` never resolves
   * because the Containers control plane is unresponsive), every coalesced
   * caller hangs on the same promise until the Durable Object is evicted.
   * This is deliberate: a second concurrent teardown would not make a stuck
   * control plane unstuck, and spawning one would defeat the point of
   * coalescing. Callers that need bounded waits must apply their own
   * timeout around `destroy()`.
   */
  private inflightDestroy: Promise<void> | null = null;

  /**
   * Cleanup and destroy the sandbox container.
   *
   * Concurrent calls coalesce: if a previous `destroy()` is still in flight,
   * subsequent calls await the same underlying work instead of starting a
   * second teardown. A canonical `sandbox.destroy.coalesced` event is logged
   * per coalesced call so repeated destroy traffic is observable.
   */
  override async destroy(): Promise<void> {
    if (this.inflightDestroy) {
      logCanonicalEvent(this.logger, {
        event: 'sandbox.destroy.coalesced',
        outcome: 'success',
        durationMs: 0
      });
      return this.inflightDestroy;
    }

    // Assigned synchronously so concurrent callers observe the promise
    // before any await point inside doDestroy().
    const work = this.doDestroy();
    this.inflightDestroy = work;
    try {
      await work;
    } finally {
      // Clears only if the field still references this teardown.
      if (this.inflightDestroy === work) {
        this.inflightDestroy = null;
      }
    }
  }

  private async doDestroy(): Promise<void> {
    const startTime = Date.now();
    let mountsProcessed = 0;
    let mountFailures = 0;
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;

    try {
      // Preview URL auth and activation are cleared before await-heavy
      // teardown work. Concurrent preview traffic should observe missing
      // auth or runtime state and fail from DO-owned state without reaching
      // the container.
      await this.previewService.clearPreviewState();
      await this.currentLifetime.rotate();
      await this.currentRuntime.clear();

      // Unmount all mounted buckets and cleanup before disconnecting the
      // control client used by the mount lifecycle RPCs.
      ({ mountsProcessed, mountFailures } =
        await this.bucketMounts.cleanupForDestroy());
      if (mountFailures > 0) {
        throw new Error(
          `Failed to clean up ${mountFailures} bucket mount${mountFailures === 1 ? '' : 's'} during destroy()`
        );
      }

      // Tear down every tunnel this sandbox created — stops the
      // container-side cloudflared processes and removes the Cloudflare
      // tunnel + DNS resources for named tunnels. Runs before disconnect
      // because destroyAll needs the container RPC. Best-effort per port;
      // a failure on one doesn't block the rest of teardown.
      //
      // Lazily build the handler so destroyAll runs even on a sandbox
      // that never accessed `tunnels` during its lifetime — storage may
      // hold records from a prior lifetime under the same DO id.
      try {
        this.ensureTunnelsBuilt();
        await this.tunnelServiceHandle?.destroyAll();
      } catch (error) {
        this.logger.warn('Failed to tear down tunnels during destroy()', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      await this.tunnelServiceHandle?.clearDurableStateAfterDestroy();

      // Disconnect the control client after all cleanup commands complete.
      this.client.disconnect();

      outcome = 'success';
      await super.destroy();
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'sandbox.destroy',
        outcome,
        durationMs: Date.now() - startTime,
        mountsProcessed,
        mountFailures,
        error: caughtError
      });
    }
  }

  override async onStart() {
    this.logger.debug('Sandbox started');

    await this.currentRuntime.markStarted();

    // Fire-and-forget: version check is observability, not load-bearing.
    this.checkVersionCompatibility().catch((error) => {
      this.logger.error(
        'Version compatibility check failed',
        error instanceof Error ? error : new Error(String(error))
      );
    });

    // Reconcile tunnel storage with the fresh container inside
    // onStart's blockConcurrencyWhile gate so any get() that arrived
    // during startup sees tunnel state for the current runtime.
    try {
      this.ensureTunnelsBuilt();
      await this.tunnelServiceHandle?.onRuntimeStart();
    } catch (error) {
      this.logger.error(
        'Failed to reconcile tunnel storage after container start',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  override async stop(
    signal?: Parameters<Container<Env>['stop']>[0]
  ): Promise<void> {
    this.runtimeControlClient.dispose();
    this.client.disconnect();
    await this.currentRuntime.clear();
    await this.previewService.clearActivePreviewPorts();
    await super.stop(signal);
  }

  /**
   * Check if the container version matches the SDK version
   * Logs a warning if there's a mismatch
   */
  private async checkVersionCompatibility(): Promise<void> {
    const sdkVersion = SDK_VERSION;
    let containerVersion: string | undefined;
    let outcome: string;

    try {
      containerVersion = await this.client.utils.getVersion();

      if (containerVersion === 'unknown') {
        outcome = 'container_version_unknown';
      } else if (containerVersion !== sdkVersion) {
        outcome = 'version_mismatch';
      } else {
        outcome = 'compatible';
      }
    } catch (error) {
      outcome = 'check_failed';
      containerVersion = undefined;
    }

    const successLevel =
      outcome === 'compatible'
        ? ('debug' as const)
        : outcome === 'container_version_unknown'
          ? ('info' as const)
          : ('warn' as const); // version_mismatch or check_failed

    logCanonicalEvent(
      this.logger,
      {
        event: 'version.check',
        outcome: 'success',
        durationMs: 0,
        sdkVersion,
        containerVersion: containerVersion ?? 'unknown',
        versionOutcome: outcome
      },
      { successLevel }
    );
  }

  override async onStop() {
    this.logger.debug('Sandbox stopped');

    this.runtimeControlClient.dispose();
    await this.currentRuntime.clear();
    await this.previewService.clearActivePreviewPorts();

    try {
      this.ensureTunnelsBuilt();
      await this.tunnelServiceHandle?.onRuntimeStop();
    } catch (error) {
      this.logger.error(
        'Failed to reconcile tunnel storage after container stop',
        error instanceof Error ? error : new Error(String(error))
      );
    }

    // Stop local sync managers and clear runtime-scoped mount state before
    // closing the control client; FUSE cleanup may need container RPC.
    await this.bucketMounts.cleanupForStop();

    // Disconnect the active client so open sockets do not hold the DO alive.
    this.client.disconnect();

    // Port tokens are durable authorization and survive container restarts;
    // runtime-scoped preview activation is cleared separately above.
  }

  override onError(error: unknown) {
    this.logger.error(
      'Sandbox error',
      error instanceof Error ? error : new Error(String(error))
    );
  }

  /**
   * Override Container.containerFetch to use production-friendly timeouts
   * Automatically starts container with longer timeouts if not running
   */
  override async containerFetch(
    requestOrUrl: Request | string | URL,
    portOrInit?: number | RequestInit,
    portParam?: number
  ): Promise<Response> {
    // Parse arguments to extract request and port
    const { request, port } = this.parseContainerFetchArgs(
      requestOrUrl,
      portOrInit,
      portParam
    );

    const activity = this.resourceActivityGate.beginOperation();
    try {
      await activity.beforeCall;

      const state = await this.getState();
      const containerRunning = this.ctx.container?.running;

      // Start container if persisted state is not healthy OR if runtime reports container is not running.
      // The runtime check catches stale persisted state (e.g., state says 'healthy' after DO recreation
      // but Docker container is gone).
      const staleStateDetected =
        state.status === 'healthy' && containerRunning === false;
      if (state.status !== 'healthy' || containerRunning === false) {
        try {
          await this.startAndWaitForPorts({
            ports: port,
            cancellationOptions: {
              instanceGetTimeoutMS: this.containerTimeouts.instanceGetTimeoutMS,
              portReadyTimeoutMS: this.containerTimeouts.portReadyTimeoutMS,
              waitInterval: this.containerTimeouts.waitIntervalMS,
              abort: request.signal
            }
          });
        } catch (e) {
          // 1. Provisioning: Container VM not yet available
          if (this.isNoInstanceError(e)) {
            const errorBody: ErrorResponse = {
              code: ErrorCode.CONTAINER_UNAVAILABLE,
              message:
                'Container is currently provisioning. This can take several minutes on first deployment.',
              context: { reason: 'container_starting', retryable: true },
              httpStatus: 503,
              timestamp: new Date().toISOString(),
              suggestion:
                'The container is still being provisioned. Retry the operation in a moment.'
            };
            return new Response(JSON.stringify(errorBody), {
              status: 503,
              headers: {
                'Content-Type': 'application/json',
                'Retry-After': '10'
              }
            });
          }

          // 2. Permanent errors: Resource exhaustion, misconfiguration, bad image
          // These will never recover on retry — fail fast so the caller gets a clear signal.
          // Checked before transient to avoid broad transient patterns (e.g., "container did not
          // start") masking specific permanent causes in wrapped error messages.
          if (this.isPermanentStartupError(e)) {
            this.logger.error(
              'Permanent container startup error, returning 500',
              e instanceof Error ? e : new Error(String(e))
            );
            const errorBody: ErrorResponse = {
              code: ErrorCode.INTERNAL_ERROR,
              message:
                'Container failed to start due to a permanent error. Check your container configuration.',
              context: {
                phase: 'startup',
                error: e instanceof Error ? e.message : String(e)
              },
              httpStatus: 500,
              timestamp: new Date().toISOString(),
              suggestion:
                'This error will not resolve with retries. Check container logs, image name, and resource limits.'
            };
            return new Response(JSON.stringify(errorBody), {
              status: 500,
              headers: {
                'Content-Type': 'application/json'
              }
            });
          }

          // 3. Transient startup errors: Container starting, port not ready yet
          if (this.isTransientStartupError(e)) {
            // If startup failed after detecting stale state, the container runtime is likely stuck
            // (e.g., workerd can't restart after an unexpected container death). Abort the DO so the
            // next request gets a fresh instance with a clean container binding. This mirrors the
            // recovery pattern in the base Container class for 'Network connection lost' errors.
            if (staleStateDetected) {
              this.logger.warn('container.startup', {
                outcome: 'stale_state_abort',
                staleStateDetected: true,
                error: e instanceof Error ? e.message : String(e)
              });
              this.ctx.abort();
            } else {
              this.logger.debug('container.startup', {
                outcome: 'transient_error',
                staleStateDetected,
                error: e instanceof Error ? e.message : String(e)
              });
            }
            const errorBody: ErrorResponse = {
              code: ErrorCode.CONTAINER_UNAVAILABLE,
              message: 'Container is starting. Please retry in a moment.',
              context: { reason: 'container_starting', retryable: true },
              httpStatus: 503,
              timestamp: new Date().toISOString(),
              suggestion:
                'The container is not ready yet. Retry the operation in a moment.'
            };
            return new Response(JSON.stringify(errorBody), {
              status: 503,
              headers: {
                'Content-Type': 'application/json',
                'Retry-After': '3'
              }
            });
          }

          // 4. Unrecognized errors: Treat as transient since retries are safe
          // and new platform error messages may not yet be in our pattern list.
          this.logger.warn('container.startup', {
            outcome: 'unrecognized_error',
            staleStateDetected,
            error: e instanceof Error ? e.message : String(e)
          });
          const errorBody: ErrorResponse = {
            code: ErrorCode.CONTAINER_UNAVAILABLE,
            message: 'Container is starting. Please retry in a moment.',
            context: { reason: 'container_starting', retryable: true },
            httpStatus: 503,
            timestamp: new Date().toISOString(),
            suggestion:
              'The container is not ready yet. Retry the operation in a moment.'
          };
          return new Response(JSON.stringify(errorBody), {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '5'
            }
          });
        }
      }

      // Delegate to parent for the actual fetch (handles TCP port access internally)
      return await super.containerFetch(requestOrUrl, portOrInit, portParam);
    } finally {
      activity.finish();
    }
  }

  private async ensureContainerRunning(signal?: AbortSignal): Promise<void> {
    const state = await this.getState();
    if (state.status === 'healthy' && this.ctx.container?.running === true) {
      return;
    }

    await this.start({
      envVars: this.envVars,
      entrypoint: this.entrypoint,
      enableInternet: this.enableInternet,
      labels: this.labels
    });

    if (signal?.aborted) {
      throw new Error('Operation was aborted');
    }
  }

  /**
   * Helper: Check if error is "no container instance available"
   * This indicates the container VM is still being provisioned.
   */
  private isNoInstanceError(error: unknown): boolean {
    return (
      error instanceof Error &&
      error.message.toLowerCase().includes('no container instance')
    );
  }

  /**
   * Helper: Check if error is a transient startup error that should trigger retry
   *
   * These errors occur during normal container startup and are recoverable:
   * - Port not yet mapped (container starting, app not listening yet)
   * - Connection refused (port mapped but app not ready)
   * - Timeouts during startup (recoverable with retry)
   * - Network transients (temporary connectivity issues)
   *
   * Errors NOT included (permanent failures):
   * - "no such image" - missing Docker image
   * - "container already exists" - name collision
   * - Configuration errors
   */
  private isTransientStartupError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    const msg = error.message.toLowerCase();

    // Transient errors from workerd container-client.c++ and @cloudflare/containers
    const transientPatterns = [
      // Port mapping race conditions (workerd DockerPort::connect)
      'container port not found',
      'connection refused: container port',

      // Application startup delays (@cloudflare/containers)
      'the container is not listening',
      'failed to verify port',
      'container did not start',

      // Network transients (workerd)
      'network connection lost',
      'container suddenly disconnected',

      // Monitor race conditions (workerd)
      'monitor failed to find container',

      // Container crashed during startup or from previous run (@cloudflare/containers)
      'container exited with unexpected exit code',
      'container exited before we could determine',

      // Timeouts (various layers)
      'timed out',
      'timeout',
      'the operation was aborted'
    ];

    return transientPatterns.some((pattern) => msg.includes(pattern));
  }

  /**
   * Helper: Check if error is a permanent startup failure that will never recover
   *
   * These errors indicate resource exhaustion, misconfiguration, or missing images.
   * Retrying will never succeed, so the SDK should fail fast with HTTP 500.
   *
   * Error sources (traced from platform internals):
   *   - Container runtime: OOM, PID limit
   *   - Scheduling/provisioning: no matching app, no namespace configured
   *   - workerd container-client.c++: no such image
   *   - @cloudflare/containers: did not call start
   */
  private isPermanentStartupError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    const msg = error.message.toLowerCase();

    const permanentPatterns = [
      // Resource exhaustion (container runtime)
      'ran out of memory',
      'too many subprocesses',

      // Misconfiguration (scheduling/provisioning)
      'no application that matches',
      'no container application assigned',

      // Missing image (workerd container-client.c++)
      'no such image',

      // User error (@cloudflare/containers)
      'did not call start'
    ];

    return permanentPatterns.some((pattern) => msg.includes(pattern));
  }

  /**
   * Helper: Parse containerFetch arguments (supports multiple signatures)
   */
  private parseContainerFetchArgs(
    requestOrUrl: Request | string | URL,
    portOrInit?: number | RequestInit,
    portParam?: number
  ): { request: Request; port: number } {
    let request: Request;
    let port: number | undefined;

    if (requestOrUrl instanceof Request) {
      request = requestOrUrl;
      port = typeof portOrInit === 'number' ? portOrInit : undefined;
    } else {
      const url =
        typeof requestOrUrl === 'string'
          ? requestOrUrl
          : requestOrUrl.toString();
      const init = typeof portOrInit === 'number' ? {} : portOrInit || {};
      port =
        typeof portOrInit === 'number'
          ? portOrInit
          : typeof portParam === 'number'
            ? portParam
            : undefined;
      request = new Request(url, init);
    }

    port ??= this.defaultPort;

    if (port === undefined) {
      throw new Error('No port specified for container fetch');
    }

    return { request, port };
  }

  override async onActivityExpired(): Promise<void> {
    await this.resourceActivityGate.runExpiry(
      {
        availability: async () => {
          const state = await this.getState();
          if (state.status !== 'healthy') return 'absent';
          if (this.ctx.container?.running === false) return 'absent';
          if (this.ctx.container?.running !== true) return 'unknown';
          return 'available';
        },
        processesHasActive: () =>
          this.client.processesWithoutActivity().hasActive(),
        terminalsHasActive: () =>
          this.client.terminalsWithoutActivity().hasActive()
      },
      this.keepAliveEnabled
    );
  }

  private getPreviewForwardingContainer(): PreviewForwardingContainerState['container'] {
    return (this.ctx as PreviewForwardingContainerState).container;
  }

  private beginPreviewForward(): () => void {
    const lifecycle = this as unknown as PreviewForwardingLifecycleState;
    lifecycle.inflightRequests = (lifecycle.inflightRequests ?? 0) + 1;
    this.renewActivityTimeout();

    let settled = false;
    return () => {
      if (settled) {
        return;
      }
      settled = true;
      lifecycle.inflightRequests = Math.max(
        0,
        (lifecycle.inflightRequests ?? 0) - 1
      );
      if (lifecycle.inflightRequests === 0) {
        this.renewActivityTimeout();
      }
    };
  }

  // Override fetch to route internal container requests to appropriate ports
  override async fetch(request: Request): Promise<Response> {
    // Extract or generate trace ID from request
    const traceId =
      TraceContext.fromHeaders(request.headers) || TraceContext.generate();

    // Create request-specific logger with trace ID
    const requestLogger = this.logger.child({ traceId, operation: 'fetch' });

    const url = new URL(request.url);

    if (isPreviewProxyRequest(request)) {
      return await this.previewService.proxyPreviewRequest(request);
    }

    // Capture and store the sandbox name from the header if present
    if (!this.sandboxName && request.headers.has('X-Sandbox-Name')) {
      const name = request.headers.get('X-Sandbox-Name')!;
      this.sandboxName = name;
      await this.ctx.storage.put('sandboxName', name);
    }

    // Detect WebSocket upgrade request (RFC 6455 compliant)
    const upgradeHeader = request.headers.get('Upgrade');
    const connectionHeader = request.headers.get('Connection');
    const isWebSocket =
      upgradeHeader?.toLowerCase() === 'websocket' &&
      connectionHeader?.toLowerCase().includes('upgrade');

    if (isWebSocket) {
      // WebSocket path: Let parent Container class handle WebSocket proxying
      // This bypasses containerFetch() which uses JSRPC and cannot handle WebSocket upgrades
      try {
        requestLogger.debug('WebSocket upgrade requested', {
          path: url.pathname,
          port: this.determinePort(url)
        });
        return await super.fetch(request);
      } catch (error) {
        requestLogger.error(
          'WebSocket connection failed',
          error instanceof Error ? error : new Error(String(error)),
          { path: url.pathname }
        );
        throw error;
      }
    }

    // Non-WebSocket: Use existing port determination and HTTP routing logic
    const port = this.determinePort(url);

    // Route to the appropriate port
    return await this.containerFetch(request, port);
  }

  wsConnect(request: Request, port: number): Promise<Response> {
    // Stub - actual implementation is attached by getSandbox() on the stub object
    throw new Error(
      'wsConnect must be called on the stub returned by getSandbox()'
    );
  }

  async createTerminal(options: CreateTerminalOptions): Promise<Terminal> {
    return terminalHandleFromSnapshot(
      this.terminalStub(),
      await this.client.terminals.create(options)
    );
  }

  async getTerminal(id: string): Promise<Terminal | null> {
    const snapshot = await this.client.terminals.get(id);
    return snapshot
      ? terminalHandleFromSnapshot(this.terminalStub(), snapshot)
      : null;
  }

  async listTerminals(): Promise<Terminal[]> {
    return (await this.client.terminals.list()).map((snapshot) =>
      terminalHandleFromSnapshot(this.terminalStub(), snapshot)
    );
  }

  private terminalStub() {
    const terminals = this.client.terminals;
    return {
      create: (options: CreateTerminalOptions) => terminals.create(options),
      get: (id: string) => terminals.get(id),
      list: () => terminals.list(),
      output: (id: string, options?: Parameters<typeof terminals.output>[1]) =>
        terminals.output(id, options),
      write: (id: string, data: Uint8Array) => terminals.write(id, data),
      resize: (id: string, cols: number, rows: number) =>
        terminals.resize(id, cols, rows),
      interrupt: (id: string) => terminals.interrupt(id),
      terminate: (id: string) => terminals.terminate(id),
      hasActive: () => terminals.hasActive(),
      fetch: (request: Request) => this.fetch(request)
    };
  }

  private determinePort(url: URL): number {
    // Direct DO fetch compatibility path used by switchPort()/wsConnect().
    // Public preview URL traffic enters through proxyPreviewRequest() instead.
    const proxyMatch = url.pathname.match(/^\/proxy\/(\d+)/);
    if (proxyMatch) {
      return parseInt(proxyMatch[1], 10);
    }

    // Direct fetch compatibility defaults to the container server port.
    // SDK control operations use ContainerControlClient over /rpc instead.
    return 3000;
  }

  async exec(
    command: SandboxCommand,
    options: ExecOptions = {}
  ): Promise<ProcessRPCDescriptor> {
    const argv = validateExecArgv(command);
    const startTime = Date.now();
    const commandText = argv.join(' ');
    const activity = this.resourceActivityGate.beginOperation();

    try {
      await activity.beforeCall;
      await this.ensureContainerRunning();
      const owningRuntime = await this.currentRuntime.get();
      if (!owningRuntime) {
        throw runtimeInterrupted('process.start', 'none');
      }
      await this.assertLaunchRuntime(owningRuntime, 'none');

      const status = await this.client.processes.start(argv, options);
      await this.assertLaunchRuntime(owningRuntime, 'unknown');
      const descriptor = this.processDescriptor(status, owningRuntime);

      logCanonicalEvent(this.logger, {
        event: 'sandbox.exec',
        outcome: 'success',
        command: commandText,
        processId: status.id,
        pid: status.pid,
        durationMs: Date.now() - startTime,
        origin: 'user'
      });
      return descriptor;
    } catch (error) {
      const execError =
        error instanceof Error ? error : new Error(String(error));
      logCanonicalEvent(this.logger, {
        event: 'sandbox.exec',
        outcome: 'error',
        command: commandText,
        durationMs: Date.now() - startTime,
        origin: 'user',
        error: execError,
        errorMessage: execError.message
      });
      throw error;
    } finally {
      activity.finish();
    }
  }

  private async assertLaunchRuntime(
    runtime: RuntimeIdentity,
    effect: 'none' | 'unknown'
  ): Promise<void> {
    try {
      await this.currentRuntime.assertActive(runtime);
    } catch {
      this.runtimeControlClient.dispose();
      throw runtimeInterrupted('process.start', effect);
    }
  }

  private processDescriptor(
    status: ProcessStatus,
    runtime: RuntimeIdentity
  ): ProcessRPCDescriptor {
    const lifecycle = this.processCapabilityLifecycle(runtime, {
      id: status.id,
      pid: status.pid
    });
    return {
      id: status.id,
      pid: status.pid,
      capability: new ProcessCapabilityTarget({
        id: status.id,
        pid: status.pid,
        runtime,
        lifecycle
      })
    };
  }

  private processCapabilityLifecycle(
    owningRuntime: RuntimeIdentity,
    process: { id: string; pid: number }
  ) {
    const lifecycle = new ProcessLifecycle({
      currentRuntime: this.currentRuntime,
      runtimeClient: this.runtimeControlClient,
      beginNonWakingOperation: () =>
        this.resourceActivityGate.beginNonWakingOperation(),
      process
    });
    return {
      runRead: <T>(
        _runtime: { readonly id: string },
        operation: string,
        call: (control: ProcessCapabilityControl) => Promise<T>
      ) =>
        lifecycle.runRead(owningRuntime, operation, (client) =>
          call(processCapabilityControl(client))
        ),
      runControl: <T>(
        _runtime: { readonly id: string },
        operation: string,
        call: (control: ProcessCapabilityControl) => Promise<T>
      ) =>
        lifecycle.runControl(owningRuntime, operation, (client) =>
          call(processCapabilityControl(client))
        )
    };
  }

  /** Internal bridge liveness read that neither starts nor renews a runtime. */
  async isRuntimeActive(): Promise<boolean> {
    return (await this.processLifecycle.captureCurrent()) !== null;
  }

  async getProcess(id: string): Promise<ProcessRPCDescriptor | null> {
    const runtime = await this.processLifecycle.captureCurrent();
    if (!runtime) return null;
    const status = await this.processLifecycle.runRead(
      runtime,
      'process.get',
      (client) => client.processesWithoutActivity().get(id)
    );
    return status ? this.processDescriptor(status, runtime) : null;
  }

  async listProcesses(): Promise<ProcessStatus[]> {
    const runtime = await this.processLifecycle.captureCurrent();
    if (!runtime) return [];
    return this.processLifecycle.runRead(runtime, 'process.list', (client) =>
      client.processesWithoutActivity().list()
    );
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}) {
    return this.client.files.mkdir(path, { recursive: options.recursive });
  }

  async writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options: { encoding?: string } = {}
  ) {
    if (content instanceof ReadableStream) {
      return this.client.files.writeFileStream(path, content);
    }

    return this.client.files.writeFile(path, content, {
      encoding: options.encoding
    });
  }

  async deleteFile(path: string) {
    return this.client.files.deleteFile(path);
  }

  async renameFile(oldPath: string, newPath: string) {
    return this.client.files.renameFile(oldPath, newPath);
  }

  async moveFile(sourcePath: string, destinationPath: string) {
    return this.client.files.moveFile(sourcePath, destinationPath);
  }

  /**
   * Read a file from the sandbox.
   *
   * @param encoding - How to encode the returned content:
   *   - `undefined` (default): auto-detect from MIME type (text → UTF-8 string, binary → base64 string)
   *   - `'utf-8'` / `'utf8'`: always return as UTF-8 string
   *   - `'base64'`: always return as base64-encoded string
   *   - `'none'`: return a result whose `content` is a raw binary `ReadableStream<Uint8Array>`
   *              with no encoding overhead.
   */
  async readFile(
    path: string,
    options: { encoding: 'none' }
  ): Promise<ReadFileStreamResult>;
  async readFile(
    path: string,
    options?: { encoding?: Exclude<FileEncoding, 'none'> }
  ): Promise<ReadFileResult>;
  async readFile(
    path: string,
    options: { encoding?: FileEncoding } = {}
  ): Promise<ReadFileResult | ReadFileStreamResult> {
    if (options.encoding === 'none') {
      return this.client.files.readFile(path, { encoding: options.encoding });
    }
    return this.client.files.readFile(path, { encoding: options.encoding });
  }

  /**
   * Stream a file from the sandbox using Server-Sent Events
   * Returns a ReadableStream that can be consumed with streamFile() or collectFile() utilities
   * @param path - Path to the file to stream
   */
  async createWorkspaceArchive(
    options: { root: string; excludes?: readonly string[] } = {
      root: '/workspace'
    }
  ): Promise<string> {
    const result = await this.client.workspace.createArchive({
      root: options.root,
      excludes: options.excludes ?? []
    });
    return result.archivePath;
  }

  async extractWorkspaceArchive(options: {
    root: string;
    archivePath: string;
  }): Promise<void> {
    await this.client.workspace.extractArchive(options);
  }

  async cleanupWorkspaceArchive(archivePath: string): Promise<void> {
    await this.client.workspace.cleanupArchive(archivePath);
  }

  async cleanupMountDirectory(mountPath: string): Promise<void> {
    await this.client.mounts.removeMountDirectory({
      path: mountPath,
      onlyIfNotMountpoint: true
    });
  }

  async readFileStream(path: string): Promise<ReadableStream<Uint8Array>> {
    return this.client.files.readFileStream(path);
  }

  async listFiles(path: string, options?: ListFilesOptions) {
    return this.client.files.listFiles(path, options);
  }

  async exists(path: string) {
    return this.client.files.exists(path);
  }

  /**
   * Watch a directory for file system changes using native inotify.
   *
   * The returned promise resolves only after the watcher is established on the
   * filesystem, so callers can immediately perform actions that depend on the
   * watch being active. The returned stream contains the full event sequence
   * starting with the `watching` event.
   *
   * Consume the stream with `parseSSEStream<FileWatchSSEEvent>(stream)`.
   *
   * @param path - Path to watch (absolute or relative to /workspace)
   * @param options - Watch options
   */
  async watch(
    path: string,
    options: WatchOptions = {}
  ): Promise<ReadableStream<Uint8Array>> {
    return openRemoteSubscription(
      this.client.watch.watch({
        path,
        recursive: options.recursive,
        include: options.include,
        exclude: options.exclude
      }),
      { operation: 'open filesystem watch' }
    );
  }

  /**
   * Check whether a path changed while this caller was disconnected.
   *
   * Pass the `version` returned from a prior call in `options.since` to learn
   * whether the path is unchanged, changed, or needs a full resync because the
   * retained change state was reset.
   *
   * @param path - Path to check (absolute or relative to /workspace)
   * @param options - Change-check options
   */
  async checkChanges(
    path: string,
    options: CheckChangesOptions = {}
  ): Promise<CheckChangesResult> {
    return this.client.watch.checkChanges({
      path,
      recursive: options.recursive,
      include: options.include,
      exclude: options.exclude,
      since: options.since
    });
  }

  private async ensureRuntimeActiveForPreview(): Promise<RuntimeIdentity> {
    const activity = this.resourceActivityGate.beginOperation();
    try {
      await activity.beforeCall;
      await this.startAndWaitForPorts({
        ports: this.defaultPort,
        cancellationOptions: {
          instanceGetTimeoutMS: this.containerTimeouts.instanceGetTimeoutMS,
          portReadyTimeoutMS: this.containerTimeouts.portReadyTimeoutMS,
          waitInterval: this.containerTimeouts.waitIntervalMS
        }
      });

      const runtime = await this.currentRuntime.get();
      return runtime ?? (await this.currentRuntime.markStarted());
    } finally {
      activity.finish();
    }
  }

  /**
   * Expose a port and get a preview URL for accessing services running in the sandbox
   *
   * Preview URL authorization survives transient container restarts, but
   * forwarding is active only for the runtime where `exposePort()` was last
   * called. Call `exposePort()` again after a restart to reactivate an
   * existing URL for the current runtime.
   *
   * @param port - Port number to expose (1024-65535)
   * @param options - Configuration options
   * @param options.hostname - Your Worker's domain name (required for preview URL construction)
   * @param options.name - Optional friendly name for the port
   * @param options.token - Optional custom token for the preview URL (1-16 characters: lowercase letters, numbers, underscores)
   *                       If not provided, a random 16-character token will be generated automatically
   * @returns Preview URL information including the full URL, port number, and optional name
   *
   * @example
   * // With auto-generated token
   * const { url } = await sandbox.exposePort(8080, { hostname: 'example.com' });
   * // url: https://8080-sandbox-id-abc123random4567.example.com
   *
   * @example
   * // With custom token for stable URLs across deployments
   * const { url } = await sandbox.exposePort(8080, {
   *   hostname: 'example.com',
   *   token: 'my_token_v1'
   * });
   * // url: https://8080-sandbox-id-my_token_v1.example.com
   */
  async exposePort(
    port: number,
    options: { name?: string; hostname: string; token?: string }
  ) {
    return await this.previewService.exposePort(port, options);
  }

  /**
   * Revoke preview URL authorization and current-runtime activation for a port.
   *
   * Revocation is idempotent: calling this for a port with no preview state is
   * still successful. The operation clears Durable Object-owned preview state
   * only and does not contact, probe, wake, or clean up the container runtime.
   */
  async unexposePort(port: number): Promise<void> {
    return await this.previewService.unexposePort(port);
  }

  /**
   * Returns preview URLs that are currently forwardable in the active runtime.
   * Durable authorization without current-runtime activation is omitted.
   */
  async getExposedPorts(hostname: string) {
    return await this.previewService.getExposedPorts(hostname);
  }

  /**
   * Returns whether a port is currently preview-forwardable.
   * This checks Durable Object-owned auth and runtime activation without
   * contacting or waking the container.
   */
  async isPortExposed(port: number): Promise<boolean> {
    return await this.previewService.isPortExposed(port);
  }

  /**
   * Checks durable preview URL authorization for a port/token pair.
   *
   * This does not check whether the port is activated for the current runtime
   * and is not sufficient to decide whether preview traffic may forward.
   */
  async validatePortToken(port: number, token: string): Promise<boolean> {
    return await this.previewService.validatePortToken(port, token);
  }

  /**
   * Namespaced tunnel API. Quick tunnels are zero-config preview URLs
   * backed by Cloudflare's trycloudflare service. Named tunnels bind a
   * stable hostname under the configured Cloudflare zone.
   *
   * - `tunnels.get(port)` — idempotent. Returns the cached tunnel for
   *   `port` if one exists in DO storage, otherwise spawns a fresh
   *   cloudflared process and persists the record.
   * - `tunnels.list()` — returns tunnels currently usable through this
   *   sandbox runtime.
   * - `tunnels.destroy(portOrInfo)` — tear down by port number or by
   *   the record returned from `get()`.
   *
   * Container restarts drop quick-tunnel records because their
   * `*.trycloudflare.com` URLs are tied to the dead cloudflared process.
   * Named-tunnel records stay in storage and are marked for respawn so the
   * next `get(port, { name })` call reuses the Cloudflare tunnel and DNS
   * record while starting a fresh cloudflared process.
   */
  get tunnels(): TunnelsHandler {
    this.ensureTunnelsBuilt();
    // Non-null after ensureTunnelsBuilt(); cast for the type system.
    return this.tunnelsHandler as TunnelsHandler;
  }

  /**
   * Lazily construct the tunnel subsystem handle. Called from the
   * `tunnels` getter on first access and from sandbox lifecycle hooks
   * when tunnel reconciliation or cleanup is needed.
   */
  private ensureTunnelsBuilt(): void {
    if (this.tunnelsHandler) return;
    const built = createTunnelsHandle({
      client: this.client,
      storage: this.ctx.storage,
      logger: this.logger,
      sandboxId: this.ctx.id.toString(),
      currentRuntime: this.currentRuntime,
      currentLifetime: this.currentLifetime,
      getNamedTunnelConfig: () => this.namedTunnelConfigResolver.getConfig()
    });
    this.tunnelServiceHandle = built;
    this.tunnelsHandler = built.tunnels;
    this.tunnelExitHandler = built.handleTunnelExit;
  }

  // ============================================================================
  // Backup methods — squashfs archive + R2 storage
  // ============================================================================

  /**
   * Create a backup of a directory and upload it to R2.
   *
   * The returned DirectoryBackup handle is serializable. Store it anywhere
   * (KV, D1, DO storage) and pass it to restoreBackup() later.
   *
   * Concurrent backup/restore calls on the same sandbox are serialized.
   */
  async createBackup(options: BackupOptions): Promise<DirectoryBackup> {
    return this.backupService.createBackup(options);
  }

  /**
   * Restore a backup from R2 into a directory.
   *
   * Production restores use a FUSE overlay mount. Local-bucket restores stream
   * the archive through the R2 binding and extract it with unsquashfs.
   *
   * Concurrent backup/restore calls on the same sandbox are serialized.
   */
  async restoreBackup(backup: DirectoryBackup): Promise<RestoreBackupResult> {
    return await this.backupService.restoreBackup(backup);
  }

  async __setBackupRestoreFaultForTesting(
    fault: BackupRestoreTestFault | null
  ): Promise<void> {
    await this.backupService.setRestoreFaultForTesting(fault);
  }

  async registerGitAuthInterceptor(
    params: GitAuthInterceptorParams
  ): Promise<void> {
    await configureGitAuthInterceptor(this.getMountOutboundHost(), params);
  }

  private getMountOutboundHost(): MountOutboundHost {
    return {
      ctx: this.ctx as EgressContainerState,
      constructorRef: this.constructor,
      enableInternet: this.enableInternet,
      logger: this.logger,
      setOutboundByHost: (host, method, params) =>
        this.setOutboundByHost<unknown>(host, method, params),
      removeOutboundByHost: (host) => this.removeOutboundByHost(host)
    };
  }
}
