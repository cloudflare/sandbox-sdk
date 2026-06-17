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
  ProcessStatus,
  R2BindingMountBucketOptions,
  ReadFileResult,
  ReadFileStreamResult,
  RemoteMountBucketOptions,
  RestoreBackupResult,
  SandboxOptions,
  SandboxTerminal,
  SessionOptions,
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
import { DISABLE_SESSION_TOKEN } from '@repo/shared/internal';
import {
  type BackupRestoreTestFault,
  BackupService
} from './backup/backup-service';
import { ContainerControlClient } from './container-control';
import {
  CurrentRuntimeIdentity,
  type RuntimeIdentity,
  type RuntimeScoped
} from './current-runtime-identity';
import type { ErrorResponse } from './errors';
import {
  ContainerUnavailableError,
  CustomDomainRequiredError,
  ErrorCode,
  OperationInterruptedError,
  ProcessExitedBeforeReadyError,
  ProcessNotFoundError,
  ProcessReadyTimeoutError,
  SessionAlreadyExistsError
} from './errors';
import { SandboxExtension } from './extensions';
import { collectFile, streamFile } from './file-stream';
import { LocalMountSyncManager } from './local-mount-sync';
import { isPlatformTransientError } from './platform-errors';
import {
  forwardPreviewRequest,
  type PreviewTCPPort
} from './preview-forwarding';
import {
  PREVIEW_PROXY_HEADER,
  PREVIEW_PROXY_HEADERS,
  PREVIEW_PROXY_PORT_HEADER,
  PREVIEW_PROXY_SANDBOX_ID_HEADER,
  PREVIEW_PROXY_TOKEN_HEADER
} from './preview-proxy-protocol';
import { isLocalhostPattern } from './preview-url';
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

/**
 * Persisted record for a single exposed port. `token` authorizes preview
 * URL requests; `name` is the optional friendly name the caller passed to
 * `exposePort()` and is preserved across container restarts.
 */
type PortTokenEntry = {
  token: string;
  name?: string;
};

type PreviewURLRuntimeValidation =
  | { status: 'invalid' }
  | {
      status: 'stale';
      reason:
        | 'runtime-not-healthy'
        | 'runtime-not-running'
        | 'missing-runtime-id'
        | 'missing-activation'
        | 'runtime-mismatch'
        | 'token-mismatch';
      containerStatus?: string;
    }
  | { status: 'active'; runtime: RuntimeIdentity };

type PreviewPortActivation = RuntimeScoped<{
  token: string;
}>;

type PreviewPortActivations = Record<string, PreviewPortActivation>;

type CurrentPreviewPort = {
  port: number;
  entry: PortTokenEntry;
};

type PreviewStateStorage = Pick<
  DurableObjectStorage | DurableObjectTransaction,
  'get' | 'put' | 'delete'
>;

const PORT_TOKENS_STORAGE_KEY = 'portTokens';
const ACTIVE_PREVIEW_PORTS_STORAGE_KEY = 'activePreviewPorts';

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
  container?: {
    running: boolean;
    getTcpPort(port: number): PreviewTCPPort;
  };
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
  destroyTerminal: (id: string) => Promise<void>;
  execWithSessionToken: (
    command: string,
    sessionId: string,
    options?: ExecOptions
  ) => Promise<ExecResult>;
};

type SandboxExecutionContext =
  | { kind: 'session'; sessionId: string }
  | { kind: 'sessionless' };

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

const DEFAULT_SESSION_INIT_MAX_ATTEMPTS = 2;
const DEFAULT_SESSION_RESTART_SETTLE_MS = 100;

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

  const useDefaultSession = options?.enableDefaultSession !== false;

  const enhancedMethods = {
    fetch: (request: Request) => stub.fetch(request),
    exec: (command: string, execOptions?: ExecOptions) =>
      useDefaultSession
        ? stub.exec(command, execOptions)
        : stub.execWithSessionToken(
            command,
            DISABLE_SESSION_TOKEN,
            execOptions
          ),
    startProcess: (command: string, processOptions?: ProcessOptions) =>
      useDefaultSession || processOptions?.sessionId !== undefined
        ? stub.startProcess(command, processOptions)
        : stub.startProcess(command, {
            ...processOptions,
            sessionId: DISABLE_SESSION_TOKEN
          }),
    listProcesses: (sessionId?: string) =>
      useDefaultSession || sessionId !== undefined
        ? stub.listProcesses(sessionId)
        : stub.listProcesses(DISABLE_SESSION_TOKEN),
    getProcess: (id: string, sessionId?: string) =>
      useDefaultSession || sessionId !== undefined
        ? stub.getProcess(id, sessionId)
        : stub.getProcess(id, DISABLE_SESSION_TOKEN),

    writeFile: (
      path: string,
      content: string | ReadableStream<Uint8Array>,
      fileOptions: { encoding?: string; sessionId?: string } = {}
    ) =>
      useDefaultSession || fileOptions.sessionId !== undefined
        ? stub.writeFile(path, content, fileOptions)
        : stub.writeFile(path, content, {
            ...fileOptions,
            sessionId: DISABLE_SESSION_TOKEN
          }),
    readFile: (
      path: string,
      fileOptions:
        | { encoding: 'none'; sessionId?: string }
        | { encoding?: Exclude<FileEncoding, 'none'>; sessionId?: string } = {}
    ) => {
      const options =
        useDefaultSession || fileOptions.sessionId !== undefined
          ? fileOptions
          : { ...fileOptions, sessionId: DISABLE_SESSION_TOKEN };

      if (options.encoding === 'none') {
        return stub.readFile(path, options);
      }

      return stub.readFile(path, options);
    },
    readFileStream: (path: string, fileOptions: { sessionId?: string } = {}) =>
      useDefaultSession || fileOptions.sessionId !== undefined
        ? stub.readFileStream(path, fileOptions)
        : stub.readFileStream(path, { sessionId: DISABLE_SESSION_TOKEN }),
    mkdir: (
      path: string,
      mkdirOptions: { recursive?: boolean; sessionId?: string } = {}
    ) =>
      useDefaultSession || mkdirOptions.sessionId !== undefined
        ? stub.mkdir(path, mkdirOptions)
        : stub.mkdir(path, {
            ...mkdirOptions,
            sessionId: DISABLE_SESSION_TOKEN
          }),
    deleteFile: (path: string) =>
      useDefaultSession
        ? stub.deleteFile(path)
        : stub.deleteFile(path, DISABLE_SESSION_TOKEN),
    renameFile: (oldPath: string, newPath: string) =>
      useDefaultSession
        ? stub.renameFile(oldPath, newPath)
        : stub.renameFile(oldPath, newPath, DISABLE_SESSION_TOKEN),
    moveFile: (sourcePath: string, destinationPath: string) =>
      useDefaultSession
        ? stub.moveFile(sourcePath, destinationPath)
        : stub.moveFile(sourcePath, destinationPath, DISABLE_SESSION_TOKEN),
    listFiles: (path: string, listOptions?: ListFilesOptions) =>
      useDefaultSession || listOptions?.sessionId !== undefined
        ? stub.listFiles(path, listOptions)
        : stub.listFiles(path, {
            ...listOptions,
            sessionId: DISABLE_SESSION_TOKEN
          }),
    exists: (path: string, sessionId?: string) =>
      useDefaultSession || sessionId !== undefined
        ? stub.exists(path, sessionId)
        : stub.exists(path, DISABLE_SESSION_TOKEN),
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
      useDefaultSession || gitOptions?.sessionId !== undefined
        ? stub.gitCheckout(repoUrl, gitOptions)
        : stub.gitCheckout(repoUrl, {
            ...gitOptions,
            sessionId: DISABLE_SESSION_TOKEN
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
      useDefaultSession || options.sessionId !== undefined
        ? stub.watch(path, options)
        : stub.watch(path, { ...options, sessionId: DISABLE_SESSION_TOKEN }),
    checkChanges: (path: string, options: CheckChangesOptions = {}) =>
      useDefaultSession || options.sessionId !== undefined
        ? stub.checkChanges(path, options)
        : stub.checkChanges(path, {
            ...options,
            sessionId: DISABLE_SESSION_TOKEN
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
  private defaultSession: string | null = null;
  // Incremented whenever the container stops. Used to invalidate
  // in-flight default-session initialization that started against a
  // now-dead container.
  private containerGeneration = 0;
  private defaultSessionInit: {
    sessionId: string;
    generation: number;
    promise: Promise<string>;
  } | null = null;
  envVars: Record<string, string> = {};
  private logger: ReturnType<typeof createLogger>;
  private keepAliveEnabled: boolean = false;
  private activeMounts: Map<string, MountInfo> = new Map();
  private mountOperationQueue: Promise<void> = Promise.resolve();
  private currentRuntime: CurrentRuntimeIdentity;
  private currentLifetime: CurrentSandboxLifetime;
  private backupService: BackupService;

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
        this.execWithSession(command, sessionId, options),
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

    this.ctx.blockConcurrencyWhile(async () => {
      this.sandboxName =
        (await this.ctx.storage.get<string>('sandboxName')) ?? null;
      this.normalizeId =
        (await this.ctx.storage.get<boolean>('normalizeId')) ?? false;
      this.defaultSession =
        (await this.ctx.storage.get<string>('defaultSession')) ?? null;
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

    if (this.defaultSession) {
      for (const key of toUnset) {
        const unsetCommand = `unset ${key}`;

        const result = await this.client.commands.execute(
          unsetCommand,
          this.defaultSession,
          { origin: 'internal' }
        );

        if (result.exitCode !== 0) {
          throw new Error(
            `Failed to unset ${key}: ${result.stderr || 'Unknown error'}`
          );
        }
      }

      for (const [key, value] of Object.entries(toSet)) {
        const exportCommand = `export ${key}=${shellEscape(value)}`;

        const result = await this.client.commands.execute(
          exportCommand,
          this.defaultSession,
          { origin: 'internal' }
        );

        if (result.exitCode !== 0) {
          throw new Error(
            `Failed to set ${key}: ${result.stderr || 'Unknown error'}`
          );
        }
      }
    }
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

      const sessionId = await this.ensureDefaultSession();

      const syncManager = new LocalMountSyncManager({
        bucket: r2Binding,
        mountPath,
        prefix: options.prefix,
        readOnly: options.readOnly ?? false,
        client: this.client,
        sessionId,
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
      S3FS_DISABLE_EXPECT_HEADER_CONFIG,
      DISABLE_SESSION_TOKEN
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

    await this.client.files.writeFile(
      passwordFilePath,
      content,
      DISABLE_SESSION_TOKEN
    );

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
    // The whole script runs inside a `( ... )` subshell. execInternal and
    // execWithSession dispatch into a long-lived bash session shell; a bare
    // top-level `exit N` would terminate that session and surface as
    // SESSION_TERMINATED to every subsequent caller. The subshell scopes the
    // exits so only the subshell exits, and its status becomes the command's
    // exit code as the caller expects.
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
          this.execWithSession(cmd, sessionId, { origin: 'internal' })
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
      await this.ctx.storage.delete(PORT_TOKENS_STORAGE_KEY);
      await this.clearActivePreviewPorts();
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
    await this.clearActivePreviewPorts();
    await super.stop(signal);
  }

  /**
   * Read the `portTokens` map from DO storage, normalizing the legacy
   * string-valued format (just a token) to the current object format
   * ({ token, name? }). The legacy format predates port-name persistence and
   * can appear on any DO whose storage was written before that change.
   */
  private async readPortTokens(
    storage: PreviewStateStorage = this.ctx.storage
  ): Promise<Record<string, PortTokenEntry>> {
    const raw =
      (await storage.get<Record<string, string | PortTokenEntry>>(
        PORT_TOKENS_STORAGE_KEY
      )) ?? {};
    const normalized: Record<string, PortTokenEntry> = {};
    for (const [port, value] of Object.entries(raw)) {
      normalized[port] = typeof value === 'string' ? { token: value } : value;
    }
    return normalized;
  }

  private async readActivePreviewPorts(
    storage: PreviewStateStorage = this.ctx.storage
  ): Promise<PreviewPortActivations> {
    return (
      (await storage.get<PreviewPortActivations>(
        ACTIVE_PREVIEW_PORTS_STORAGE_KEY
      )) ?? {}
    );
  }

  private async writeActivePreviewPorts(
    activations: PreviewPortActivations,
    storage: PreviewStateStorage = this.ctx.storage
  ): Promise<void> {
    if (Object.keys(activations).length === 0) {
      await storage.delete(ACTIVE_PREVIEW_PORTS_STORAGE_KEY);
      return;
    }

    await storage.put(ACTIVE_PREVIEW_PORTS_STORAGE_KEY, activations);
  }

  private async readPreviewState(
    storage: PreviewStateStorage = this.ctx.storage
  ): Promise<{
    tokens: Record<string, PortTokenEntry>;
    activations: PreviewPortActivations;
  }> {
    const [tokens, activations] = await Promise.all([
      this.readPortTokens(storage),
      this.readActivePreviewPorts(storage)
    ]);
    return { tokens, activations };
  }

  private async clearActivePreviewPorts(): Promise<void> {
    await this.ctx.storage.delete(ACTIVE_PREVIEW_PORTS_STORAGE_KEY);
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

    // Invalidate default-session state before the first await. Bumping
    // containerGeneration signals any in-flight initializeDefaultSession
    // that a new container generation begins next; it observes the
    // mismatch at its post-createSession check and fails. Clearing the
    // slot means later callers start a new init against the next
    // container.
    this.containerGeneration++;
    this.defaultSession = null;
    this.defaultSessionInit = null;

    await this.currentRuntime.clear();
    await this.clearActivePreviewPorts();

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

    // Persist cleanup to storage so state is clean on next container start.
    // Port tokens are durable authorization and survive container restarts;
    // runtime-scoped preview activation is cleared separately above.
    await this.ctx.storage.delete('defaultSession');
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

  private isPreviewProxyRequest(request: Request): boolean {
    // These headers are internal control metadata added by proxyToSandbox()
    // before the request enters this Durable Object.
    return request.headers.get(PREVIEW_PROXY_HEADER) === '1';
  }

  private invalidPreviewTokenResponse(): Response {
    return new Response(
      JSON.stringify({
        error: 'Access denied: Invalid token or port not exposed',
        code: 'INVALID_TOKEN'
      }),
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  }

  private stalePreviewURLResponse(): Response {
    return new Response(
      JSON.stringify({
        error: 'Preview URL is stale because the sandbox runtime is not active',
        code: 'STALE_PREVIEW_URL'
      }),
      {
        status: 410,
        headers: {
          'Content-Type': 'application/json'
        }
      }
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

  private async fetchPreviewIfRunning(
    request: Request,
    port: number,
    runtime: RuntimeIdentity
  ): Promise<Response> {
    const container = this.getPreviewForwardingContainer();
    const state = await this.getState();

    if (!container?.running || state.status !== 'healthy') {
      return this.stalePreviewURLResponse();
    }

    if (!(await this.currentRuntime.isActive(runtime))) {
      return this.stalePreviewURLResponse();
    }

    const tcpPort = container.getTcpPort(port);

    // Keep dispatch adjacent to the final runtime check above. Stale preview
    // traffic must not observe an active runtime and then reach a different
    // runtime through another async interleaving.
    const result = await forwardPreviewRequest(tcpPort, request, {
      beginForward: () => this.beginPreviewForward(),
      renewActivity: () => this.renewActivityTimeout()
    });

    if (result.status === 'network-lost') {
      if (!(await this.currentRuntime.isActive(runtime))) {
        return this.stalePreviewURLResponse();
      }

      return new Response('Container suddenly disconnected, try again', {
        status: 500
      });
    }

    return result.response;
  }

  private buildPreviewProxyRequest(
    request: Request,
    port: number,
    sandboxId: string
  ): Request {
    const url = new URL(request.url);
    const proxyUrl = `http://localhost:${port}${url.pathname}${url.search}`;
    const headers = new Headers(request.headers);
    for (const header of PREVIEW_PROXY_HEADERS) {
      headers.delete(header);
    }
    headers.set('X-Original-URL', request.url);
    headers.set('X-Forwarded-Host', url.hostname);
    headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
    headers.set('X-Sandbox-Name', this.sandboxName ?? sandboxId);

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      // WebSocket upgrade requests keep the original Request object so the
      // Workers runtime preserves upgrade semantics. Preview forwarding routes
      // by the explicit port argument, while the request URL still provides
      // the path and query.
      return new Request(request, {
        headers,
        redirect: 'manual'
      });
    }

    return new Request(proxyUrl, {
      method: request.method,
      headers,
      body: request.body,
      // @ts-expect-error - duplex required for body streaming in modern runtimes
      duplex: 'half',
      redirect: 'manual'
    });
  }

  private async proxyPreviewRequest(request: Request): Promise<Response> {
    const portValue = request.headers.get(PREVIEW_PROXY_PORT_HEADER);
    const token = request.headers.get(PREVIEW_PROXY_TOKEN_HEADER);
    const sandboxId = request.headers.get(PREVIEW_PROXY_SANDBOX_ID_HEADER);
    const port =
      portValue === null ? Number.NaN : Number.parseInt(portValue, 10);

    if (!Number.isFinite(port) || !validatePort(port) || !token || !sandboxId) {
      return this.invalidPreviewTokenResponse();
    }

    const proxyRequest = this.buildPreviewProxyRequest(
      request,
      port,
      sandboxId
    );

    const validation = await this.validatePreviewURLForRuntime(port, token);
    if (validation.status === 'invalid') {
      return this.invalidPreviewTokenResponse();
    }

    if (validation.status === 'stale') {
      this.logger.warn('Stale preview URL blocked', {
        port,
        sandboxId,
        containerStatus: validation.containerStatus,
        reason: validation.reason,
        method: request.method
      });
      return this.stalePreviewURLResponse();
    }

    return await this.fetchPreviewIfRunning(
      proxyRequest,
      port,
      validation.runtime
    );
  }

  // Override fetch to route internal container requests to appropriate ports
  override async fetch(request: Request): Promise<Response> {
    // Extract or generate trace ID from request
    const traceId =
      TraceContext.fromHeaders(request.headers) || TraceContext.generate();

    // Create request-specific logger with trace ID
    const requestLogger = this.logger.child({ traceId, operation: 'fetch' });

    const url = new URL(request.url);

    if (this.isPreviewProxyRequest(request)) {
      return await this.proxyPreviewRequest(request);
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
   * Return the default session id, lazily creating the container session
   * on first use. Called by every public method that needs a session.
   * Concurrent callers that target the same sessionId share one
   * in-flight initialization promise.
   */
  private async ensureDefaultSession(): Promise<string> {
    const sessionId = `sandbox-${this.sandboxName || 'default'}`;

    for (
      let attempt = 1;
      attempt <= DEFAULT_SESSION_INIT_MAX_ATTEMPTS;
      attempt++
    ) {
      try {
        return await this.getOrInitializeDefaultSession(sessionId);
      } catch (error) {
        if (
          !this.isDefaultSessionInitContainerRestart(error) ||
          attempt === DEFAULT_SESSION_INIT_MAX_ATTEMPTS
        ) {
          throw error;
        }
        // Give the next container generation a short local settle window
        // before recreating preparatory default-session state.
        await new Promise((resolve) =>
          setTimeout(resolve, DEFAULT_SESSION_RESTART_SETTLE_MS)
        );
      }
    }

    throw new Error('Default session initialization failed unexpectedly');
  }

  private async getOrInitializeDefaultSession(
    sessionId: string
  ): Promise<string> {
    // Fast path: session already initialized in this instance
    if (this.defaultSession === sessionId) {
      return this.defaultSession;
    }

    // The in-flight slot is keyed by (sessionId, generation). A caller
    // whose sessionId matches the current slot AND runs against the same
    // container generation awaits that shared promise. sandboxName
    // changing mid-flight yields a sessionId mismatch; a container stop
    // advances the generation and an older slot becomes non-joinable.
    const generation = this.containerGeneration;
    const pending = this.defaultSessionInit;
    if (pending?.sessionId === sessionId && pending.generation === generation) {
      return pending.promise;
    }

    const promise = this.initializeDefaultSession(sessionId, generation);
    const init = { sessionId, generation, promise };
    this.defaultSessionInit = init;
    try {
      return await promise;
    } finally {
      // Identity guard: only clear the slot if it still holds this
      // attempt. A newer mismatching caller or an onStop may have
      // taken the slot.
      if (this.defaultSessionInit === init) {
        this.defaultSessionInit = null;
      }
    }
  }

  private isDefaultSessionInitContainerRestart(error: unknown): boolean {
    return (
      error instanceof ContainerUnavailableError &&
      error.context.reason === 'container_replaced'
    );
  }

  private async initializeDefaultSession(
    sessionId: string,
    generation: number
  ): Promise<string> {
    let placementId: string | null | undefined;
    try {
      const response = await this.client.utils.createSession({
        id: sessionId,
        env: this.envVars || {},
        cwd: '/workspace'
      });
      placementId = response.containerPlacementId;
    } catch (error: unknown) {
      // The container can outlive this DO instance, so an existing session
      // means the container is already in the state we need.
      if (!(error instanceof SessionAlreadyExistsError)) {
        throw error;
      }
      placementId = error.containerPlacementId;
      this.logger.debug(
        'Session exists in container but not in DO state, syncing',
        { sessionId }
      );
    }

    // Generation check before writing state: if onStop ran while the
    // container RPC was in flight, this init targets a dead container.
    // Fail the attempt so the next caller starts fresh against the new
    // container.
    if (generation !== this.containerGeneration) {
      throw new ContainerUnavailableError({
        code: ErrorCode.CONTAINER_UNAVAILABLE,
        message:
          'Container restarted while the default session was being initialized.',
        context: { reason: 'container_replaced', retryable: true },
        httpStatus: 503,
        timestamp: new Date().toISOString(),
        suggestion:
          'The container restarted while the SDK was preparing the default session. Retry the operation to use the new container.'
      });
    }

    // Durable storage is the cross-eviction source of truth for the default
    // session identity. Update the in-memory cache only after persistence.
    await this.ctx.storage.put('defaultSession', sessionId);
    await this.capturePlacementId(placementId);
    this.defaultSession = sessionId;
    this.logger.debug('Default session initialized', { sessionId });
    return sessionId;
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

  private async resolveExecution(
    explicitSessionId?: string
  ): Promise<SandboxExecutionContext> {
    if (explicitSessionId !== undefined) {
      this.validateExplicitSessionId(explicitSessionId);
      if (explicitSessionId === DISABLE_SESSION_TOKEN) {
        return { kind: 'sessionless' };
      }
      return { kind: 'session', sessionId: explicitSessionId };
    }

    return {
      kind: 'session',
      sessionId: await this.ensureDefaultSession()
    };
  }

  private validateExplicitSessionId(sessionId: string): void {
    if (sessionId.trim().length === 0) {
      throw new Error('sessionId must not be empty or whitespace');
    }
  }

  private serializeExecutionContext(context: SandboxExecutionContext): string {
    if (context.kind === 'sessionless') {
      return DISABLE_SESSION_TOKEN;
    }
    return context.sessionId;
  }

  private getPublicExecutionSessionId(sessionId: string): string | undefined {
    return sessionId === DISABLE_SESSION_TOKEN ? undefined : sessionId;
  }

  /**
   * Resolves the session ID to annotate returned Process objects.
   *
   * Unlike `resolveExecution`, this is synchronous and never creates a
   * session. Top-level process reads are sandbox-scoped, so they only carry a
   * public session annotation when the caller provides an explicit session id.
   * The resolved value is only used to populate `Process.sessionId` on the
   * returned object — it is never sent to the container API.
   */
  private getProcessSessionBinding(
    explicitSessionId?: string
  ): string | undefined {
    if (explicitSessionId === undefined) {
      return undefined;
    }

    this.validateExplicitSessionId(explicitSessionId);
    if (explicitSessionId === DISABLE_SESSION_TOKEN) {
      return undefined;
    }
    return explicitSessionId;
  }

  private resolveExecutionEnv(
    sessionId: string,
    env?: Record<string, string | undefined>
  ): Record<string, string | undefined> | undefined {
    if (sessionId === DISABLE_SESSION_TOKEN) {
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
    sessionId: string,
    options?: {
      timeout?: number;
      env?: Record<string, string | undefined>;
      cwd?: string;
      origin?: 'user' | 'internal';
    }
  ):
    | {
        timeoutMs?: number;
        env?: Record<string, string | undefined>;
        cwd?: string;
        origin?: 'user' | 'internal';
      }
    | undefined {
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

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return this.execWithSession(command, DISABLE_SESSION_TOKEN, options);
  }

  async execWithSessionToken(
    command: string,
    sessionId: string,
    options?: ExecOptions
  ): Promise<ExecResult> {
    this.validateExplicitSessionId(sessionId);
    return this.execWithSession(command, sessionId, options);
  }

  /**
   * Execute an infrastructure command (backup, mount, env setup, etc.)
   * tagged with origin: 'internal' so logging demotes it to debug level.
   */
  private async execInternal(command: string): Promise<ExecResult> {
    const session = await this.ensureDefaultSession();
    return this.execWithSession(command, session, { origin: 'internal' });
  }

  /**
   * Internal session-aware exec implementation
   * Used by both public exec() and session wrappers
   */
  private async execWithSession(
    command: string,
    sessionId: string,
    options?: ExecOptions
  ): Promise<ExecResult> {
    const startTime = Date.now();
    let execOutcome: { exitCode: number; success: boolean } | undefined;
    let execError: Error | undefined;

    try {
      const commandOptions = this.buildExecutionRequestOptions(
        sessionId,
        options
      );

      const response = await this.client.commands.execute(
        command,
        sessionId,
        commandOptions
      );

      const duration = Date.now() - startTime;
      const publicSessionId = this.getPublicExecutionSessionId(sessionId);
      const result = this.mapExecuteResponseToExecResult(
        response,
        duration,
        publicSessionId
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
        sessionId: this.getPublicExecutionSessionId(sessionId),
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
   * Create a Process domain object from HTTP client DTO
   * Centralizes process object creation with bound methods
   * This eliminates duplication across startProcess, listProcesses, getProcess, and session wrappers
   */
  private createProcessFromDTO(
    data: {
      id: string;
      pid?: number;
      command: string;
      status: ProcessStatus;
      startTime: string | Date;
      endTime?: string | Date;
      exitCode?: number;
    },
    sessionId?: string
  ): Process {
    return {
      id: data.id,
      pid: data.pid,
      command: data.command,
      status: data.status,
      startTime:
        typeof data.startTime === 'string'
          ? new Date(data.startTime)
          : data.startTime,
      endTime: data.endTime
        ? typeof data.endTime === 'string'
          ? new Date(data.endTime)
          : data.endTime
        : undefined,
      exitCode: data.exitCode,
      sessionId,

      kill: async (signal?: string) => {
        await this.killProcess(data.id, signal);
      },

      getStatus: async () => {
        const current = await this.getProcess(data.id);
        return current?.status || 'error';
      },

      getLogs: async () => {
        const logs = await this.getProcessLogs(data.id);
        return { stdout: logs.stdout, stderr: logs.stderr };
      },

      waitForLog: async (
        pattern: string | RegExp,
        timeout?: number
      ): Promise<WaitForLogResult> => {
        return this.waitForLogPattern(data.id, data.command, pattern, timeout);
      },

      waitForPort: async (
        port: number,
        options?: WaitForPortOptions
      ): Promise<void> => {
        await this.waitForPortReady(data.id, data.command, port, options);
      },

      waitForExit: async (timeout?: number): Promise<WaitForExitResult> => {
        return this.waitForProcessExit(data.id, data.command, timeout);
      }
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
      const existingLogs = await this.getProcessLogs(processId);
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
    const stream = await this.streamProcessLogs(processId);

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
    const stream = await this.streamProcessLogs(processId);

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

  // Background process management
  async startProcess(
    command: string,
    options?: ProcessOptions,
    sessionId?: string
  ): Promise<Process> {
    // Use the new HttpClient method to start the process
    try {
      const requestedSessionId = sessionId ?? options?.sessionId;
      const execution =
        requestedSessionId === undefined
          ? { kind: 'sessionless' as const }
          : await this.resolveExecution(requestedSessionId);
      const session = this.serializeExecutionContext(execution);
      const processSession = this.getProcessSessionBinding(session);
      const executionOptions = this.buildExecutionRequestOptions(session, {
        timeout: options?.timeout,
        env: options?.env,
        cwd: options?.cwd
      });
      const requestOptions = {
        ...executionOptions,
        ...(options?.processId !== undefined && {
          processId: options.processId
        }),
        ...(options?.encoding !== undefined && { encoding: options.encoding }),
        ...(options?.autoCleanup !== undefined && {
          autoCleanup: options.autoCleanup
        })
      };

      const response = await this.client.processes.startProcess(
        command,
        session,
        requestOptions
      );

      const processObj = this.createProcessFromDTO(
        {
          id: response.processId,
          pid: response.pid,
          command: response.command,
          status: 'running' as ProcessStatus,
          startTime: new Date(),
          endTime: undefined,
          exitCode: undefined
        },
        processSession
      );

      // Call onStart callback if provided
      if (options?.onStart) {
        options.onStart(processObj);
      }

      // Start background streaming if output/exit callbacks are provided
      if (options?.onOutput || options?.onExit) {
        // Fire and forget - don't await, let it run in background
        this.startProcessCallbackStream(response.processId, options).catch(
          () => {
            // Error already handled in startProcessCallbackStream
          }
        );
      }

      return processObj;
    } catch (error) {
      if (options?.onError && error instanceof Error) {
        options.onError(error);
      }

      throw error;
    }
  }

  /**
   * Start background streaming for process callbacks
   * Opens SSE stream to container and routes events to callbacks
   */
  private async startProcessCallbackStream(
    processId: string,
    options: ProcessOptions
  ): Promise<void> {
    try {
      const stream = await this.client.processes.streamProcessLogs(processId);

      for await (const event of parseSSEStream<{
        type: string;
        data?: string;
        exitCode?: number;
        processId?: string;
      }>(stream)) {
        switch (event.type) {
          case 'stdout':
            if (event.data && options.onOutput) {
              options.onOutput('stdout', event.data);
            }
            break;
          case 'stderr':
            if (event.data && options.onOutput) {
              options.onOutput('stderr', event.data);
            }
            break;
          case 'exit':
          case 'complete':
            if (options.onExit) {
              options.onExit(event.exitCode ?? null);
            }
            return; // Stream complete
        }
      }

      // If we get here without a complete event, something went wrong
      throw new Error('Stream ended without completion event');
    } catch (error) {
      // Call onError if streaming fails
      if (options.onError && error instanceof Error) {
        options.onError(error);
      }
      // Don't rethrow - background streaming failure shouldn't crash the caller
      this.logger.error(
        'Background process streaming failed',
        error instanceof Error ? error : new Error(String(error)),
        { processId }
      );
    }
  }

  async listProcesses(sessionId?: string): Promise<Process[]> {
    const session = this.getProcessSessionBinding(sessionId);
    const response = await this.client.processes.listProcesses();

    return response.processes.map((processData) =>
      this.createProcessFromDTO(
        {
          id: processData.id,
          pid: processData.pid,
          command: processData.command,
          status: processData.status,
          startTime: processData.startTime,
          endTime: processData.endTime,
          exitCode: processData.exitCode
        },
        session
      )
    );
  }

  async getProcess(id: string, sessionId?: string): Promise<Process | null> {
    const session = this.getProcessSessionBinding(sessionId);
    try {
      const response = await this.client.processes.getProcess(id);

      if (!response.process) {
        return null;
      }

      const processData = response.process;
      return this.createProcessFromDTO(
        {
          id: processData.id,
          pid: processData.pid,
          command: processData.command,
          status: processData.status,
          startTime: processData.startTime,
          endTime: processData.endTime,
          exitCode: processData.exitCode
        },
        session
      );
    } catch (error) {
      if (error instanceof ProcessNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  async killProcess(
    id: string,
    signal?: string,
    sessionId?: string
  ): Promise<void> {
    // Note: signal parameter is not currently supported by process control.
    // sessionId is intentionally unused — kill targets a process by ID which
    // is sandbox-scoped, not session-scoped.
    await this.client.processes.killProcess(id);
  }

  async killAllProcesses(sessionId?: string): Promise<number> {
    // sessionId is intentionally unused — the kill-all operation is
    // sandbox-scoped and affects all processes regardless of session.
    const response = await this.client.processes.killAllProcesses();
    return response.cleanedCount;
  }

  async cleanupCompletedProcesses(sessionId?: string): Promise<number> {
    // sessionId is intentionally unused — cleanup is sandbox-scoped.
    // Not yet implemented - requires container endpoint
    return 0;
  }

  async getProcessLogs(
    id: string,
    sessionId?: string
  ): Promise<{ stdout: string; stderr: string; processId: string }> {
    const response = await this.client.processes.getProcessLogs(id);
    return {
      stdout: response.stdout,
      stderr: response.stderr,
      processId: response.processId
    };
  }

  /**
   * Stream logs from a background process as a ReadableStream.
   */
  async streamProcessLogs(
    processId: string,
    options?: { signal?: AbortSignal }
  ): Promise<ReadableStream<Uint8Array>> {
    // Check for cancellation
    if (options?.signal?.aborted) {
      throw new Error('Operation was aborted');
    }

    return this.client.processes.streamProcessLogs(processId);
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
    const execution = await this.resolveExecution(options?.sessionId);
    const session = this.serializeExecutionContext(execution);
    return this.client.git.checkout(repoUrl, session, {
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
    const execution = await this.resolveExecution(options.sessionId);
    const session = this.serializeExecutionContext(execution);
    return this.client.files.mkdir(path, session, {
      recursive: options.recursive
    });
  }

  async writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options: { encoding?: string; sessionId?: string } = {}
  ) {
    const execution = await this.resolveExecution(options.sessionId);
    const session = this.serializeExecutionContext(execution);

    if (content instanceof ReadableStream) {
      return this.client.files.writeFileStream(path, content, session);
    }

    return this.client.files.writeFile(path, content, session, {
      encoding: options.encoding
    });
  }

  async deleteFile(path: string, sessionId?: string) {
    const execution = await this.resolveExecution(sessionId);
    const session = this.serializeExecutionContext(execution);
    return this.client.files.deleteFile(path, session);
  }

  async renameFile(oldPath: string, newPath: string, sessionId?: string) {
    const execution = await this.resolveExecution(sessionId);
    const session = this.serializeExecutionContext(execution);
    return this.client.files.renameFile(oldPath, newPath, session);
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string,
    sessionId?: string
  ) {
    const execution = await this.resolveExecution(sessionId);
    const session = this.serializeExecutionContext(execution);
    return this.client.files.moveFile(sourcePath, destinationPath, session);
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
    const execution = await this.resolveExecution(options.sessionId);
    const session = this.serializeExecutionContext(execution);
    if (options.encoding === 'none') {
      return this.client.files.readFile(path, session, { encoding: 'none' });
    }
    return this.client.files.readFile(path, session, {
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
    const execution = await this.resolveExecution(options.sessionId);
    const session = this.serializeExecutionContext(execution);
    return this.client.files.readFileStream(path, session);
  }

  async listFiles(path: string, options?: ListFilesOptions) {
    const context = await this.resolveExecution(options?.sessionId);
    const session = this.serializeExecutionContext(context);
    return this.client.files.listFiles(path, session, options);
  }

  async exists(path: string, sessionId?: string) {
    const execution = await this.resolveExecution(sessionId);
    const session = this.serializeExecutionContext(execution);
    return this.client.files.exists(path, session);
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
    const execution = await this.resolveExecution(options.sessionId);
    const sessionId = this.serializeExecutionContext(execution);
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
    const execution = await this.resolveExecution(options.sessionId);
    const sessionId = this.serializeExecutionContext(execution);
    return this.client.watch.checkChanges({
      path,
      recursive: options.recursive,
      include: options.include,
      exclude: options.exclude,
      since: options.since,
      sessionId
    });
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
    const exposeStartTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    try {
      if (!validatePort(port)) {
        throw new SandboxSecurityError(
          `Invalid port number: ${port}. Must be 1024-65535, excluding 3000 (sandbox control plane).`
        );
      }

      // Check if hostname is workers.dev domain (doesn't support wildcard subdomains)
      if (options.hostname.endsWith('.workers.dev')) {
        const errorResponse: ErrorResponse = {
          code: ErrorCode.CUSTOM_DOMAIN_REQUIRED,
          message: `Port exposure requires a custom domain. .workers.dev domains do not support wildcard subdomains required for port proxying.`,
          context: { originalError: options.hostname },
          httpStatus: 400,
          timestamp: new Date().toISOString()
        };
        throw new CustomDomainRequiredError(errorResponse);
      }

      // We need the sandbox name to construct preview URLs
      if (!this.sandboxName) {
        throw new Error(
          'Sandbox name not available. Ensure sandbox is accessed through getSandbox()'
        );
      }

      if (options.token !== undefined) {
        this.validateCustomToken(options.token);
      }

      await this.ensureDefaultSession();

      // onStart() may record runtime identity while ensureDefaultSession()
      // starts the container. Re-read before falling back to markStarted() so
      // normal start hooks remain the identity source.
      let runtime = await this.currentRuntime.get();
      runtime = runtime ?? (await this.currentRuntime.markStarted());
      await this.currentRuntime.assertActive(runtime);

      const token = await this.ctx.storage.transaction(async (txn) => {
        const tokens = await this.readPortTokens(txn);
        const existingEntry = tokens[port.toString()];
        const nextToken =
          options.token ?? existingEntry?.token ?? this.generatePortToken();

        // Allow re-exposing same port with same token, but reject if another port uses this token
        const existingPort = Object.entries(tokens).find(
          ([p, entry]) => entry.token === nextToken && p !== port.toString()
        );
        if (existingPort) {
          throw new SandboxSecurityError(
            `Token '${nextToken}' is already in use by port ${existingPort[0]}. Please use a different token.`
          );
        }

        const activations = await this.readActivePreviewPorts(txn);

        tokens[port.toString()] = { token: nextToken, name: options.name };
        activations[port.toString()] = runtime.scope({ token: nextToken });
        await Promise.all([
          txn.put(PORT_TOKENS_STORAGE_KEY, tokens),
          this.writeActivePreviewPorts(activations, txn)
        ]);

        return nextToken;
      });

      // If a concurrent lifecycle hook records a newer runtime identity after
      // the storage writes, fail instead of returning a URL that is stale on
      // arrival. The stale activation remains harmless because preview
      // forwarding requires ownership by the current runtime identity.
      await this.currentRuntime.assertActive(runtime);

      const url = this.constructPreviewUrl(
        port,
        this.sandboxName,
        options.hostname,
        token
      );

      outcome = 'success';

      return {
        url,
        port,
        name: options.name
      };
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'port.expose',
        outcome,
        port,
        durationMs: Date.now() - exposeStartTime,
        name: options.name,
        hostname: options.hostname,
        error: caughtError
      });
    }
  }

  /**
   * Revoke preview URL authorization and current-runtime activation for a port.
   *
   * Revocation is idempotent: calling this for a port with no preview state is
   * still successful. The operation clears Durable Object-owned preview state
   * only and does not contact, probe, wake, or clean up the container runtime.
   */
  async unexposePort(port: number) {
    const unexposeStartTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    try {
      if (!validatePort(port)) {
        throw new SandboxSecurityError(
          `Invalid port number: ${port}. Must be 1024-65535, excluding 3000 (sandbox control plane).`
        );
      }

      // Storage is the source of truth for preview-URL auth and activation.
      // Clearing DO-owned state is sufficient to revoke forwarding and does
      // not need to contact the container runtime.
      await this.ctx.storage.transaction(async (txn) => {
        const tokens = await this.readPortTokens(txn);
        if (tokens[port.toString()]) {
          delete tokens[port.toString()];
          await txn.put(PORT_TOKENS_STORAGE_KEY, tokens);
        }

        const activations = await this.readActivePreviewPorts(txn);
        if (activations[port.toString()]) {
          delete activations[port.toString()];
          await this.writeActivePreviewPorts(activations, txn);
        }
      });

      outcome = 'success';
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'port.unexpose',
        outcome,
        port,
        durationMs: Date.now() - unexposeStartTime,
        error: caughtError
      });
    }
  }

  /**
   * Returns preview URLs that are currently forwardable in the active runtime.
   * Durable authorization without current-runtime activation is omitted.
   */
  async getExposedPorts(hostname: string) {
    // We need the sandbox name to construct preview URLs
    if (!this.sandboxName) {
      throw new Error(
        'Sandbox name not available. Ensure sandbox is accessed through getSandbox()'
      );
    }

    const activePorts = await this.getCurrentPreviewPorts();
    return activePorts.map(({ port, entry }) => ({
      url: this.constructPreviewUrl(
        port,
        this.sandboxName!,
        hostname,
        entry.token
      ),
      port,
      status: 'active' as const
    }));
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

  /**
   * Returns whether a port is currently preview-forwardable.
   * This checks Durable Object-owned auth and runtime activation without
   * contacting or waking the container.
   */
  async isPortExposed(port: number): Promise<boolean> {
    if (!validatePort(port)) {
      return false;
    }

    const activePorts = await this.getCurrentPreviewPorts();
    return activePorts.some((activePort) => activePort.port === port);
  }

  /**
   * Checks durable preview URL authorization for a port/token pair.
   *
   * This does not check whether the port is activated for the current runtime
   * and is not sufficient to decide whether preview traffic may forward.
   */
  async validatePortToken(port: number, token: string): Promise<boolean> {
    const tokens = await this.readPortTokens();
    const entry = tokens[port.toString()];
    if (!entry) {
      return false;
    }

    return this.previewTokensMatch(entry.token, token);
  }

  private async validatePreviewURLForRuntime(
    port: number,
    token: string
  ): Promise<PreviewURLRuntimeValidation> {
    const containerState = await this.getState();
    const containerRunning = this.ctx.container?.running === true;
    const { tokens, activations, runtime } = await this.ctx.storage.transaction(
      async (txn) => {
        const [previewState, runtime] = await Promise.all([
          this.readPreviewState(txn),
          this.currentRuntime.getStored(txn)
        ]);
        return { ...previewState, runtime };
      }
    );

    const entry = tokens[port.toString()];
    if (!entry) {
      return { status: 'invalid' };
    }

    const tokenMatches = this.previewTokensMatch(entry.token, token);
    if (!tokenMatches) {
      return { status: 'invalid' };
    }

    if (containerState.status !== 'healthy') {
      return {
        status: 'stale',
        reason: 'runtime-not-healthy',
        containerStatus: containerState.status
      };
    }

    if (!containerRunning) {
      return {
        status: 'stale',
        reason: 'runtime-not-running',
        containerStatus: containerState.status
      };
    }

    if (!runtime) {
      return {
        status: 'stale',
        reason: 'missing-runtime-id',
        containerStatus: containerState.status
      };
    }

    const activation = activations[port.toString()];
    if (!activation) {
      return {
        status: 'stale',
        reason: 'missing-activation',
        containerStatus: containerState.status
      };
    }

    if (!runtime.owns(activation)) {
      return {
        status: 'stale',
        reason: 'runtime-mismatch',
        containerStatus: containerState.status
      };
    }

    const activationTokenMatches = this.previewTokensMatch(
      activation.token,
      token
    );
    if (!activationTokenMatches) {
      this.logger.warn('Preview URL activation token mismatch', {
        port,
        runtimeIdentityID: runtime.id
      });
      return {
        status: 'stale',
        reason: 'token-mismatch',
        containerStatus: containerState.status
      };
    }

    return { status: 'active', runtime };
  }

  private async getCurrentPreviewPorts(): Promise<CurrentPreviewPort[]> {
    const containerState = await this.getState();
    const containerRunning = this.ctx.container?.running === true;
    const { tokens, activations, runtime } = await this.ctx.storage.transaction(
      async (txn) => {
        const [previewState, runtime] = await Promise.all([
          this.readPreviewState(txn),
          this.currentRuntime.getStored(txn)
        ]);
        return { ...previewState, runtime };
      }
    );

    if (containerState.status !== 'healthy' || !containerRunning || !runtime) {
      return [];
    }

    const activePorts: CurrentPreviewPort[] = [];

    for (const [portKey, activation] of Object.entries(activations)) {
      const port = Number.parseInt(portKey, 10);
      const entry = tokens[portKey];
      if (!entry || !Number.isInteger(port) || !validatePort(port)) {
        continue;
      }

      if (!runtime.owns(activation)) {
        continue;
      }

      if (!this.previewTokensMatch(entry.token, activation.token)) {
        continue;
      }

      activePorts.push({ port, entry });
    }

    return activePorts.sort((a, b) => a.port - b.port);
  }

  private previewTokensMatch(expected: string, actual: string): boolean {
    const encoder = new TextEncoder();
    const a = encoder.encode(expected);
    const b = encoder.encode(actual);

    try {
      // Workers runtime extends SubtleCrypto with timingSafeEqual.
      return (
        crypto.subtle as SubtleCrypto & {
          timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
        }
      ).timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  private validateCustomToken(token: string): void {
    if (token.length === 0) {
      throw new SandboxSecurityError(`Custom token cannot be empty.`);
    }

    if (token.length > 16) {
      throw new SandboxSecurityError(
        `Custom token too long. Maximum 16 characters allowed. Received: ${token.length} characters.`
      );
    }

    if (!/^[a-z0-9_]+$/.test(token)) {
      throw new SandboxSecurityError(
        `Custom token must contain only lowercase letters (a-z), numbers (0-9), and underscores (_). Invalid token provided.`
      );
    }
  }

  private generatePortToken(): string {
    // Generate cryptographically secure 16-character token using Web Crypto API
    // Available in Cloudflare Workers runtime
    const array = new Uint8Array(12); // 12 bytes = 16 base64url chars (after padding removal)
    crypto.getRandomValues(array);

    const base64 = btoa(String.fromCharCode(...array));
    return base64
      .replace(/\+/g, '_')
      .replace(/\//g, '_')
      .replace(/=/g, '')
      .toLowerCase();
  }

  private constructPreviewUrl(
    port: number,
    sandboxId: string,
    hostname: string,
    token: string
  ): string {
    if (!validatePort(port)) {
      throw new SandboxSecurityError(
        `Invalid port number: ${port}. Must be 1024-65535, excluding 3000 (sandbox control plane).`
      );
    }

    // Hostnames are case-insensitive, routing requests to wrong DO instance when keys contain uppercase letters
    const effectiveId = this.sandboxName || sandboxId;
    const hasUppercase = /[A-Z]/.test(effectiveId);
    if (!this.normalizeId && hasUppercase) {
      throw new SandboxSecurityError(
        `Preview URLs require lowercase sandbox IDs. Your ID "${effectiveId}" contains uppercase letters.\n\n` +
          `To fix this:\n` +
          `1. Create a new sandbox with: getSandbox(ns, "${effectiveId}", { normalizeId: true })\n` +
          `2. This will create a sandbox with ID: "${effectiveId.toLowerCase()}"\n\n` +
          `Note: Due to DNS case-insensitivity, IDs with uppercase letters cannot be used with preview URLs.`
      );
    }

    const sanitizedSandboxId = sanitizeSandboxId(sandboxId).toLowerCase();

    const isLocalhost = isLocalhostPattern(hostname);

    if (isLocalhost) {
      const [host, portStr] = hostname.split(':');
      const mainPort = portStr || '80';

      try {
        const baseUrl = new URL(`http://${host}:${mainPort}`);
        const subdomainHost = `${port}-${sanitizedSandboxId}-${token}.${host}`;
        baseUrl.hostname = subdomainHost;

        return baseUrl.toString();
      } catch (error) {
        throw new SandboxSecurityError(
          `Failed to construct preview URL: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        );
      }
    }

    try {
      const baseUrl = new URL(`https://${hostname}`);
      const subdomainHost = `${port}-${sanitizedSandboxId}-${token}.${hostname}`;
      baseUrl.hostname = subdomainHost;

      return baseUrl.toString();
    } catch (error) {
      throw new SandboxSecurityError(
        `Failed to construct preview URL: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
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
    if (sessionId === DISABLE_SESSION_TOKEN) {
      throw new Error(
        `Session ID '${DISABLE_SESSION_TOKEN}' is reserved for internal use`
      );
    }

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
   * Delete an execution session
   * Cleans up session resources and removes it from the container
   * Note: Cannot delete the default session. To reset the default session,
   * use sandbox.destroy() to terminate the entire sandbox.
   *
   * @param sessionId - The ID of the session to delete
   * @returns Result with success status, sessionId, and timestamp
   * @throws Error if attempting to delete the default session
   */
  async deleteSession(sessionId: string): Promise<SessionDeleteResult> {
    // Prevent deletion of default session
    if (this.defaultSession && sessionId === this.defaultSession) {
      throw new Error(
        `Cannot delete default session '${sessionId}'. Use sandbox.destroy() to terminate the sandbox.`
      );
    }

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
   * Returns `undefined` when no handshake has been observed yet on this
   * sandbox. Call any method that triggers session creation (such as
   * `exec()`) to populate the value.
   */
  async getContainerPlacementId(): Promise<string | null | undefined> {
    return this.ctx.storage.get<string | null>('containerPlacementId');
  }

  private getSessionWrapper(sessionId: string): ExecutionSession {
    return {
      id: sessionId,

      exec: (command, options) =>
        this.execWithSession(command, sessionId, options),

      // Process management
      startProcess: (command, options) =>
        this.startProcess(command, options, sessionId),
      listProcesses: () => this.listProcesses(sessionId),
      getProcess: (id) => this.getProcess(id, sessionId),
      killProcess: (id, signal) => this.killProcess(id, signal),
      killAllProcesses: () => this.killAllProcesses(),
      cleanupCompletedProcesses: () => this.cleanupCompletedProcesses(),
      getProcessLogs: (id) => this.getProcessLogs(id),
      streamProcessLogs: (processId, options) =>
        this.streamProcessLogs(processId, options),

      // File operations - pass sessionId via options or parameter
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
      deleteFile: (path) => this.deleteFile(path, sessionId),
      renameFile: (oldPath, newPath) =>
        this.renameFile(oldPath, newPath, sessionId),
      moveFile: (sourcePath, destPath) =>
        this.moveFile(sourcePath, destPath, sessionId),
      listFiles: (path, options) =>
        this.client.files.listFiles(path, sessionId, options),
      exists: (path) => this.exists(path, sessionId),

      // Git operations
      gitCheckout: (repoUrl, options) =>
        this.gitCheckout(repoUrl, { ...options, sessionId }),

      setEnvVars: async (envVars: Record<string, string | undefined>) => {
        const { toSet, toUnset } = partitionEnvVars(envVars);

        try {
          for (const key of toUnset) {
            const unsetCommand = `unset ${key}`;

            const result = await this.client.commands.execute(
              unsetCommand,
              sessionId,
              { origin: 'internal' }
            );

            if (result.exitCode !== 0) {
              throw new Error(
                `Failed to unset ${key}: ${result.stderr || 'Unknown error'}`
              );
            }
          }

          for (const [key, value] of Object.entries(toSet)) {
            const exportCommand = `export ${key}=${shellEscape(value)}`;

            const result = await this.client.commands.execute(
              exportCommand,
              sessionId,
              { origin: 'internal' }
            );

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
