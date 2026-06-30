import {
  ContainerProxy as BaseContainerProxy,
  Container,
  getContainer,
  type OutboundHandlerContext,
  switchPort
} from '@cloudflare/containers';
import type {
  BackupOptions,
  BucketCredentials,
  BucketProvider,
  CheckChangesOptions,
  CheckChangesResult,
  CommandExecuteOptions,
  DirectoryBackup,
  ExecOptions,
  ExecResult,
  ExecutionSession,
  FileEncoding,
  ISandbox,
  ListFilesOptions,
  LocalMountBucketOptions,
  LogEvent,
  MountBucketOptions,
  PortWatchEvent,
  Process,
  ProcessOptions,
  ProcessQueryOptions,
  ProcessStatus,
  R2BindingMountBucketOptions,
  ReadFileResult,
  ReadFileStreamResult,
  RemoteMountBucketOptions,
  RestoreBackupResult,
  SandboxExecOptions,
  SandboxOptions,
  SandboxProcess,
  SandboxProcessPromise,
  SandboxTerminal,
  SessionOptions,
  TerminalCreateOptions,
  TerminalOptions,
  WaitForExitResult,
  WaitForLogResult,
  WaitForPortOptions,
  WatchOptions
} from '@repo/shared';
import {
  createLogger,
  filterEnvVars,
  getEnvString,
  logCanonicalEvent,
  partitionEnvVars,
  type SessionDeleteResult,
  shellEscape,
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
import { SandboxExtension } from './extensions';
import { collectFile, streamFile } from './file-stream';
import { LocalMountSyncManager } from './local-mount-sync';
import { isPlatformTransientError } from './platform-errors';
import {
  createSandboxProcessPromise,
  resolveStdinForRpc,
  type SandboxProcessDeps,
  SandboxProcessImpl,
  toRpcSandboxProcess
} from './process';
import {
  type PreviewForwardingContainer,
  PreviewService
} from './preview/service';
import { createSandboxTerminal, proxyTerminal } from './pty';
import { CurrentSandboxLifetime } from './sandbox-lifetime';
import {
  SandboxSecurityError,
  sanitizeSandboxId,
  validatePort
} from './security';
import { parseSSEStream } from './sse-parser';
import {
  buildS3fsSource,
  detectCredentials,
  detectProviderFromUrl,
  isR2Bucket,
  MissingCredentialsError,
  resolveS3fsOptions,
  validateBucketBindingName,
  validateBucketName,
  validatePrefix
} from './storage-mount';
import {
  BucketUnmountError,
  InvalidMountConfigError,
  S3FSMountError
} from './storage-mount/errors';
import {
  type R2EgressParams,
  r2EgressHandler
} from './storage-mount/r2-egress-handler';
import {
  evictDirectoryMarkerCacheForMount,
  evictSigV4ClientCacheEntry,
  SELF_TEST_PATH as S3_CREDENTIAL_PROXY_SELF_TEST_PATH,
  s3CredentialProxyHandler
} from './storage-mount/s3-credential-proxy-handler';
import type {
  CredentialProxyAuthStrategy,
  FuseMountInfo,
  LocalSyncMountInfo,
  MountInfo,
  R2BindingMountInfo,
  S3CredentialProxyParams
} from './storage-mount/types';
import { NamedTunnelConfigResolver } from './tunnels/named-tunnel-config';
import {
  createTunnelsHandle,
  type TunnelExitHandler,
  type TunnelsHandle,
  type TunnelsHandler
} from './tunnels/rpc-target';
import { SandboxControlCallbackImpl } from './tunnels/sandbox-control-callback';
import { SDK_VERSION } from './version';

type ExecuteResponse = Awaited<
  ReturnType<ContainerControlClient['commands']['execute']>
>;

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

type EgressContainerState = DurableObjectState<{}> & {
  exports?: {
    ContainerProxy?: (options: {
      props: {
        enableInternet?: boolean;
        containerId: string;
        className: string;
        outboundByHostOverrides: Record<
          string,
          {
            method: string;
            params: R2EgressParams | S3CredentialProxyParams;
          }
        >;
      };
    }) => Fetcher;
  };
  container?: {
    interceptOutboundHttp(host: string, fetcher: Fetcher): Promise<void>;
  };
};

type PreviewForwardingContainerState = DurableObjectState<{}> & {
  container?: PreviewForwardingContainer;
};

type PreviewForwardingLifecycleState = {
  inflightRequests?: number;
};

type OutboundHandlerRegistry = {
  outboundHandlers?: Record<string, unknown>;
};

const CONTAINER_PROXY_CLASS_NAME = 'ContainerProxy';
const S3_CREDENTIAL_PROXY_HOST = 's3-credential-proxy.internal';
const S3_CREDENTIAL_PROXY_DIAGNOSTIC_HOST = 's3-credential-proxy.sandbox.test';

class ContainerProxyOutboundTarget extends Container {}

Object.defineProperty(ContainerProxyOutboundTarget, 'name', {
  value: CONTAINER_PROXY_CLASS_NAME
});

(
  ContainerProxyOutboundTarget as unknown as OutboundHandlerRegistry
).outboundHandlers = {
  r2EgressMount: r2EgressHandler,
  s3CredentialProxyMount: s3CredentialProxyHandler
};

/**
 * SDK-level ContainerProxy that directly dispatches SDK-internal mount hosts
 * (r2.internal, s3-credential-proxy.internal) without relying on
 * outboundHandlersRegistry lookups, which are NOT shared between the Durable
 * Object's execution context and the ContainerProxy WorkerEntrypoint context.
 *
 * Users must export this class from their Worker entrypoint so the Sandbox DO
 * can create outbound-interception fetchers that reference it.
 */
export class ContainerProxy extends BaseContainerProxy {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname;
    const props = this.ctx.props as {
      outboundByHostOverrides?: Record<
        string,
        { method: string; params?: unknown }
      >;
      containerId?: string;
      className?: string;
    };
    const override = props.outboundByHostOverrides?.[hostname];
    if (override) {
      const handlerCtx = {
        containerId: props.containerId ?? '',
        className: props.className ?? '',
        params: override.params
      };
      if (override.method === 'r2EgressMount') {
        return r2EgressHandler(
          request,
          this.env as Cloudflare.Env,
          handlerCtx as OutboundHandlerContext<R2EgressParams>
        );
      }
      if (override.method === 's3CredentialProxyMount') {
        return s3CredentialProxyHandler(
          request,
          this.env as Cloudflare.Env,
          handlerCtx as OutboundHandlerContext<S3CredentialProxyParams>
        );
      }
    }
    return super.fetch(request);
  }
}

function isFetcher(value: unknown): value is Fetcher {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fetch' in value &&
    typeof value.fetch === 'function'
  );
}

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
  createSession: (opts?: SessionOptions) => Promise<ExecutionSession>;
  getSession: (sessionId: string) => Promise<ExecutionSession>;
  callExtension: (
    extensionName: string,
    method: string,
    args: unknown[]
  ) => Promise<unknown>;
  createTerminal: (options: TerminalCreateOptions) => Promise<void>;
  destroyTerminal: (id: string) => Promise<void>;
  /**
   * Unified exec primitive. Returns the resolved `SandboxProcess` (the
   * client-side `enhancedMethods.exec` wraps this in a
   * `SandboxProcessPromise` so the thenable convenience methods are
   * available at the call site).
   */
  exec: (
    command: string | string[],
    options?: SandboxExecOptions
  ) => Promise<SandboxProcess>;
  getProcess: (
    id: string,
    sessionId?: string
  ) => Promise<SandboxProcess | null>;
  run: (
    command: string,
    options?: ExecOptions & { sessionId?: string }
  ) => Promise<ExecResult>;
  runWithSessionToken: (
    command: string,
    sessionId: string,
    options?: ExecOptions
  ) => Promise<ExecResult>;
};

const sandboxConfigurationCache = new WeakMap<
  object,
  Map<string, CachedSandboxConfiguration>
>();

const R2_DEFAULT_S3FS_OPTIONS: Readonly<Record<string, string | boolean>> = {
  stat_cache_expire: '60',
  enable_noobj_cache: true,
  multipart_size: '5'
};

const R2_DEFAULT_S3FS_OPTION_ENTRIES = Object.entries(
  R2_DEFAULT_S3FS_OPTIONS
).map(([key, value]) => (value === true ? key : `${key}=${value}`));
// s3fs ahbe_conf (Additional Header By Extension) format:
// Each line is: [extension-pattern] [Header-Name]:[value]
// A leading space as the pattern acts as a wildcard, matching all requests.
// Setting Expect to an empty value causes s3fs to omit the Expect: 100-continue
// header, preventing the outbound proxy from stalling waiting for a 100 response.
const S3FS_DISABLE_EXPECT_HEADER_CONFIG = ' Expect:\n';

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

/**
 * Tagged template literal that shell-escapes every interpolated value.
 * Use for composing in-container scripts where the template body is
 * trusted shell and the interpolations are untrusted strings.
 */
function sh(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += shellEscape(String(values[i])) + strings[i + 1];
  }
  return out;
}

/**
 * Hex string of `bytes` random bytes (length = bytes * 2). Used for short
 * non-cryptographic identifiers — e.g. tempfile suffixes.
 */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Parse an array of `key=value` / bare-flag s3fs options into a Record.
 * Bare flags become `{ flag: true }`. Later entries overwrite earlier ones.
 */
function parseS3fsOptions(entries: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq === -1) {
      result[entry] = true;
    } else {
      result[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  }
  return result;
}

/**
 * Serialise an s3fs options Record into the comma-separated `-o` argument.
 * Boolean true emits the bare flag; false drops it.
 */
function serializeS3fsOptions(
  options: Record<string, string | boolean>
): string {
  return Object.entries(options)
    .filter(([, v]) => v !== false)
    .map(([k, v]) => (v === true ? k : `${k}=${v}`))
    .join(',');
}

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
        return (result as unknown as Promise<unknown>).catch((error: unknown) =>
          translatePlatformInterruption(error, operation)
        ) as TResult;
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
): T {
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

    // Unified exec (mirrors `ctx.container.exec()` contract). Wrapped in
    // `createSandboxProcessPromise` so callers get the Bun.spawn-style
    // thenable that exposes `.output()` / `.text()` / `.json()` / `.kill()`
    // directly on the returned promise.
    exec: (command: string | string[], execOptions?: SandboxExecOptions) =>
      createSandboxProcessPromise(stub.exec(command, execOptions)),
    run: (command: string, runOptions?: ExecOptions & { sessionId?: string }) =>
      stub.run(command, runOptions),
    getProcess: (id: string, options?: ProcessQueryOptions) =>
      options?.sessionId === undefined
        ? stub.getProcess(id)
        : stub.getProcess(id, { sessionId: options.sessionId }),
    listProcesses: (options?: ProcessQueryOptions) =>
      options?.sessionId === undefined
        ? stub.listProcesses()
        : stub.listProcesses({ sessionId: options.sessionId }),
    writeFile: (
      path: string,
      content: string | ReadableStream<Uint8Array>,
      fileOptions: { encoding?: string; sessionId?: string } = {}
    ) =>
      stub.writeFile(path, content, {
        ...fileOptions,
        ...(fileOptions.sessionId !== undefined && {
          sessionId: fileOptions.sessionId
        })
      }),
    readFile: (
      path: string,
      fileOptions:
        | { encoding: 'none'; sessionId?: string }
        | { encoding?: Exclude<FileEncoding, 'none'>; sessionId?: string } = {}
    ) => {
      const options = {
        ...fileOptions,
        ...(fileOptions.sessionId !== undefined && {
          sessionId: fileOptions.sessionId
        })
      };

      if (options.encoding === 'none') {
        return stub.readFile(path, options);
      }

      return stub.readFile(path, options);
    },
    readFileStream: (path: string, fileOptions: { sessionId?: string } = {}) =>
      stub.readFileStream(path, {
        ...fileOptions,
        ...(fileOptions.sessionId !== undefined && {
          sessionId: fileOptions.sessionId
        })
      }),
    mkdir: (
      path: string,
      mkdirOptions: { recursive?: boolean; sessionId?: string } = {}
    ) =>
      stub.mkdir(path, {
        ...mkdirOptions,
        ...(mkdirOptions.sessionId !== undefined && {
          sessionId: mkdirOptions.sessionId
        })
      }),
    deleteFile: (path: string, options: { sessionId?: string } = {}) =>
      options.sessionId === undefined
        ? stub.deleteFile(path)
        : stub.deleteFile(path, { sessionId: options.sessionId }),
    renameFile: (
      oldPath: string,
      newPath: string,
      options: { sessionId?: string } = {}
    ) =>
      options.sessionId === undefined
        ? stub.renameFile(oldPath, newPath)
        : stub.renameFile(oldPath, newPath, { sessionId: options.sessionId }),
    moveFile: (
      sourcePath: string,
      destinationPath: string,
      options: { sessionId?: string } = {}
    ) =>
      options.sessionId === undefined
        ? stub.moveFile(sourcePath, destinationPath)
        : stub.moveFile(sourcePath, destinationPath, {
            sessionId: options.sessionId
          }),
    listFiles: (path: string, listOptions?: ListFilesOptions) =>
      stub.listFiles(path, {
        ...listOptions,
        sessionId: listOptions?.sessionId
      }),
    exists: (path: string, options: { sessionId?: string } = {}) =>
      options.sessionId === undefined
        ? stub.exists(path)
        : stub.exists(path, { sessionId: options.sessionId }),
    gitCheckout: (
      repoUrl: string,
      gitOptions?: {
        branch?: string;
        targetDir?: string;
        sessionId?: string;
        depth?: number;
        cloneTimeoutMs?: number;
      }
    ) =>
      stub.gitCheckout(repoUrl, {
        ...gitOptions,
        sessionId: gitOptions?.sessionId
      }),
    createSession: async (opts?: SessionOptions): Promise<ExecutionSession> => {
      const rpcSession = await stub.createSession(opts);
      return rpcSession as ExecutionSession;
    },
    getSession: async (sessionId: string): Promise<ExecutionSession> => {
      const rpcSession = await stub.getSession(sessionId);
      return rpcSession as ExecutionSession;
    },
    watch: (path: string, options: WatchOptions = {}) =>
      stub.watch(path, {
        ...options,
        sessionId: options.sessionId
      }),
    checkChanges: (path: string, options: CheckChangesOptions = {}) =>
      stub.checkChanges(path, {
        ...options,
        sessionId: options.sessionId
      }),
    terminal: (opts?: TerminalOptions) => createSandboxTerminal(stub, opts),
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
  // to preserve the RPC stub's internal Proxy handling.
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
  }) as T;
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

export class Sandbox<Env = unknown> extends Container<Env> implements ISandbox {
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
  private activeMounts: Map<string, MountInfo> = new Map();
  private mountOperationQueue: Promise<void> = Promise.resolve();
  private currentRuntime: CurrentRuntimeIdentity;
  private currentLifetime: CurrentSandboxLifetime;
  private backupService: BackupService;
  private previewService: PreviewService;

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

  /**
   * Create the single control-plane client used for all SDK operations.
   */
  private createClient(): ContainerControlClient {
    // Access the base Container's private inflightRequests counter so
    // the alarm loop's isActivityExpired() check sees active work and
    // skips the sleepAfterMs comparison while RPC calls or returned
    // streams are still active over the capnweb session.
    const self = this as unknown as { inflightRequests: number };
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
      // whole session. We treat one transition as equivalent to one
      // in-flight request: increment on busy, decrement on idle. See the
      // file-level comment in container-control/client.ts for details.
      onActivity: () => {
        // Called at the start of each RPC call AND on every busy-poll
        // tick while the session has work in flight. Equivalent to the
        // top of containerFetch(): push the sleepAfter deadline forward.
        this.renewActivityTimeout();
      },
      onSessionBusy: () => {
        // Idle → busy: a new RPC call started or a stream return is now
        // in flight. Mark the DO busy so isActivityExpired() returns false
        // until the session goes idle again.
        self.inflightRequests = (self.inflightRequests ?? 0) + 1;
      },
      onSessionIdle: () => {
        // Busy → idle: all RPC promises have settled and all stream exports
        // have been released. Equivalent to containerFetch's finally block —
        // decrement and restart the inactivity window from now.
        self.inflightRequests = Math.max(0, (self.inflightRequests ?? 0) - 1);
        if (self.inflightRequests === 0) {
          this.renewActivityTimeout();
        }
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
      execWithSession: (command, sessionId, options) =>
        this.executeCommand(command, sessionId, options),
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

    this.client = this.createClient();
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
   *
   * Requires explicit endpoint URL for production. Credentials are auto-detected from environment
   * variables or can be provided explicitly.
   *
   * @param bucket - Bucket name (or R2 binding name when localBucket is true)
   * @param mountPath - Absolute path in container to mount at
   * @param options - Mount configuration
   * @throws MissingCredentialsError if no credentials found in environment
   * @throws S3FSMountError if S3FS mount command fails
   * @throws InvalidMountConfigError if bucket name, mount path, or endpoint is invalid
   */
  async mountBucket(
    bucket: string,
    mountPath: string,
    options: MountBucketOptions
  ): Promise<void> {
    return this.runMountOperation(async () => {
      await this.mountBucketUnlocked(bucket, mountPath, options);
    });
  }

  private async runMountOperation(
    operation: () => Promise<void>
  ): Promise<void> {
    const previous = this.mountOperationQueue;
    let release!: () => void;
    this.mountOperationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      await operation();
    } finally {
      release();
    }
  }

  private async mountBucketUnlocked(
    bucket: string,
    mountPath: string,
    options: MountBucketOptions
  ): Promise<void> {
    if (options.prefix !== undefined) {
      validatePrefix(options.prefix);
    }

    if ('localBucket' in options && options.localBucket) {
      await this.mountBucketLocal(bucket, mountPath, options);
      return;
    }

    const remoteOptions = options as RemoteMountBucketOptions;
    if (remoteOptions.endpoint === undefined) {
      const envObj = this.env as Record<string, unknown>;
      const binding = envObj[bucket];
      if (isR2Bucket(binding)) {
        await this.mountBucketR2Egress(
          bucket,
          mountPath,
          options as R2BindingMountBucketOptions
        );
        return;
      }
      throw new InvalidMountConfigError(
        `R2 binding "${bucket}" not found in Worker env. ` +
          'Ensure the binding name matches the bucket binding configured in wrangler.jsonc.'
      );
    }

    await this.mountBucketFuse(bucket, mountPath, remoteOptions);
  }

  /**
   * Local dev mount: bidirectional sync via R2 binding + file/watch APIs
   */
  private async mountBucketLocal(
    bucket: string,
    mountPath: string,
    options: LocalMountBucketOptions
  ): Promise<void> {
    const mountStartTime = Date.now();
    let mountOutcome: 'success' | 'error' = 'error';
    let mountError: Error | undefined;
    const dirExisted = true; // assume pre-existing so we don't accidentally delete
    try {
      const envObj = this.env as Record<string, unknown>;
      const r2Binding = envObj[bucket];
      if (!r2Binding || !isR2Bucket(r2Binding)) {
        throw new InvalidMountConfigError(
          `R2 binding "${bucket}" not found in env or is not an R2Bucket. ` +
            'Make sure the binding name matches your wrangler.jsonc R2 binding.'
        );
      }

      if (!mountPath || !mountPath.startsWith('/')) {
        throw new InvalidMountConfigError(
          `Invalid mount path: "${mountPath}". Must be an absolute path starting with /`
        );
      }

      if (this.activeMounts.has(mountPath)) {
        throw new InvalidMountConfigError(
          `Mount path already in use: ${mountPath}`
        );
      }

      const syncManager = new LocalMountSyncManager({
        bucket: r2Binding,
        mountPath,
        prefix: options.prefix,
        readOnly: options.readOnly ?? false,
        client: this.client,
        logger: this.logger
      });

      const mountInfo: LocalSyncMountInfo = {
        mountId: crypto.randomUUID(),
        mountType: 'local-sync',
        bucket,
        mountPath,
        syncManager,
        mounted: false
      };
      this.activeMounts.set(mountPath, mountInfo);

      try {
        await syncManager.start();
        mountInfo.mounted = true;
      } catch (error) {
        await syncManager.stop();
        this.activeMounts.delete(mountPath);
        throw error;
      }

      mountOutcome = 'success';
    } catch (error) {
      mountError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'bucket.mount',
        outcome: mountOutcome,
        durationMs: Date.now() - mountStartTime,
        bucket,
        mountPath,
        provider: 'local-sync',
        prefix: options.prefix,
        error: mountError
      });
    }
  }

  private getR2EgressParams(): R2EgressParams {
    const buckets: R2EgressParams['buckets'] = {};
    for (const [, m] of this.activeMounts) {
      if (m.mountType === 'r2-egress') {
        buckets[m.bucket] = {
          prefix: m.prefix,
          readOnly: m.readOnly
        };
      }
    }
    return { buckets };
  }

  private validateProtectedS3fsOptions(
    options: string[] | undefined,
    mountLabel: string,
    extraProtected: string[] = []
  ): void {
    if (!options) return;
    const protectedOptions = new Set(['passwd_file', 'url', ...extraProtected]);
    for (const option of options) {
      const [key] = option.split('=');
      if (protectedOptions.has(key)) {
        throw new InvalidMountConfigError(
          `s3fs option "${key}" cannot be overridden for ${mountLabel} mounts`
        );
      }
    }
  }

  private getS3CredentialProxyParams(options?: {
    excludeMountId?: string;
  }): S3CredentialProxyParams {
    const mounts: S3CredentialProxyParams['mounts'] = {};
    for (const [, m] of this.activeMounts) {
      if (m.mountType === 'fuse' && m.credentialProxy) {
        if (m.mountId === options?.excludeMountId) {
          continue;
        }
        mounts[m.mountId] = {
          endpoint: m.credentialProxy.endpoint,
          bucket: m.credentialProxy.bucket,
          ...(m.credentialProxy.prefix !== undefined
            ? { prefix: m.credentialProxy.prefix }
            : {}),
          credentials: m.credentialProxy.credentials,
          readOnly: m.credentialProxy.readOnly,
          provider: m.credentialProxy.provider,
          authStrategy: m.credentialProxy.authStrategy
        };
      }
    }
    return { mounts };
  }

  private resolveCredentialProxyAuthStrategy(
    provider: BucketProvider | null
  ): CredentialProxyAuthStrategy {
    return provider === 'gcs' ? 'gcs' : 's3-sigv4';
  }

  /**
   * Credential-less R2 mount: egress interception routes s3fs requests to the
   * R2 binding. No S3 credentials are needed in the container or Worker env.
   */
  private async mountBucketR2Egress(
    bucket: string,
    mountPath: string,
    options: R2BindingMountBucketOptions
  ): Promise<void> {
    const mountStartTime = Date.now();
    const prefix = options.prefix;
    let mountOutcome: 'success' | 'error' = 'error';
    let mountError: Error | undefined;
    let passwordFilePath: string | undefined;
    let additionalHeaderFilePath: string | undefined;

    try {
      validateBucketBindingName(bucket, mountPath);
      this.validateMountPath(mountPath);
      this.validateProtectedS3fsOptions(options.s3fsOptions, 'R2 binding');

      for (const [existingMountPath, mountInfo] of this.activeMounts) {
        if (
          mountInfo.mountType === 'r2-egress' &&
          mountInfo.bucket === bucket &&
          mountInfo.prefix !== prefix
        ) {
          throw new InvalidMountConfigError(
            `R2 binding "${bucket}" is already mounted at ${existingMountPath} with a different prefix. ` +
              'Mount the same binding only once, or use the same prefix for additional mounts.'
          );
        }
        if (
          mountInfo.mountType === 'r2-egress' &&
          mountInfo.bucket === bucket &&
          mountInfo.readOnly !== (options.readOnly ?? false)
        ) {
          throw new InvalidMountConfigError(
            `R2 binding "${bucket}" is already mounted at ${existingMountPath} with a different readOnly setting. ` +
              'Mount the same binding only once, or use the same readOnly value for additional mounts.'
          );
        }
      }

      passwordFilePath = this.generatePasswordFilePath();
      additionalHeaderFilePath = this.generateS3FSAdditionalHeaderFilePath();
      // s3fs requires a passwd file before it will issue requests; the R2
      // egress handler resolves the Worker binding and ignores S3 signatures.
      await this.createPasswordFile(passwordFilePath, bucket, {
        accessKeyId: 'x',
        secretAccessKey: 'x'
      });
      await this.createDisableExpectHeaderFile(additionalHeaderFilePath);

      const mountInfo: R2BindingMountInfo = {
        mountId: crypto.randomUUID(),
        mountType: 'r2-egress',
        bucket,
        mountPath,
        passwordFilePath,
        additionalHeaderFilePath,
        mounted: false,
        prefix,
        readOnly: options.readOnly ?? false
      };
      this.activeMounts.set(mountPath, mountInfo);

      await this.configureR2EgressOutbound(this.getR2EgressParams());

      await this.execInternal(`mkdir -p ${shellEscape(mountPath)}`);

      const s3fsSource = bucket;
      const s3fsOptions: Record<string, string | boolean> = {
        passwd_file: passwordFilePath,
        ...R2_DEFAULT_S3FS_OPTIONS,
        ...parseS3fsOptions(resolveS3fsOptions('r2', options.s3fsOptions)),
        use_path_request_style: true,
        url: 'http://r2.internal',
        ahbe_conf: additionalHeaderFilePath,
        ...(options.readOnly ? { ro: true } : {})
      };

      const optionsStr = shellEscape(serializeS3fsOptions(s3fsOptions));
      const mountCmd = `s3fs ${shellEscape(s3fsSource)} ${shellEscape(mountPath)} -o ${optionsStr}`;
      this.logger.debug('r2-egress: running s3fs', { mountCmd });
      const result = await this.execInternal(mountCmd);
      this.logger.debug('r2-egress: s3fs exited', {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr
      });
      if (result.exitCode !== 0) {
        throw new S3FSMountError(
          `S3FS mount failed: ${result.stderr || result.stdout || 'Unknown error'}`
        );
      }

      const mountpointCheck = await this.execInternal(
        `mountpoint -q ${shellEscape(mountPath)} && echo 'FUSE_MOUNTED' || echo 'NOT_FUSE_MOUNTED'`
      );
      this.logger.debug('r2-egress: mountpoint check', {
        stdout: mountpointCheck.stdout.trim(),
        exitCode: mountpointCheck.exitCode
      });

      if (mountpointCheck.stdout.trim() !== 'FUSE_MOUNTED') {
        throw new S3FSMountError(
          `s3fs exited 0 but mount was not established at ${mountPath}`
        );
      }

      mountInfo.mounted = true;
      mountOutcome = 'success';
    } catch (error) {
      mountError = error instanceof Error ? error : new Error(String(error));
      const failedMount = this.activeMounts.get(mountPath);
      this.activeMounts.delete(mountPath);
      if (failedMount?.mountType === 'r2-egress') {
        await this.deletePasswordFile(failedMount.passwordFilePath).catch(
          () => {}
        );
        if (failedMount.additionalHeaderFilePath) {
          await this.deleteAdditionalHeaderFile(
            failedMount.additionalHeaderFilePath
          ).catch(() => {});
        }
      } else {
        // Mount was not yet registered in activeMounts (error occurred before
        // activeMounts.set()); clean up using the local file path variables.
        if (passwordFilePath) {
          await this.deletePasswordFile(passwordFilePath).catch(() => {});
        }
        if (additionalHeaderFilePath) {
          await this.deleteAdditionalHeaderFile(additionalHeaderFilePath).catch(
            () => {}
          );
        }
      }
      const remainingParams = this.getR2EgressParams();
      await this.configureR2EgressOutbound(remainingParams).catch(() => {});
      throw error;
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'bucket.mount',
        outcome: mountOutcome,
        durationMs: Date.now() - mountStartTime,
        bucket,
        mountPath,
        provider: 'r2',
        prefix,
        error: mountError
      });
    }
  }

  /**
   * Production mount: S3FS-FUSE inside the container
   */
  private async mountBucketFuse(
    bucket: string,
    mountPath: string,
    options: RemoteMountBucketOptions
  ): Promise<void> {
    const mountStartTime = Date.now();
    const prefix = options.prefix;
    let mountOutcome: 'success' | 'error' = 'error';
    let mountError: Error | undefined;
    let passwordFilePath: string | undefined;
    let additionalHeaderFilePath: string | undefined;
    let provider: BucketProvider | null = null;
    let dirExisted = true;
    try {
      this.validateMountOptions(bucket, mountPath, { ...options, prefix });

      // Build s3fs source: bucket name with optional prefix (e.g., "mybucket:/prefix/")
      const s3fsSource = buildS3fsSource(bucket, prefix);
      provider = options.provider || detectProviderFromUrl(options.endpoint);

      this.logger.debug(`Detected provider: ${provider || 'unknown'}`, {
        explicitProvider: options.provider,
        prefix
      });

      // Attempt to load credentials from the DO env
      const envObj = this.env as Record<string, unknown>;
      const envCredentials = {
        AWS_ACCESS_KEY_ID: getEnvString(envObj, 'AWS_ACCESS_KEY_ID'),
        AWS_SECRET_ACCESS_KEY: getEnvString(envObj, 'AWS_SECRET_ACCESS_KEY'),
        R2_ACCESS_KEY_ID: this.r2AccessKeyId || undefined,
        R2_SECRET_ACCESS_KEY: this.r2SecretAccessKey || undefined
      };

      // Detect credentials
      const credentials = detectCredentials(options, {
        ...envCredentials,
        ...this.envVars
      });

      const credentialProxyEnabled = options.credentialProxy === true;
      if (credentialProxyEnabled) {
        this.validateProtectedS3fsOptions(
          options.s3fsOptions,
          'credential proxy',
          ['ahbe_conf', 'use_path_request_style']
        );
      }

      // Generate unique password file path
      passwordFilePath = this.generatePasswordFilePath();
      if (credentialProxyEnabled) {
        additionalHeaderFilePath = this.generateS3FSAdditionalHeaderFilePath();
      }

      // Reserve mount path before async operations so concurrent mounts see it
      const mountId = crypto.randomUUID();
      const mountInfo: FuseMountInfo = {
        mountId,
        mountType: 'fuse',
        bucket: s3fsSource,
        mountPath,
        endpoint: options.endpoint,
        provider,
        passwordFilePath,
        ...(additionalHeaderFilePath ? { additionalHeaderFilePath } : {}),
        mounted: false,
        ...(credentialProxyEnabled
          ? {
              credentialProxy: {
                endpoint: options.endpoint,
                bucket,
                ...(prefix !== undefined ? { prefix } : {}),
                credentials,
                readOnly: options.readOnly ?? false,
                provider,
                authStrategy: this.resolveCredentialProxyAuthStrategy(provider)
              }
            }
          : {})
      };
      this.activeMounts.set(mountPath, mountInfo);

      // Write dummy credentials for credential proxy, real credentials otherwise
      await this.createPasswordFile(
        passwordFilePath,
        bucket,
        credentialProxyEnabled
          ? { accessKeyId: 'x', secretAccessKey: 'x' }
          : credentials
      );
      if (credentialProxyEnabled) {
        if (additionalHeaderFilePath) {
          await this.createDisableExpectHeaderFile(additionalHeaderFilePath);
        }
        await this.configureS3CredentialProxyOutbound(
          this.getS3CredentialProxyParams()
        );
      }

      // Check if mount directory already exists before creating it, so we
      // only remove it on failure if the SDK created it
      dirExisted =
        (await this.execInternal(`test -d ${shellEscape(mountPath)}`))
          .exitCode === 0;
      await this.execInternal(`mkdir -p ${shellEscape(mountPath)}`);

      // Execute S3FS mount with password file (uses full s3fs source with prefix)
      const effectiveOptions: RemoteMountBucketOptions = credentialProxyEnabled
        ? {
            ...options,
            endpoint: `http://${S3_CREDENTIAL_PROXY_HOST}/${mountId}`,
            s3fsOptions: [
              ...(provider === 'r2' ? R2_DEFAULT_S3FS_OPTION_ENTRIES : []),
              ...(options.s3fsOptions ?? []),
              ...(additionalHeaderFilePath
                ? [`ahbe_conf=${additionalHeaderFilePath}`]
                : []),
              'use_path_request_style'
            ]
          }
        : options;
      await this.executeS3FSMount(
        s3fsSource,
        mountPath,
        effectiveOptions,
        provider,
        passwordFilePath
      );

      mountInfo.mounted = true;
      mountOutcome = 'success';
    } catch (error) {
      mountError = error instanceof Error ? error : new Error(String(error));
      // Tear down any mount that may have established between the script's
      // last `mountpoint -q` check and `executeS3FSMount()` throwing. s3fs
      // runs as a daemon, so the FUSE mount can flip live in that window;
      // without this, the throw would leave an orphaned mount with no
      // `activeMounts` entry to clean up later.
      try {
        await this.execInternal(
          `mountpoint -q ${shellEscape(mountPath)} && fusermount -u ${shellEscape(mountPath)}`
        );
      } catch {
        // best-effort cleanup
      }

      // Clean up support files after best-effort unmount so we do not remove
      // files while a late-established FUSE daemon may still be active.
      if (passwordFilePath) {
        await this.deletePasswordFile(passwordFilePath);
      }
      if (additionalHeaderFilePath) {
        await this.deleteAdditionalHeaderFile(additionalHeaderFilePath);
      }

      // Remove the mount directory only if the SDK created it. Runs after
      // the unmount above so a late-arriving mount doesn't keep the dir busy.
      if (!dirExisted) {
        try {
          await this.execInternal(
            `rmdir ${shellEscape(mountPath)} 2>/dev/null`
          );
        } catch {
          // best-effort cleanup
        }
      }

      // Clean up reservation on failure; reconfigure proxy without this mount
      const failedMount = this.activeMounts.get(mountPath);
      if (failedMount?.mountType === 'fuse' && failedMount.credentialProxy) {
        try {
          await this.configureS3CredentialProxyOutbound(
            this.getS3CredentialProxyParams({
              excludeMountId: failedMount.mountId
            })
          );
          this.activeMounts.delete(mountPath);
          evictSigV4ClientCacheEntry(failedMount.mountId);
          evictDirectoryMarkerCacheForMount(failedMount.mountId);
        } catch (cleanupError) {
          this.logger.warn('credential proxy cleanup failed', {
            mountPath,
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError)
          });
          this.activeMounts.delete(mountPath);
          evictSigV4ClientCacheEntry(failedMount.mountId);
          evictDirectoryMarkerCacheForMount(failedMount.mountId);
        }
      } else {
        this.activeMounts.delete(mountPath);
      }
      throw error;
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'bucket.mount',
        outcome: mountOutcome,
        durationMs: Date.now() - mountStartTime,
        bucket,
        mountPath,
        provider: provider || 'unknown',
        prefix,
        error: mountError
      });
    }
  }

  /**
   * Manually unmount a bucket filesystem
   *
   * @param mountPath - Absolute path where the bucket is mounted
   * @throws InvalidMountConfigError if mount path doesn't exist or isn't mounted
   */
  async unmountBucket(mountPath: string): Promise<void> {
    return this.runMountOperation(async () => {
      await this.unmountBucketUnlocked(mountPath);
    });
  }

  private async unmountBucketUnlocked(mountPath: string): Promise<void> {
    const unmountStartTime = Date.now();
    let unmountOutcome: 'success' | 'error' = 'error';
    let unmountError: Error | undefined;

    // Look up mount by path
    const mountInfo = this.activeMounts.get(mountPath);

    try {
      // Throw error if mount doesn't exist
      if (!mountInfo) {
        throw new InvalidMountConfigError(
          `No active mount found at path: ${mountPath}`
        );
      }
      // Unmount the filesystem
      if (mountInfo.mountType === 'local-sync') {
        await mountInfo.syncManager.stop();
        mountInfo.mounted = false;
        this.activeMounts.delete(mountPath);
      } else if (
        mountInfo.mountType === 'fuse' &&
        mountInfo.credentialProxy &&
        !mountInfo.mounted
      ) {
        try {
          await this.configureS3CredentialProxyOutbound(
            this.getS3CredentialProxyParams({
              excludeMountId: mountInfo.mountId
            })
          );
        } catch (cleanupError) {
          this.logger.warn(
            'credential proxy outbound reconfiguration failed on unmount',
            {
              mountPath,
              error:
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError)
            }
          );
        }
        this.activeMounts.delete(mountPath);
        evictSigV4ClientCacheEntry(mountInfo.mountId);
        evictDirectoryMarkerCacheForMount(mountInfo.mountId);
      } else {
        // FUSE unmount
        let unmounted = false;
        try {
          const result = await this.execInternal(
            `fusermount -u ${shellEscape(mountPath)}`
          );
          if (result.exitCode !== 0) {
            const stderr = result.stderr || 'unknown error';
            throw new BucketUnmountError(
              `fusermount -u failed (exit ${result.exitCode}): ${stderr}`
            );
          }
          unmounted = true;
          mountInfo.mounted = false;

          if (mountInfo.mountType === 'r2-egress') {
            const remainingBuckets: R2EgressParams['buckets'] = {};
            for (const [, activeMount] of this.activeMounts) {
              if (
                activeMount.mountType === 'r2-egress' &&
                activeMount.mountId !== mountInfo.mountId
              ) {
                remainingBuckets[activeMount.bucket] = {
                  prefix: activeMount.prefix,
                  readOnly: activeMount.readOnly
                };
              }
            }
            try {
              await this.configureR2EgressOutbound({
                buckets: remainingBuckets
              });
            } catch (cleanupError) {
              this.logger.warn(
                'r2 egress outbound reconfiguration failed on unmount',
                {
                  mountPath,
                  error:
                    cleanupError instanceof Error
                      ? cleanupError.message
                      : String(cleanupError)
                }
              );
            }
            this.activeMounts.delete(mountPath);
          } else if (
            mountInfo.mountType === 'fuse' &&
            mountInfo.credentialProxy
          ) {
            try {
              await this.configureS3CredentialProxyOutbound(
                this.getS3CredentialProxyParams({
                  excludeMountId: mountInfo.mountId
                })
              );
            } catch (cleanupError) {
              this.logger.warn(
                'credential proxy outbound reconfiguration failed on unmount',
                {
                  mountPath,
                  error:
                    cleanupError instanceof Error
                      ? cleanupError.message
                      : String(cleanupError)
                }
              );
            }
            this.activeMounts.delete(mountPath);
            evictSigV4ClientCacheEntry(mountInfo.mountId);
            evictDirectoryMarkerCacheForMount(mountInfo.mountId);
          } else {
            this.activeMounts.delete(mountPath);
          }

          // Remove the now-empty mount directory
          try {
            const cleanup = await this.execInternal(
              `mountpoint -q ${shellEscape(mountPath)} || rmdir ${shellEscape(mountPath)}`
            );
            if (cleanup.exitCode !== 0) {
              this.logger.warn('mount directory removal failed', {
                mountPath,
                exitCode: cleanup.exitCode,
                stderr: cleanup.stderr
              });
            }
          } catch (err) {
            this.logger.warn('mount directory removal failed', {
              mountPath,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        } finally {
          // Only delete support files after a confirmed unmount. If
          // fusermount -u failed the s3fs daemon may still be running and
          // actively reading both the passwd and ahbe_conf files; deleting
          // them underneath a live daemon would cause EIO on subsequent
          // requests. Files left in /tmp are cleaned up when the container
          // terminates.
          if (unmounted) {
            await this.deletePasswordFile(mountInfo.passwordFilePath);
            if (mountInfo.additionalHeaderFilePath) {
              await this.deleteAdditionalHeaderFile(
                mountInfo.additionalHeaderFilePath
              );
            }
          }
        }
      }

      unmountOutcome = 'success';
    } catch (error) {
      unmountError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'bucket.unmount',
        outcome: unmountOutcome,
        durationMs: Date.now() - unmountStartTime,
        mountPath,
        bucket: mountInfo?.bucket,
        error: unmountError
      });
    }
  }

  /**
   * Shared validation for mount path (absolute, not already in use).
   */
  private validateMountPath(mountPath: string): void {
    if (!mountPath.startsWith('/')) {
      throw new InvalidMountConfigError(
        `Mount path must be absolute (start with /): "${mountPath}"`
      );
    }

    if (this.activeMounts.has(mountPath)) {
      const existingMount = this.activeMounts.get(mountPath);
      throw new InvalidMountConfigError(
        `Mount path "${mountPath}" is already in use by bucket "${existingMount?.bucket}". ` +
          `Unmount the existing bucket first or use a different mount path.`
      );
    }
  }

  /**
   * Validate mount options for remote (FUSE) mounts
   */
  private validateMountOptions(
    bucket: string,
    mountPath: string,
    options: RemoteMountBucketOptions
  ): void {
    // Basic URL validation
    try {
      new URL(options.endpoint);
    } catch (error) {
      throw new InvalidMountConfigError(
        `Invalid endpoint URL: "${options.endpoint}". Must be a valid HTTP(S) URL.`
      );
    }

    validateBucketName(bucket, mountPath);
    this.validateMountPath(mountPath);

    // Prefix validation is handled centrally in mountBucket()
  }

  /**
   * Generate unique password file path for s3fs credentials
   */
  private generatePasswordFilePath(): string {
    const uuid = crypto.randomUUID();
    return `/tmp/.passwd-s3fs-${uuid}`;
  }

  /**
   * Generate unique ahbe_conf file path for s3fs additional header config
   */
  private generateS3FSAdditionalHeaderFilePath(): string {
    const uuid = crypto.randomUUID();
    return `/tmp/.s3fs-ahbe-${uuid}.conf`;
  }

  /**
   * Create s3fs ahbe_conf file that suppresses the Expect: 100-continue header.
   * Restricted to 0600 so s3fs will accept it (same requirement as passwd files).
   */
  private async createDisableExpectHeaderFile(
    headerFilePath: string
  ): Promise<void> {
    await this.client.files.writeFile(
      headerFilePath,
      S3FS_DISABLE_EXPECT_HEADER_CONFIG
    );
    await this.execInternal(`chmod 0600 ${shellEscape(headerFilePath)}`);
  }

  /**
   * Create password file with s3fs credentials
   * Format: bucket:accessKeyId:secretAccessKey
   */
  private async createPasswordFile(
    passwordFilePath: string,
    bucket: string,
    credentials: BucketCredentials
  ): Promise<void> {
    const content = `${bucket}:${credentials.accessKeyId}:${credentials.secretAccessKey}`;

    await this.client.files.writeFile(passwordFilePath, content);

    await this.execInternal(`chmod 0600 ${shellEscape(passwordFilePath)}`);
  }

  /**
   * Delete password file
   */
  private async deletePasswordFile(passwordFilePath: string): Promise<void> {
    try {
      await this.execInternal(`rm -f ${shellEscape(passwordFilePath)}`);
    } catch (error) {
      this.logger.warn('password file cleanup failed', {
        passwordFilePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async deleteAdditionalHeaderFile(
    headerFilePath: string
  ): Promise<void> {
    try {
      await this.execInternal(`rm -f ${shellEscape(headerFilePath)}`);
    } catch (error) {
      this.logger.warn('s3fs additional header file cleanup failed', {
        headerFilePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Execute S3FS mount command
   */
  private async executeS3FSMount(
    bucket: string,
    mountPath: string,
    options: RemoteMountBucketOptions,
    provider: BucketProvider | null,
    passwordFilePath: string,
    sessionId?: string
  ): Promise<void> {
    // Compose s3fs options as a Record so duplicates collapse cleanly:
    // SDK defaults + provider defaults first, user overrides next, SDK-required
    // entries last. Boolean true serialises to a bare flag (e.g. `ro`).
    //
    // The logfile path is left in place after the mount completes so
    // operators can inspect s3fs daemon output for debugging. The user can
    // override it via `s3fsOptions: ['logfile=/path']`.
    const logSuffix = randomHex(4);
    const sdkDefaults: Record<string, string | boolean> = {
      logfile: `/tmp/.s3fs-log-${logSuffix}`
    };
    const s3fsOptions: Record<string, string | boolean> = {
      ...sdkDefaults,
      ...parseS3fsOptions(resolveS3fsOptions(provider)),
      ...parseS3fsOptions(options.s3fsOptions ?? []),
      passwd_file: passwordFilePath,
      url: options.endpoint,
      ...(options.readOnly ? { ro: true } : {})
    };
    const logFile = s3fsOptions.logfile as string;
    const optionsStr = serializeS3fsOptions(s3fsOptions);

    // s3fs daemonises: the parent forks a FUSE child, then exits 0 once the
    // child reports its bucket check passed. Run mount + verification as a
    // single in-container script so the whole flow is one round-trip with
    // one observable outcome.
    //
    // s3fs output is redirected to the logfile (not captured via $()):
    // the daemon child inherits the redirected stdout/stderr fds, and
    // command substitution would block on those fds until the daemon
    // exited (i.e. until unmount), hanging the script for the lifetime
    // of the mount.
    //
    // The whole script runs inside a `( ... )` subshell. When a caller supplies
    // an explicit sessionId, executeCommand dispatches into that session's
    // long-lived bash shell; a bare top-level `exit N` would terminate the
    // session. The subshell scopes exits so only the subshell exits, and its
    // status becomes the command's exit code as the caller expects.
    //
    // Exit codes consumed by the caller:
    //   0 — mount established
    //   2 — s3fs parent failed; stdout carries the s3fs log tail
    //   3 — mount never appeared; stdout carries the s3fs log tail
    //
    // 60 iterations x 100ms = 6s budget for the SigV4 bucket check, which
    // is comfortable under CI load while still cheap on success (the loop
    // exits on the first iteration once the FUSE filesystem is live).
    const script = sh`(
      s3fs ${bucket} ${mountPath} -o ${optionsStr} >${logFile} 2>&1
      rc=$?
      if [ "$rc" -ne 0 ]; then tail -n 20 ${logFile} 2>/dev/null || true; exit 2; fi
      for _ in $(seq 1 60); do
        if mountpoint -q ${mountPath}; then exit 0; fi
        sleep 0.1
      done
      tail -n 20 ${logFile} 2>/dev/null || true
      exit 3
    )`;

    const exec = sessionId
      ? (cmd: string) =>
          this.executeCommand(cmd, sessionId, { origin: 'internal' })
      : (cmd: string) => this.execInternal(cmd);

    const result = await exec(script);
    if (result.exitCode === 0) return;

    const detail = result.stdout?.trim() || result.stderr?.trim() || '';

    if (result.exitCode === 2) {
      throw new S3FSMountError(
        `S3FS mount failed: ${detail || 'Unknown error'}`
      );
    }

    // exit 3 (or anything else): the FUSE filesystem never appeared
    const diagMessage = detail
      ? `s3fs log: ${detail}`
      : 'No s3fs log output captured. The s3fs daemon may have exited before writing logs.';
    throw new S3FSMountError(
      `S3FS mount failed: FUSE filesystem never appeared at ${mountPath}. ${diagMessage}`
    );
  }

  private async unmountTrackedFuseMount(
    mountPath: string,
    mountInfo: FuseMountInfo | R2BindingMountInfo
  ): Promise<void> {
    if (!mountInfo.mounted) return;

    this.logger.debug(
      `Unmounting bucket ${mountInfo.bucket} from ${mountPath}`
    );
    const result = await this.execInternal(
      `fusermount -u ${shellEscape(mountPath)}`
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `fusermount -u failed (exit ${result.exitCode}): ${result.stderr || 'unknown error'}`
      );
    }
    mountInfo.mounted = false;
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

      // Unmount all mounted buckets and cleanup. This runs before disconnecting
      // the control client because FUSE teardown uses execInternal.
      for (const [mountPath, mountInfo] of this.activeMounts.entries()) {
        mountsProcessed++;
        if (mountInfo.mountType === 'local-sync') {
          try {
            await mountInfo.syncManager.stop();
            mountInfo.mounted = false;
          } catch (error) {
            mountFailures++;
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            this.logger.warn(
              `Failed to stop local sync for ${mountPath}: ${errorMsg}`
            );
          }
        } else {
          try {
            await this.unmountTrackedFuseMount(mountPath, mountInfo);
          } catch (error) {
            mountFailures++;
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            this.logger.warn(
              `Failed to unmount bucket ${mountInfo.bucket} from ${mountPath}: ${errorMsg}`
            );
          }

          // Always cleanup support files for FUSE mounts
          await this.deletePasswordFile(mountInfo.passwordFilePath);
          if (mountInfo.additionalHeaderFilePath) {
            await this.deleteAdditionalHeaderFile(
              mountInfo.additionalHeaderFilePath
            );
          }
        }
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

    // Disconnect the active client so open sockets do not hold the DO alive.
    this.client.disconnect();

    // Stop local sync managers before clearing the map.
    let hadR2EgressMount = false;
    let hadCredentialProxyMount = false;
    for (const [, m] of this.activeMounts) {
      if (m.mountType === 'local-sync') {
        await m.syncManager.stop().catch(() => {});
      } else if (m.mountType === 'r2-egress') {
        hadR2EgressMount = true;
      } else if (m.mountType === 'fuse' && m.credentialProxy) {
        hadCredentialProxyMount = true;
        evictSigV4ClientCacheEntry(m.mountId);
        evictDirectoryMarkerCacheForMount(m.mountId);
      }
    }
    if (hadR2EgressMount) {
      await this.configureR2EgressOutbound({ buckets: {} }).catch(() => {});
    }
    if (hadCredentialProxyMount) {
      await this.configureS3CredentialProxyOutbound({ mounts: {} }).catch(
        () => {}
      );
    }

    this.activeMounts.clear();

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

  /**
   * Override onActivityExpired to prevent automatic shutdown when keepAlive is enabled
   * When keepAlive is disabled, calls parent implementation which stops the container
   */
  override async onActivityExpired(): Promise<void> {
    if (this.keepAliveEnabled) {
      this.logger.debug(
        'Activity expired but keepAlive is enabled - container will stay alive'
      );
      // Do nothing - don't call stop(), container stays alive
    } else {
      // Default behavior: stop the container
      this.logger.debug('Activity expired - stopping container');
      await super.onActivityExpired();
    }
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

    if (this.previewService.isPreviewProxyRequest(request)) {
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

  terminal(_options?: TerminalOptions): SandboxTerminal {
    throw new Error(
      'terminal must be called on the stub returned by getSandbox()'
    );
  }

  async createTerminal(options: TerminalCreateOptions): Promise<void> {
    await this.client.terminals.createTerminal(options);
  }

  async destroyTerminal(id: string): Promise<void> {
    await this.client.terminals.destroyTerminal(id);
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

  /**


   * Persist the container's placement ID in DO storage.
   *
   * Called from the session-create handshake so subsequent reads via
   * `getContainerPlacementId()` do not require a round-trip to the container. The value
   * is overwritten on every handshake so that container replacements (which
   * assign a new placement ID) are reflected on the next session-create.
   *
   * A value of `undefined` means the handshake response omitted the field
   * (older container, unexpected error shape) and the stored value is left
   * untouched. `null` means the env var is not set in the container and is
   * stored as-is so callers can distinguish "observed and absent" from "not
   * yet observed."
   */
  private async capturePlacementId(
    containerPlacementId: string | null | undefined
  ): Promise<void> {
    if (containerPlacementId === undefined) return;
    await this.ctx.storage.put('containerPlacementId', containerPlacementId);
  }

  private validateExplicitSessionId(sessionId: string): void {
    if (sessionId.trim().length === 0) {
      throw new Error('sessionId must not be empty or whitespace');
    }
  }

  /**
   * Validate an optional explicit session id without creating a session.
   *
   * Top-level process reads are sandbox-scoped, so they only carry a public
   * session annotation when the caller provides an explicit session id. The
   * resolved value is only used to populate `Process.sessionId` on the returned
   * object — it is never sent to the container API.
   */
  private validateOptionalSessionId(
    explicitSessionId?: string
  ): string | undefined {
    if (explicitSessionId !== undefined) {
      this.validateExplicitSessionId(explicitSessionId);
    }
    return explicitSessionId;
  }

  private resolveExecutionEnv(
    sessionId: string | undefined,
    env?: Record<string, string | undefined>
  ): Record<string, string | undefined> | undefined {
    if (sessionId === undefined) {
      const mergedEnv = filterEnvVars({ ...this.envVars, ...(env ?? {}) });
      return Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined;
    }

    if (env === undefined) {
      return undefined;
    }

    const filteredEnv = filterEnvVars(env);
    return Object.keys(filteredEnv).length > 0 ? filteredEnv : undefined;
  }

  private buildExecutionRequestOptions(
    sessionId: string | undefined,
    options?: {
      timeout?: number;
      env?: Record<string, string | undefined>;
      cwd?: string;
      origin?: 'user' | 'internal';
    }
  ): CommandExecuteOptions | undefined {
    const env = this.resolveExecutionEnv(sessionId, options?.env);

    if (
      options?.timeout === undefined &&
      env === undefined &&
      options?.cwd === undefined &&
      options?.origin === undefined
    ) {
      return undefined;
    }

    return {
      ...(options?.timeout !== undefined && { timeoutMs: options.timeout }),
      ...(env !== undefined && { env }),
      ...(options?.cwd !== undefined && { cwd: options.cwd }),
      ...(options?.origin !== undefined && { origin: options.origin })
    };
  }

  // -------------------------------------------------------------------------
  // Unified exec surface (mirrors `ctx.container.exec()` from workers-types).
  // -------------------------------------------------------------------------

  exec(
    command: string | string[],
    options?: SandboxExecOptions
  ): SandboxProcessPromise {
    return createSandboxProcessPromise(
      this.spawnSandboxProcess(command, options)
    );
  }

  /**
   * Buffered, session-state-preserving execution helper. Uses the foreground
   * session command path, preserving shell state such as cwd, aliases,
   * functions, and exported variables.
   */
  async run(
    command: string,
    options?: ExecOptions & { sessionId?: string }
  ): Promise<ExecResult> {
    return this.executeCommand(command, options?.sessionId, options);
  }

  async runWithSessionToken(
    command: string,
    sessionId: string,
    options?: ExecOptions
  ): Promise<ExecResult> {
    this.validateExplicitSessionId(sessionId);
    return this.executeCommand(command, sessionId, options);
  }

  /**
   * Internal: start a process via `client.processes.startProcess` and
   * construct a `SandboxProcess` handle that demultiplexes the log stream
   * into `stdout` / `stderr` and resolves `exitCode` on the `exit` event.
   */
  private async spawnSandboxProcess(
    command: string | string[],
    options?: SandboxExecOptions
  ): Promise<SandboxProcess> {
    if (options?.sessionId !== undefined) {
      this.validateExplicitSessionId(options.sessionId);
    }
    if (options?.signal?.aborted) {
      throw new Error('Operation was aborted');
    }

    // Wire-level command sent to the container's session shell. Strings pass
    // through verbatim (the container already shell-executes them); arrays
    // get shell-quoted so argv-form input survives the shell hop. The two
    // shapes produce the same command on the wire as `ctx.container.exec()`
    // would interpret — future iteration can move array-form straight to
    // `ctx.container.exec(argv, ...)` without going through the shell.
    const display = Array.isArray(command)
      ? command.map((arg) => shellEscape(arg)).join(' ')
      : command;

    const session = this.validateOptionalSessionId(options?.sessionId);
    const processSession = session;

    const executionOptions = this.buildExecutionRequestOptions(session, {
      timeout: options?.timeout,
      env: options?.env,
      cwd: options?.cwd,
      origin: options?.origin
    });

    // Resolve the caller-supplied `stdin` (`"pipe"` | `ReadableStream` |
    // `string` | undefined) into the pair of streams the wire & SDK need:
    //   - `stdinSource`: a `ReadableStream<Uint8Array>` passed across RPC
    //     to the container, which pumps it into the per-command FIFO.
    //   - `stdinWriter`: the `WritableStream<Uint8Array>` exposed to the
    //     caller as `proc.stdin` when they asked for `"pipe"`.
    const { stdinSource, stdinWriter } = resolveStdinForRpc(options?.stdin);
    const stderrMode = options?.stderr ?? 'pipe';
    const stdoutMode = options?.stdout ?? 'pipe';

    // Normalize to `undefined` when no options were provided. Keeps wire
    // compatibility with the legacy `execWithSession` shape and avoids
    // sending a noisy empty object across RPC.
    const hasProcessOption =
      session !== undefined ||
      options?.processId !== undefined ||
      options?.autoCleanup !== undefined ||
      options?.stdout !== undefined ||
      options?.stderr !== undefined;
    const requestOptions =
      executionOptions === undefined && !hasProcessOption
        ? undefined
        : {
            ...executionOptions,
            ...(session !== undefined && { sessionId: session }),
            ...(options?.processId !== undefined && {
              processId: options.processId
            }),
            ...(options?.autoCleanup !== undefined && {
              autoCleanup: options.autoCleanup
            }),
            ...(options?.stdout !== undefined && { stdout: stdoutMode }),
            ...(options?.stderr !== undefined && { stderr: stderrMode })
          };

    const response =
      requestOptions !== undefined || stdinSource !== undefined
        ? await this.client.processes.startProcess(
            display,
            requestOptions,
            stdinSource
          )
        : await this.client.processes.startProcess(display);

    const proc = new SandboxProcessImpl(
      {
        id: response.processId,
        pid: response.pid ?? -1,
        command: response.command ?? display,
        sessionId: processSession,
        startTime: new Date(),
        status: 'running' as ProcessStatus,
        ownership: 'owner',
        stdout: stdoutMode,
        stderr: stderrMode,
        stdin: stdinWriter
      },
      this.buildSandboxProcessDeps()
    );
    // Wrap in a plain object literal that workerd can serialize across
    // the DO RPC boundary. See `toRpcSandboxProcess` for the rationale.
    const procDto: SandboxProcess = toRpcSandboxProcess(proc);

    // Wire AbortSignal → kill (best-effort; matches `ExecProcess` lifetime).
    if (options?.signal) {
      const onAbort = () => proc.kill(15 /* SIGTERM */);
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Wall-clock timeout → SIGTERM. Container-side already has its own
    // timeoutMs honored via executionOptions; this is the SDK-side belt to
    // make `proc.exitCode` settle even if the container is wedged.
    if (options?.timeout && Number.isFinite(options.timeout)) {
      const handle = setTimeout(() => proc.kill(15), options.timeout);
      void proc.exitCode.finally(() => clearTimeout(handle));
    }

    return procDto;
  }

  private buildSandboxProcessDeps(): SandboxProcessDeps {
    // Keep these tied to the live `this` so re-entrant RPCs use the same
    // capnweb session as the spawn that produced the handle.
    return {
      openLogStream: (id) => this.client.processes.streamProcessLogs(id),
      readLogs: async (id) => {
        const r = await this.client.processes.getProcessLogs(id);
        return { stdout: r.stdout, stderr: r.stderr };
      },
      fetchStatus: async (id) => {
        try {
          const r = await this.client.processes.getProcess(id);
          return r.process?.status ?? 'error';
        } catch (error) {
          if (error instanceof ProcessNotFoundError) return 'error';
          throw error;
        }
      },
      killProcess: async (id, signal) => {
        await this.client.processes.killProcess(id, signal);
      },
      waitForPort: (id, command, port, opts) =>
        this.waitForPortReady(id, command, port, opts),
      waitForLogPattern: (id, command, pattern, timeout) =>
        this.waitForLogPattern(id, command, pattern, timeout),
      waitForProcessExit: (id, command, timeout) =>
        this.waitForProcessExit(id, command, timeout)
    };
  }

  /**
   * Execute an infrastructure command (backup, mount, env setup, etc.)
   * tagged with origin: 'internal' so logging demotes it to debug level.
   */
  private async execInternal(command: string): Promise<ExecResult> {
    return this.executeCommand(command, undefined, {
      origin: 'internal'
    });
  }

  /**
   * Internal command execution implementation used by public exec() and
   * explicit session wrappers.
   */
  private async executeCommand(
    command: string,
    sessionId: string | undefined,
    options?: ExecOptions
  ): Promise<ExecResult> {
    const startTime = Date.now();
    let execOutcome: { exitCode: number; success: boolean } | undefined;
    let execError: Error | undefined;

    try {
      const executionOptions = this.buildExecutionRequestOptions(
        sessionId,
        options
      );
      const commandOptions: CommandExecuteOptions | undefined =
        sessionId === undefined
          ? executionOptions
          : { ...(executionOptions ?? {}), sessionId };

      const response = commandOptions
        ? await this.client.commands.execute(command, commandOptions)
        : await this.client.commands.execute(command);

      const duration = Date.now() - startTime;
      const result = this.mapExecuteResponseToExecResult(
        response,
        duration,
        sessionId
      );

      execOutcome = { exitCode: result.exitCode, success: result.success };

      return result;
    } catch (error) {
      execError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'sandbox.exec',
        outcome: execError ? 'error' : 'success',
        command,
        exitCode: execOutcome?.exitCode,
        durationMs: Date.now() - startTime,
        sessionId,
        origin: options?.origin ?? 'user',
        error: execError ?? undefined,
        errorMessage: execError?.message
      });
    }
  }

  private mapExecuteResponseToExecResult(
    response: ExecuteResponse,
    duration: number,
    sessionId?: string
  ): ExecResult {
    return {
      success: response.success,
      exitCode: response.exitCode,
      stdout: response.stdout,
      stderr: response.stderr,
      command: response.command,
      duration,
      timestamp: response.timestamp,
      sessionId
    };
  }

  /**
   * Wait for a log pattern to appear in process output
   */
  private async waitForLogPattern(
    processId: string,
    command: string,
    pattern: string | RegExp,
    timeout?: number
  ): Promise<WaitForLogResult> {
    const startTime = Date.now();
    const conditionStr = this.conditionToString(pattern);
    let collectedStdout = '';
    let collectedStderr = '';

    // First check existing logs
    try {
      const existingLogs =
        await this.client.processes.getProcessLogs(processId);
      // Ensure existing logs end with newline for proper line separation from streamed output
      collectedStdout = existingLogs.stdout;
      if (collectedStdout && !collectedStdout.endsWith('\n')) {
        collectedStdout += '\n';
      }
      collectedStderr = existingLogs.stderr;
      if (collectedStderr && !collectedStderr.endsWith('\n')) {
        collectedStderr += '\n';
      }

      // Check stdout
      const stdoutResult = this.matchPattern(existingLogs.stdout, pattern);
      if (stdoutResult) {
        return stdoutResult;
      }

      // Check stderr
      const stderrResult = this.matchPattern(existingLogs.stderr, pattern);
      if (stderrResult) {
        return stderrResult;
      }
    } catch (error) {
      // Process might have already exited, continue to streaming
      this.logger.debug('Could not get existing logs, will stream', {
        processId,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Stream new logs and check for pattern
    const stream = await this.client.processes.streamProcessLogs(processId);

    // Set up timeout if specified
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timeoutPromise: Promise<never> | undefined;

    if (timeout !== undefined) {
      const remainingTime = timeout - (Date.now() - startTime);
      if (remainingTime <= 0) {
        throw this.createReadyTimeoutError(
          processId,
          command,
          conditionStr,
          timeout
        );
      }

      timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            this.createReadyTimeoutError(
              processId,
              command,
              conditionStr,
              timeout
            )
          );
        }, remainingTime);
      });
    }

    try {
      // Process stream
      const streamProcessor = async (): Promise<WaitForLogResult> => {
        const checkPattern = (): WaitForLogResult | null => {
          const stdoutResult = this.matchPattern(collectedStdout, pattern);
          if (stdoutResult) return stdoutResult;
          const stderrResult = this.matchPattern(collectedStderr, pattern);
          if (stderrResult) return stderrResult;
          return null;
        };

        for await (const event of parseSSEStream<LogEvent>(stream)) {
          if (event.type === 'stdout' || event.type === 'stderr') {
            const data = event.data || '';

            if (event.type === 'stdout') {
              collectedStdout += data;
            } else {
              collectedStderr += data;
            }

            const result = checkPattern();
            if (result) return result;
          }

          // Process exited - do final check before throwing
          if (event.type === 'exit') {
            // Final check in case pattern arrived in last chunk
            const result = checkPattern();
            if (result) return result;
            throw this.createExitedBeforeReadyError(
              processId,
              command,
              conditionStr,
              event.exitCode ?? 1
            );
          }
        }

        // Stream ended without exit event — do final check
        const finalResult = checkPattern();
        if (finalResult) return finalResult;
        // Stream ended without finding pattern - this indicates process exited
        throw this.createExitedBeforeReadyError(
          processId,
          command,
          conditionStr,
          0
        );
      };

      // Race with timeout if specified, otherwise just run stream processor
      if (timeoutPromise) {
        return await Promise.race([streamProcessor(), timeoutPromise]);
      }
      return await streamProcessor();
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Wait for a port to become available (for process readiness checking)
   */
  private async waitForPortReady(
    processId: string,
    command: string,
    port: number,
    options?: WaitForPortOptions
  ): Promise<void> {
    const {
      mode = 'http',
      path = '/',
      status = { min: 200, max: 399 },
      timeout,
      interval = 500
    } = options ?? {};

    const conditionStr =
      mode === 'http' ? `port ${port} (HTTP ${path})` : `port ${port} (TCP)`;

    // Normalize status to min/max
    const statusMin = typeof status === 'number' ? status : status.min;
    const statusMax = typeof status === 'number' ? status : status.max;

    // Open streaming watch - container handles internal polling
    const stream = await this.client.ports.watchPort({
      port,
      mode,
      path,
      statusMin,
      statusMax,
      processId,
      interval
    });

    // Set up timeout if specified
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timeoutPromise: Promise<never> | undefined;

    if (timeout !== undefined) {
      timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            this.createReadyTimeoutError(
              processId,
              command,
              conditionStr,
              timeout
            )
          );
        }, timeout);
      });
    }

    try {
      const streamProcessor = async (): Promise<void> => {
        for await (const event of parseSSEStream<PortWatchEvent>(stream)) {
          switch (event.type) {
            case 'ready':
              return; // Success!
            case 'process_exited':
              throw this.createExitedBeforeReadyError(
                processId,
                command,
                conditionStr,
                event.exitCode ?? 1
              );
            case 'error':
              throw new Error(event.error || 'Port watch failed');
            // 'watching' - continue
          }
        }
        throw new Error('Port watch stream ended unexpectedly');
      };

      if (timeoutPromise) {
        await Promise.race([streamProcessor(), timeoutPromise]);
      } else {
        await streamProcessor();
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      // Cancel the stream to stop container-side polling
      try {
        await stream.cancel();
      } catch {
        // Stream may already be closed
      }
    }
  }

  /**
   * Wait for a process to exit
   * Returns the exit code
   */
  private async waitForProcessExit(
    processId: string,
    command: string,
    timeout?: number
  ): Promise<WaitForExitResult> {
    const stream = await this.client.processes.streamProcessLogs(processId);

    // Set up timeout if specified
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timeoutPromise: Promise<never> | undefined;

    if (timeout !== undefined) {
      timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            this.createReadyTimeoutError(
              processId,
              command,
              'process exit',
              timeout
            )
          );
        }, timeout);
      });
    }

    try {
      const streamProcessor = async (): Promise<WaitForExitResult> => {
        for await (const event of parseSSEStream<LogEvent>(stream)) {
          if (event.type === 'exit') {
            return {
              exitCode: event.exitCode ?? 1
            };
          }
        }

        // Stream ended without exit event - shouldn't happen, but handle gracefully
        throw new Error(
          `Process ${processId} stream ended unexpectedly without exit event`
        );
      };

      if (timeoutPromise) {
        return await Promise.race([streamProcessor(), timeoutPromise]);
      }
      return await streamProcessor();
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Match a pattern against text
   */
  private matchPattern(
    text: string,
    pattern: string | RegExp
  ): WaitForLogResult | null {
    if (typeof pattern === 'string') {
      // Simple substring match
      if (text.includes(pattern)) {
        // Find the line containing the pattern
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.includes(pattern)) {
            return { line };
          }
        }
        return { line: pattern };
      }
    } else {
      const safePattern = new RegExp(
        pattern.source,
        pattern.flags.replace('g', '')
      );
      const match = text.match(safePattern);
      if (match) {
        // Find the full line containing the match
        const lines = text.split('\n');
        for (const line of lines) {
          const lineMatch = line.match(safePattern);
          if (lineMatch) {
            return { line, match: lineMatch };
          }
        }
        return { line: match[0], match };
      }
    }
    return null;
  }

  /**
   * Convert a log pattern to a human-readable string
   */
  private conditionToString(pattern: string | RegExp): string {
    if (typeof pattern === 'string') {
      return `"${pattern}"`;
    }
    return pattern.toString();
  }

  /**
   * Create a ProcessReadyTimeoutError
   */
  private createReadyTimeoutError(
    processId: string,
    command: string,
    condition: string,
    timeout: number
  ): ProcessReadyTimeoutError {
    return new ProcessReadyTimeoutError({
      code: ErrorCode.PROCESS_READY_TIMEOUT,
      message: `Process did not become ready within ${timeout}ms. Waiting for: ${condition}`,
      context: {
        processId,
        command,
        condition,
        timeout
      },
      httpStatus: 408,
      timestamp: new Date().toISOString(),
      suggestion: `Check if your process outputs ${condition}. You can increase the timeout parameter.`
    });
  }

  /**
   * Create a ProcessExitedBeforeReadyError
   */
  private createExitedBeforeReadyError(
    processId: string,
    command: string,
    condition: string,
    exitCode: number
  ): ProcessExitedBeforeReadyError {
    return new ProcessExitedBeforeReadyError({
      code: ErrorCode.PROCESS_EXITED_BEFORE_READY,
      message: `Process exited with code ${exitCode} before becoming ready. Waiting for: ${condition}`,
      context: {
        processId,
        command,
        condition,
        exitCode
      },
      httpStatus: 500,
      timestamp: new Date().toISOString(),
      suggestion: 'Check process logs with getLogs() for error messages'
    });
  }

  // Background process management ----------------------------------------

  /** Re-attach to an existing process by id. */
  async getProcess(
    id: string,
    options?: ProcessQueryOptions
  ): Promise<SandboxProcess | null> {
    const session = this.validateOptionalSessionId(options?.sessionId);
    try {
      const response = await this.client.processes.getProcess(id);
      if (!response.process) return null;
      const data = response.process;
      return toRpcSandboxProcess(
        new SandboxProcessImpl(
          {
            id: data.id,
            pid: data.pid ?? -1,
            command: data.command,
            sessionId: session,
            startTime:
              typeof data.startTime === 'string'
                ? new Date(data.startTime)
                : (data.startTime ?? new Date()),
            status: data.status,
            ownership: 'attached',
            stdout: data.stdout ?? 'pipe',
            stderr: data.stderr ?? 'pipe',
            stdin: null
          },
          this.buildSandboxProcessDeps()
        )
      );
    } catch (error) {
      if (error instanceof ProcessNotFoundError) return null;
      throw error;
    }
  }

  /** Return lightweight process snapshots. */
  async listProcesses(
    options?: ProcessQueryOptions
  ): Promise<SandboxProcess[]> {
    const session = this.validateOptionalSessionId(options?.sessionId);
    const response = await this.client.processes.listProcesses();
    const deps = this.buildSandboxProcessDeps();
    return response.processes.map((data) =>
      toRpcSandboxProcess(
        new SandboxProcessImpl(
          {
            id: data.id,
            pid: data.pid ?? -1,
            command: data.command,
            sessionId: session,
            startTime:
              typeof data.startTime === 'string'
                ? new Date(data.startTime)
                : (data.startTime ?? new Date()),
            status: data.status,
            ownership: 'attached',
            stdout: data.stdout ?? 'ignore',
            stderr: data.stderr ?? 'ignore',
            stdin: null
          },
          deps
        )
      )
    );
  }

  async killAllProcesses(): Promise<number> {
    const response = await this.client.processes.killAllProcesses();
    return response.cleanedCount;
  }

  async cleanupCompletedProcesses(): Promise<number> {
    // Not yet implemented — requires container endpoint.
    return 0;
  }

  async gitCheckout(
    repoUrl: string,
    options?: {
      branch?: string;
      targetDir?: string;
      sessionId?: string;
      /** Clone depth for shallow clones (e.g., 1 for latest commit only) */
      depth?: number;
      /** Maximum wall-clock time for the git clone subprocess in milliseconds */
      cloneTimeoutMs?: number;
    }
  ) {
    const session = this.validateOptionalSessionId(options?.sessionId);
    return this.client.git.checkout(repoUrl, {
      ...(session !== undefined && { sessionId: session }),
      branch: options?.branch,
      targetDir: options?.targetDir,
      depth: options?.depth,
      timeoutMs: options?.cloneTimeoutMs
    });
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean; sessionId?: string } = {}
  ) {
    const session = this.validateOptionalSessionId(options.sessionId);
    return this.client.files.mkdir(path, {
      ...(session !== undefined && { sessionId: session }),
      recursive: options.recursive
    });
  }

  async writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options: { encoding?: string; sessionId?: string } = {}
  ) {
    const session = this.validateOptionalSessionId(options.sessionId);

    if (content instanceof ReadableStream) {
      return this.client.files.writeFileStream(path, content, {
        ...(session !== undefined && { sessionId: session })
      });
    }

    return this.client.files.writeFile(path, content, {
      ...(session !== undefined && { sessionId: session }),
      encoding: options.encoding
    });
  }

  async deleteFile(path: string, options: { sessionId?: string } = {}) {
    const session = this.validateOptionalSessionId(options.sessionId);
    return session === undefined
      ? this.client.files.deleteFile(path)
      : this.client.files.deleteFile(path, { sessionId: session });
  }

  async renameFile(
    oldPath: string,
    newPath: string,
    options: { sessionId?: string } = {}
  ) {
    const session = this.validateOptionalSessionId(options.sessionId);
    return session === undefined
      ? this.client.files.renameFile(oldPath, newPath)
      : this.client.files.renameFile(oldPath, newPath, { sessionId: session });
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string,
    options: { sessionId?: string } = {}
  ) {
    const session = this.validateOptionalSessionId(options.sessionId);
    return session === undefined
      ? this.client.files.moveFile(sourcePath, destinationPath)
      : this.client.files.moveFile(sourcePath, destinationPath, {
          sessionId: session
        });
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
    options: { encoding: 'none'; sessionId?: string }
  ): Promise<ReadFileStreamResult>;
  async readFile(
    path: string,
    options?: { encoding?: Exclude<FileEncoding, 'none'>; sessionId?: string }
  ): Promise<ReadFileResult>;
  async readFile(
    path: string,
    options: { encoding?: FileEncoding; sessionId?: string } = {}
  ): Promise<ReadFileResult | ReadFileStreamResult> {
    const session = this.validateOptionalSessionId(options.sessionId);
    if (options.encoding === 'none') {
      return this.client.files.readFile(path, {
        ...(session !== undefined && { sessionId: session }),
        encoding: 'none'
      });
    }
    return this.client.files.readFile(path, {
      ...(session !== undefined && { sessionId: session }),
      encoding: options.encoding
    });
  }

  /**
   * Stream a file from the sandbox using Server-Sent Events
   * Returns a ReadableStream that can be consumed with streamFile() or collectFile() utilities
   * @param path - Path to the file to stream
   * @param options - Optional session ID
   */
  async readFileStream(
    path: string,
    options: { sessionId?: string } = {}
  ): Promise<ReadableStream<Uint8Array>> {
    const session = this.validateOptionalSessionId(options.sessionId);
    return this.client.files.readFileStream(path, {
      ...(session !== undefined && { sessionId: session })
    });
  }

  async listFiles(path: string, options?: ListFilesOptions) {
    const session = this.validateOptionalSessionId(options?.sessionId);
    return this.client.files.listFiles(path, {
      ...options,
      ...(session !== undefined && { sessionId: session })
    });
  }

  async exists(path: string, options: { sessionId?: string } = {}) {
    const session = this.validateOptionalSessionId(options.sessionId);
    return session === undefined
      ? this.client.files.exists(path)
      : this.client.files.exists(path, { sessionId: session });
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
    const sessionId = this.validateOptionalSessionId(options.sessionId);
    return this.client.watch.watch({
      path,
      recursive: options.recursive,
      include: options.include,
      exclude: options.exclude,
      sessionId
    });
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
    const sessionId = this.validateOptionalSessionId(options.sessionId);
    return this.client.watch.checkChanges({
      path,
      recursive: options.recursive,
      include: options.include,
      exclude: options.exclude,
      since: options.since,
      sessionId
    });
  }

  private async ensureRuntimeActiveForPreview(): Promise<RuntimeIdentity> {
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
  // Session Management - Advanced Use Cases
  // ============================================================================

  /**
   * Create isolated execution session for advanced use cases
   * Returns ExecutionSession with full sandbox API bound to specific session
   */
  async createSession(options?: SessionOptions): Promise<ExecutionSession> {
    const sessionId = options?.id || `session-${Date.now()}`;

    const mergedEnv = {
      ...this.envVars,
      ...(options?.env ?? {})
    };
    const filteredEnv = filterEnvVars(mergedEnv);
    const envPayload =
      Object.keys(filteredEnv).length > 0 ? filteredEnv : undefined;

    // Create session in container
    const response = await this.client.utils.createSession({
      id: sessionId,
      ...(envPayload && { env: envPayload }),
      ...(options?.cwd && { cwd: options.cwd }),
      ...(options?.commandTimeoutMs !== undefined && {
        commandTimeoutMs: options.commandTimeoutMs
      })
    });

    await this.capturePlacementId(response.containerPlacementId);

    // Return wrapper that binds sessionId to all operations
    return this.getSessionWrapper(sessionId);
  }

  /**
   * Get an existing session by ID
   * Returns ExecutionSession wrapper bound to the specified session
   *
   * This is useful for retrieving sessions across different requests/contexts
   * without storing the ExecutionSession object (which has RPC lifecycle limitations)
   *
   * @param sessionId - The ID of an existing session
   * @returns ExecutionSession wrapper bound to the session
   */
  async getSession(sessionId: string): Promise<ExecutionSession> {
    // No need to verify session exists in container - operations will fail naturally if it doesn't
    return this.getSessionWrapper(sessionId);
  }

  /**
   * Delete an execution session.
   *
   * Cleans up explicit session resources and removes them from the container.
   *
   * @param sessionId - The ID of the session to delete
   * @returns Result with success status, sessionId, and timestamp
   */
  async deleteSession(sessionId: string): Promise<SessionDeleteResult> {
    const response = await this.client.utils.deleteSession(sessionId);

    // Map HTTP response to result type
    return {
      success: response.success,
      sessionId: response.sessionId,
      timestamp: response.timestamp
    };
  }

  /**
   * Get the Cloudflare placement ID observed for the underlying container.
   *
   * The placement ID is captured during the first session-create handshake
   * after a container start and stored in Durable Object storage, so this
   * method returns the cached value without contacting the container. A new
   * placement ID is captured on each subsequent session-create handshake,
   * which occurs whenever the container has been replaced.
   *
   * Returns `null` when a handshake has completed but the container's
   * `CLOUDFLARE_PLACEMENT_ID` environment variable is not set (for example,
   * in local development).
   *
   * Returns `undefined` when no explicit session-create handshake has been
   * observed yet on this sandbox. Call `createSession()` to populate the value.
   */
  async getContainerPlacementId(): Promise<string | null | undefined> {
    return this.ctx.storage.get<string | null>('containerPlacementId');
  }

  private getSessionWrapper(sessionId: string): ExecutionSession {
    // terminal: null here, added client-side by getSandbox() (WebSockets can't cross RPC)
    return {
      id: sessionId,
      terminal: null as unknown as ExecutionSession['terminal'],

      // Unified exec (mirrors `ctx.container.exec()` contract). Session-scoped:
      // caller-provided `options.sessionId` is overridden by this wrapper's
      // sessionId to enforce session pinning.
      exec: (command: string | string[], execOptions?: SandboxExecOptions) =>
        createSandboxProcessPromise(
          this.spawnSandboxProcess(command, { ...execOptions, sessionId })
        ),

      run: (command, options) =>
        this.executeCommand(command, sessionId, options),

      // Process management
      listProcesses: () => this.listProcesses({ sessionId }),
      getProcess: (id) => this.getProcess(id, { sessionId }),
      killAllProcesses: () => this.killAllProcesses(),
      cleanupCompletedProcesses: () => this.cleanupCompletedProcesses(),

      // File operations - pass sessionId via options
      writeFile: (path, content, options) =>
        this.writeFile(path, content, { ...options, sessionId }),
      readFile: ((
        path: string,
        options?: { encoding?: FileEncoding; sessionId?: string }
      ) => {
        const encoding = options?.encoding;
        if (encoding === 'none') {
          return this.readFile(path, { encoding: 'none', sessionId });
        }
        return this.readFile(path, { encoding, sessionId });
      }) as ExecutionSession['readFile'],
      readFileStream: (path) => this.readFileStream(path, { sessionId }),
      watch: (path, options) => this.watch(path, { ...options, sessionId }),
      checkChanges: (path, options) =>
        this.checkChanges(path, { ...options, sessionId }),
      mkdir: (path, options) => this.mkdir(path, { ...options, sessionId }),
      deleteFile: (path) => this.deleteFile(path, { sessionId }),
      renameFile: (oldPath, newPath) =>
        this.renameFile(oldPath, newPath, { sessionId }),
      moveFile: (sourcePath, destPath) =>
        this.moveFile(sourcePath, destPath, { sessionId }),
      listFiles: (path, options) =>
        this.listFiles(path, { ...options, sessionId }),
      exists: (path) => this.exists(path, { sessionId }),

      // Git operations
      gitCheckout: (repoUrl, options) =>
        this.gitCheckout(repoUrl, { ...options, sessionId }),

      setEnvVars: async (envVars: Record<string, string | undefined>) => {
        const { toSet, toUnset } = partitionEnvVars(envVars);

        try {
          for (const key of toUnset) {
            const unsetCommand = `unset ${key}`;

            const result = await this.client.commands.execute(unsetCommand, {
              sessionId,
              origin: 'internal'
            });

            if (result.exitCode !== 0) {
              throw new Error(
                `Failed to unset ${key}: ${result.stderr || 'Unknown error'}`
              );
            }
          }

          for (const [key, value] of Object.entries(toSet)) {
            const exportCommand = `export ${key}=${shellEscape(value)}`;

            const result = await this.client.commands.execute(exportCommand, {
              sessionId,
              origin: 'internal'
            });

            if (result.exitCode !== 0) {
              throw new Error(
                `Failed to set ${key}: ${result.stderr || 'Unknown error'}`
              );
            }
          }
        } catch (error) {
          this.logger.error(
            'Failed to set environment variables',
            error instanceof Error ? error : new Error(String(error)),
            { sessionId }
          );
          throw error;
        }
      },

      // Bucket mounting - sandbox-level operations
      mountBucket: (bucket, mountPath, options) =>
        this.mountBucket(bucket, mountPath, options),
      unmountBucket: (mountPath) => this.unmountBucket(mountPath),

      // Backup operations - sandbox-level, uses R2 binding
      createBackup: (options) => this.createBackup(options),
      restoreBackup: (backup: DirectoryBackup) => this.restoreBackup(backup)
    };
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

  private async configureR2EgressOutbound(
    params: R2EgressParams
  ): Promise<void> {
    const ctx = this.ctx as EgressContainerState;
    if (!ctx.container?.interceptOutboundHttp) {
      throw new InvalidMountConfigError(
        'R2 binding mounts require container outbound interception support'
      );
    }
    if (!ctx.exports?.ContainerProxy) {
      throw new InvalidMountConfigError(
        'R2 binding mounts require exporting ContainerProxy from the Worker entrypoint'
      );
    }

    // Register r2EgressMount on the concrete subclass's local registry so
    // setOutboundByHost's validateOutboundHandlerMethodName check passes. The
    // actual dispatch is handled by the SDK ContainerProxy.fetch() override,
    // which directly calls r2EgressHandler by hostname without going through
    // the registry (which is NOT shared across execution contexts).
    (this.constructor as unknown as OutboundHandlerRegistry).outboundHandlers =
      { r2EgressMount: r2EgressHandler };
    if (Object.keys(params.buckets).length > 0) {
      await this.setOutboundByHost<R2EgressParams>(
        'r2.internal',
        'r2EgressMount',
        params
      );
    } else {
      await this.removeOutboundByHost('r2.internal');
    }

    this.logger.debug('r2 egress: registering host interception', {
      host: 'r2.internal',
      method: 'r2EgressMount',
      targetClassName: CONTAINER_PROXY_CLASS_NAME
    });

    const fetcher = ctx.exports.ContainerProxy({
      props: {
        enableInternet: this.enableInternet,
        containerId: this.ctx.id.toString(),
        className: CONTAINER_PROXY_CLASS_NAME,
        outboundByHostOverrides: {
          'r2.internal': {
            method: 'r2EgressMount',
            params
          }
        }
      }
    });
    if (!isFetcher(fetcher)) {
      throw new InvalidMountConfigError(
        'R2 binding mounts require ContainerProxy to return a valid Fetcher'
      );
    }

    await ctx.container.interceptOutboundHttp('r2.internal', fetcher);
  }

  private async configureS3CredentialProxyOutbound(
    params: S3CredentialProxyParams
  ): Promise<void> {
    const ctx = this.ctx as EgressContainerState;
    if (!ctx.container?.interceptOutboundHttp) {
      throw new InvalidMountConfigError(
        'Credential proxy bucket mounts require container outbound interception support'
      );
    }
    if (!ctx.exports?.ContainerProxy) {
      throw new InvalidMountConfigError(
        'Credential proxy bucket mounts require exporting ContainerProxy from the Worker entrypoint'
      );
    }

    const hosts = [
      S3_CREDENTIAL_PROXY_HOST,
      S3_CREDENTIAL_PROXY_DIAGNOSTIC_HOST
    ];

    // Register s3CredentialProxyMount on the concrete subclass's local registry
    // so setOutboundByHost's validateOutboundHandlerMethodName check passes.
    // Actual dispatch is handled by the SDK ContainerProxy.fetch() override.
    (this.constructor as unknown as OutboundHandlerRegistry).outboundHandlers =
      { s3CredentialProxyMount: s3CredentialProxyHandler };
    if (Object.keys(params.mounts).length > 0) {
      for (const host of hosts) {
        await this.setOutboundByHost<S3CredentialProxyParams>(
          host,
          's3CredentialProxyMount',
          params
        );
      }
    } else {
      for (const host of hosts) {
        await this.removeOutboundByHost(host);
      }
    }

    const hostOverrides: Record<
      string,
      { method: string; params: S3CredentialProxyParams }
    > = {};
    for (const host of hosts) {
      hostOverrides[host] = { method: 's3CredentialProxyMount', params };
    }

    this.logger.debug('s3 credential proxy: registering host interception', {
      hosts,
      method: 's3CredentialProxyMount',
      targetClassName: CONTAINER_PROXY_CLASS_NAME
    });

    const fetcher = ctx.exports.ContainerProxy({
      props: {
        enableInternet: this.enableInternet,
        containerId: this.ctx.id.toString(),
        className: CONTAINER_PROXY_CLASS_NAME,
        outboundByHostOverrides: hostOverrides
      }
    });
    if (!isFetcher(fetcher)) {
      throw new InvalidMountConfigError(
        'Credential proxy bucket mounts require ContainerProxy to return a valid Fetcher'
      );
    }

    try {
      const selfTest = await fetcher.fetch(
        new Request(
          `http://${S3_CREDENTIAL_PROXY_HOST}${S3_CREDENTIAL_PROXY_SELF_TEST_PATH}`
        )
      );
      await selfTest.text();
      this.logger.debug('s3 credential proxy: fetcher self-test complete', {
        status: selfTest.status
      });
    } catch (error) {
      this.logger.warn('s3 credential proxy: fetcher self-test failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    for (const host of hosts) {
      await ctx.container.interceptOutboundHttp(host, fetcher);
    }
  }
}
