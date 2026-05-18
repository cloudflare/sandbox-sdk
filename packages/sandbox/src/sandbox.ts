import { Container, getContainer, switchPort } from '@cloudflare/containers';
import type {
  BackupOptions,
  BucketCredentials,
  BucketProvider,
  CheckChangesOptions,
  CheckChangesResult,
  CodeContext,
  CreateContextOptions,
  DirectoryBackup,
  ExecEvent,
  ExecOptions,
  ExecResult,
  ExecutionResult,
  ExecutionSession,
  FileEncoding,
  ISandbox,
  LocalMountBucketOptions,
  LogEvent,
  MountBucketOptions,
  PortWatchEvent,
  Process,
  ProcessOptions,
  ProcessStatus,
  PtyOptions,
  R2BindingMountBucketOptions,
  ReadFileResult,
  ReadFileStreamResult,
  RemoteMountBucketOptions,
  RestoreBackupResult,
  RunCodeOptions,
  SandboxOptions,
  SandboxTransport,
  SessionOptions,
  StreamOptions,
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
  BACKUP_ALLOWED_PREFIXES,
  normalizeBackupExcludePattern
} from '@repo/shared/backup';
import { AwsClient } from 'aws4fetch';
import { type Desktop, type ExecuteResponse, SandboxClient } from './clients';
import { ContainerControlClient } from './container-control';
import type { ErrorResponse } from './errors';
import {
  BackupCreateError,
  BackupExpiredError,
  BackupNotFoundError,
  BackupRestoreError,
  CustomDomainRequiredError,
  ErrorCode,
  InvalidBackupConfigError,
  PortNotExposedError,
  ProcessExitedBeforeReadyError,
  ProcessNotFoundError,
  ProcessReadyTimeoutError,
  SandboxError,
  SessionAlreadyExistsError
} from './errors';
import { collectFile, streamFile } from './file-stream';
import { CodeInterpreter } from './interpreter';
import { LocalMountSyncManager } from './local-mount-sync';
import { proxyTerminal } from './pty';
import { isLocalhostPattern } from './request-handler';
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
import type {
  FuseMountInfo,
  LocalSyncMountInfo,
  MountInfo,
  R2BindingMountInfo
} from './storage-mount/types';
import { SandboxControlCallbackImpl } from './tunnels/sandbox-control-callback';
import {
  createTunnelsHandler,
  type TunnelExitHandler,
  type TunnelsHandler
} from './tunnels/tunnels-handler';
import { SDK_VERSION } from './version';

/**
 * Persisted record for a single exposed port. `token` authorizes preview
 * URL requests; `name` is the optional friendly name the caller passed to
 * `exposePort()` and is preserved across container restarts.
 */
type PortTokenEntry = {
  token: string;
  name?: string;
};

type SandboxConfiguration = {
  sandboxName?: {
    name: string;
    normalizeId?: boolean;
  };
  sleepAfter?: string | number;
  keepAlive?: boolean;
  enableDefaultSession?: boolean;
  containerTimeouts?: NonNullable<SandboxOptions['containerTimeouts']>;
  transport?: SandboxTransport;
};

type CachedSandboxConfiguration = {
  sandboxName?: string;
  normalizeId?: boolean;
  sleepAfter?: string | number;
  keepAlive?: boolean;
  enableDefaultSession?: boolean;
  containerTimeouts?: NonNullable<SandboxOptions['containerTimeouts']>;
  transport?: SandboxTransport;
};

type R2EgressContainerState = DurableObjectState<{}> & {
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
            params: R2EgressParams;
          }
        >;
      };
    }) => Fetcher;
  };
  container?: {
    interceptOutboundHttp(host: string, fetcher: Fetcher): Promise<void>;
  };
};

const R2_EGRESS_PROXY_TARGET_CLASS_NAME =
  'CloudflareSandboxR2EgressProxyTarget';

class R2EgressProxyTarget extends Container {}

Object.defineProperty(R2EgressProxyTarget, 'name', {
  value: R2_EGRESS_PROXY_TARGET_CLASS_NAME
});

R2EgressProxyTarget.outboundHandlers = { r2EgressMount: r2EgressHandler };

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
  setEnableDefaultSession?: (enableDefaultSession: boolean) => Promise<void>;
  setContainerTimeouts?: (
    timeouts: NonNullable<SandboxOptions['containerTimeouts']>
  ) => Promise<void>;
  setTransport?: (transport: SandboxTransport) => Promise<void>;
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
const SESSIONLESS_SESSION_ID = 'none';

/**
 * Calculate the optimal number of parts for multipart upload/download
 * based on archive size. Larger archives benefit from more parallelism.
 */
function calculatePartCount(
  sizeBytes: number,
  defaultParts: number,
  maxParts: number
): number {
  if (sizeBytes < 100 * 1024 * 1024) {
    // < 100 MiB: use default parts
    return defaultParts;
  }
  if (sizeBytes < 1024 * 1024 * 1024) {
    // 100 MiB - 1 GiB: scale up to 32 parts
    return Math.min(32, defaultParts * 2);
  }
  // >= 1 GiB: use max parts (64)
  return maxParts;
}

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
    options?.enableDefaultSession !== undefined &&
    cached?.enableDefaultSession !== options.enableDefaultSession
  ) {
    configuration.enableDefaultSession = options.enableDefaultSession;
  }

  if (
    options?.containerTimeouts &&
    !sameContainerTimeouts(cached?.containerTimeouts, options.containerTimeouts)
  ) {
    configuration.containerTimeouts = options.containerTimeouts;
  }

  if (
    options?.transport !== undefined &&
    cached?.transport !== options.transport
  ) {
    configuration.transport = options.transport;
  }

  return configuration;
}

function hasSandboxConfiguration(configuration: SandboxConfiguration): boolean {
  return (
    configuration.sandboxName !== undefined ||
    configuration.sleepAfter !== undefined ||
    configuration.keepAlive !== undefined ||
    configuration.enableDefaultSession !== undefined ||
    configuration.containerTimeouts !== undefined ||
    configuration.transport !== undefined
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
    ...(configuration.enableDefaultSession !== undefined && {
      enableDefaultSession: configuration.enableDefaultSession
    }),
    ...(configuration.containerTimeouts !== undefined && {
      containerTimeouts: configuration.containerTimeouts
    }),
    ...(configuration.transport !== undefined && {
      transport: configuration.transport
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

  if (configuration.enableDefaultSession !== undefined) {
    operations.push(
      stub.setEnableDefaultSession?.(configuration.enableDefaultSession) ??
        Promise.resolve()
    );
  }

  if (configuration.containerTimeouts !== undefined) {
    operations.push(
      stub.setContainerTimeouts?.(configuration.containerTimeouts) ??
        Promise.resolve()
    );
  }

  if (configuration.transport !== undefined) {
    operations.push(
      stub.setTransport?.(configuration.transport) ?? Promise.resolve()
    );
  }

  return Promise.all(operations).then(() => undefined);
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
  ) as unknown as T & ConfigurableSandboxStub;

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

  const defaultSessionId = `sandbox-${effectiveId}`;

  // IMPORTANT: Any method that returns ExecutionSession must be listed here
  // to ensure the returned session uses proxyTerminal instead of RPC's terminal.
  const enhancedMethods = {
    fetch: (request: Request) => stub.fetch(request),
    createSession: async (opts?: SessionOptions): Promise<ExecutionSession> => {
      const rpcSession = await stub.createSession(opts);
      return enhanceSession(stub, rpcSession as ExecutionSession);
    },
    getSession: async (sessionId: string): Promise<ExecutionSession> => {
      const rpcSession = await stub.getSession(sessionId);
      return enhanceSession(stub, rpcSession as ExecutionSession);
    },
    terminal: (request: Request, opts?: PtyOptions) =>
      proxyTerminal(stub, defaultSessionId, request, opts),
    wsConnect: connect(stub),
    // Client-side proxy for desktop operations. Each method call is dispatched
    // to the DO's callDesktop() method, avoiding RPC pipelining through getters
    // which are broken when using the vite-plugin.
    desktop: new Proxy({} as Desktop, {
      get(_, method) {
        if (typeof method !== 'string' || method === 'then') return undefined;
        return (...args: unknown[]) => stub.callDesktop(method, args);
      }
    }),
    tunnels: new Proxy({} as TunnelsHandler, {
      get: (_, method) => {
        if (typeof method !== 'string' || method === 'then') return undefined;
        return (...args: unknown[]) => stub.callTunnels(method, args);
      }
    })
  };

  // Proxy intercepts enhanced methods, passes all others to stub directly.
  // We must access target[prop] directly (not via Reflect.get with receiver)
  // to preserve the RPC stub's internal Proxy handling.
  return new Proxy(stub, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in enhancedMethods) {
        return enhancedMethods[prop as keyof typeof enhancedMethods];
      }
      // @ts-expect-error - RPC stub methods are Proxy-trapped, not visible to TypeScript
      return target[prop];
    }
  }) as T;
}

function enhanceSession(
  stub: { fetch: (request: Request) => Promise<Response> },
  rpcSession: ExecutionSession
): ExecutionSession {
  return {
    ...rpcSession,
    terminal: (request: Request, opts?: PtyOptions) =>
      proxyTerminal(stub, rpcSession.id, request, opts)
  };
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

  client: SandboxClient | ContainerControlClient;

  private codeInterpreter: CodeInterpreter;
  private sandboxName: string | null = null;
  // Tunnels namespace handler. Lazily constructed on first access via the
  // `tunnels` getter; holds an in-memory map of tunnels created through
  // this Sandbox instance. The sibling `tunnelExitHandler` is the
  // control-plane exit hook invoked by the capnweb session's
  // SandboxControlCallback when the container reports cloudflared has
  // died; both fields are reset together on transport swap.
  private tunnelsHandler: TunnelsHandler | null = null;
  private tunnelExitHandler: TunnelExitHandler | null = null;
  // capnweb localMain exposed to the container side of the RPC
  // session. Constructed once in the constructor (the lazy accessor
  // keeps it pointing at the current `tunnelExitHandler` even as
  // transports swap), so the container can call back into the DO
  // without us re-binding the session.
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
  private enableDefaultSession: boolean = true;
  private activeMounts: Map<string, MountInfo> = new Map();
  private transport: SandboxTransport = 'http';
  private hasStoredEnableDefaultSession = false;

  /**
   * True once transport has been written to storage at least once (either
   * via setTransport or restored on cold start). Gates the idempotency
   * check so a first explicit call persists even when the requested value
   * already equals the env-derived in-memory default.
   */
  private hasStoredTransport = false;

  // R2 bucket binding for backup storage (optional — only set if user configures BACKUP_BUCKET)
  private backupBucket: R2Bucket | null = null;
  /**
   * Serializes backup operations to prevent concurrent create/restore on the same sandbox.
   *
   * This is in-memory state — it resets if the Durable Object is evicted and
   * re-instantiated (e.g. after sleep). This is acceptable because the container
   * filesystem is also lost on eviction, so there is no archive to race on.
   */
  private backupInProgress: Promise<unknown> = Promise.resolve();

  /**
   * R2 presigned URL credentials for direct container-to-R2 transfers.
   * All four fields plus the R2 binding must be configured for backup to work.
   */
  private r2AccessKeyId: string | null = null;
  private r2SecretAccessKey: string | null = null;
  private r2AccountId: string | null = null;
  private backupBucketName: string | null = null;
  private r2Client: AwsClient | null = null;

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
   * Desktop environment operations.
   * Within the DO, this getter provides direct access to DesktopClient.
   * Over RPC, the getSandbox() proxy intercepts this property and routes
   * calls through callDesktop() instead.
   */
  get desktop(): Desktop {
    return this.client.desktop as unknown as Desktop;
  }

  /**
   * Allowed desktop methods — derived from the Desktop interface.
   * Restricts callDesktop() to a known set of operations.
   */
  private static readonly DESKTOP_METHODS = new Set([
    'start',
    'stop',
    'status',
    'screenshot',
    'screenshotRegion',
    'click',
    'doubleClick',
    'tripleClick',
    'rightClick',
    'middleClick',
    'mouseDown',
    'mouseUp',
    'moveMouse',
    'drag',
    'scroll',
    'getCursorPosition',
    'type',
    'press',
    'keyDown',
    'keyUp',
    'getScreenSize',
    'getProcessStatus'
  ]);

  /**
   * Dispatch method for desktop operations.
   * Called by the client-side proxy created in getSandbox() to provide
   * the `sandbox.desktop.status()` API without relying on RPC pipelining
   * through property getters which is broken when using vite-plugin.
   */
  async callDesktop(method: string, args: unknown[]): Promise<unknown> {
    if (!Sandbox.DESKTOP_METHODS.has(method)) {
      throw new Error(`Unknown desktop method: ${method}`);
    }
    const client = this.client.desktop;
    const fn = client[method as keyof typeof client];
    if (typeof fn !== 'function') {
      throw new Error(`sandbox.desktop missing method: ${method}`);
    }
    return (fn as (...a: unknown[]) => unknown).apply(client, args);
  }

  /**
   * Dispatch method for tunnel operations.
   * Called by the client-side proxy created in getSandbox() to provide
   * the `sandbox.tunnels` API without relying on RPC pipelining
   * through property getters which is broken when using vite-plugin.
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

  /**
   * Compute the transport retry budget from current container timeouts.
   *
   * The budget covers the full container startup window (instance provisioning
   * + port readiness) plus a 30s margin for the maximum single backoff delay
   * (capped at 30s in BaseTransport). The 120s floor preserves the previous
   * default for short timeout configurations.
   */
  private computeRetryTimeoutMs(): number {
    const startupBudgetMs =
      this.containerTimeouts.instanceGetTimeoutMS +
      this.containerTimeouts.portReadyTimeoutMS;
    return Math.max(120_000, startupBudgetMs + 30_000);
  }

  /**
   * Create the route-based compatibility client with current HTTP/WebSocket
   * transport settings.
   */
  private createSandboxClient(): SandboxClient {
    return new SandboxClient({
      logger: this.logger,
      port: 3000,
      stub: this,
      retryTimeoutMs: this.computeRetryTimeoutMs(),
      defaultHeaders: {
        'X-Sandbox-Id': this.ctx.id.toString()
      },
      ...(this.transport === 'websocket' && {
        transportMode: 'websocket' as const,
        wsUrl: 'ws://localhost:3000/ws'
      })
    });
  }

  /**
   * Create the appropriate client for the configured control path.
   *
   * `rpc` currently selects the primary container-control client. `http` and
   * `websocket` select the route-based compatibility client.
   */
  private createClientForTransport(
    transport: SandboxTransport
  ): SandboxClient | ContainerControlClient {
    if (transport === 'rpc') {
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
        // Mirrors containerFetch()'s request lifecycle for the RPC transport.
        //
        // The HTTP transport bumps inflightRequests at the top of each
        // containerFetch() call and decrements in `finally`. The RPC
        // transport multiplexes all work over a single capnweb WebSocket,
        // so we can't bracket per-request — and a method that returns a
        // ReadableStream resolves its promise long before the stream is
        // actually drained. Instead, ContainerControlClient polls capnweb's
        // session stats and reports busy/idle *transitions* of the whole
        // session. We treat one transition as equivalent to one in-flight
        // request: increment on busy, decrement on idle. See the
        // file-level comment in container-control/client.ts for details.
        onActivity: () => {
          // Called at the start of each RPC call AND on every busy-poll
          // tick while the session has work in flight. Equivalent to
          // the top of containerFetch(): push the sleepAfter deadline
          // forward.
          this.renewActivityTimeout();
        },
        onSessionBusy: () => {
          // Idle → busy: a new RPC call started or a stream return is
          // now in flight. Mark the DO busy so isActivityExpired()
          // returns false until the session goes idle again.
          self.inflightRequests++;
        },
        onSessionIdle: () => {
          // Busy → idle: all RPC promises have settled and all stream
          // exports have been released. Equivalent to containerFetch's
          // finally block — decrement and restart the inactivity window
          // from now.
          self.inflightRequests = Math.max(0, self.inflightRequests - 1);
          if (self.inflightRequests === 0) {
            this.renewActivityTimeout();
          }
        }
      });
    }
    return this.createSandboxClient();
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

    // Read transport setting from env var
    const transportEnv = envObj?.SANDBOX_TRANSPORT;
    if (transportEnv === 'websocket' || transportEnv === 'rpc') {
      this.transport = transportEnv;
    } else if (transportEnv != null && transportEnv !== 'http') {
      this.logger.warn(
        `Invalid SANDBOX_TRANSPORT value: "${transportEnv}". Must be "http", "websocket", or "rpc". Defaulting to "http".`
      );
    }

    this.logger.info(`Using ${this.transport} transport`);

    // Read R2 backup bucket binding if configured
    const backupBucket = envObj?.BACKUP_BUCKET;
    if (isR2Bucket(backupBucket)) {
      this.backupBucket = backupBucket;
    }

    // Read R2 presigned URL credentials for direct container-to-R2 backup transfers
    this.r2AccountId = getEnvString(envObj, 'CLOUDFLARE_ACCOUNT_ID') ?? null;
    this.r2AccessKeyId = getEnvString(envObj, 'R2_ACCESS_KEY_ID') ?? null;
    this.r2SecretAccessKey =
      getEnvString(envObj, 'R2_SECRET_ACCESS_KEY') ?? null;
    this.backupBucketName = getEnvString(envObj, 'BACKUP_BUCKET_NAME') ?? null;

    if (this.r2AccessKeyId && this.r2SecretAccessKey) {
      this.r2Client = new AwsClient({
        accessKeyId: this.r2AccessKeyId,
        secretAccessKey: this.r2SecretAccessKey
      });
    }

    // Construct the control callback BEFORE the client — RPC clients
    // capture it as `localMain` on the capnweb session, and the
    // session is created eagerly in the connection's constructor.
    this.controlCallback = new SandboxControlCallbackImpl(
      () => this.tunnelExitHandler,
      this.logger
    );

    this.client = this.createClientForTransport(this.transport);

    this.codeInterpreter = new CodeInterpreter(() => this.client.interpreter);

    this.ctx.blockConcurrencyWhile(async () => {
      this.sandboxName =
        (await this.ctx.storage.get<string>('sandboxName')) ?? null;
      this.normalizeId =
        (await this.ctx.storage.get<boolean>('normalizeId')) ?? false;
      this.defaultSession =
        (await this.ctx.storage.get<string>('defaultSession')) ?? null;
      this.keepAliveEnabled =
        (await this.ctx.storage.get<boolean>('keepAliveEnabled')) ?? false;
      const storedEnableDefaultSession = await this.ctx.storage.get<boolean>(
        'enableDefaultSession'
      );
      if (storedEnableDefaultSession != null) {
        this.enableDefaultSession = storedEnableDefaultSession;
        this.hasStoredEnableDefaultSession = true;
      }

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
        // Update the transport retry budget to reflect stored timeouts
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

      // Restore transport setting from storage (overrides env var default)
      const storedTransport =
        await this.ctx.storage.get<SandboxTransport>('transport');
      if (storedTransport && storedTransport !== this.transport) {
        this.transport = storedTransport;
        const previousClient = this.client;
        this.client = this.createClientForTransport(storedTransport);
        this.codeInterpreter = new CodeInterpreter(
          () => this.client.interpreter
        );
        // Drop the tunnels handler; the lazy getter rebinds it to the
        // new client on next access. Same rationale as codeInterpreter.
        this.tunnelsHandler = null;
        this.tunnelExitHandler = null;
        previousClient.disconnect();
      }
      if (storedTransport) {
        this.hasStoredTransport = true;
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

    if (configuration.enableDefaultSession !== undefined) {
      await this.setEnableDefaultSession(configuration.enableDefaultSession);
    }

    if (configuration.containerTimeouts !== undefined) {
      await this.setContainerTimeouts(configuration.containerTimeouts);
    }

    if (configuration.transport !== undefined) {
      await this.setTransport(configuration.transport);
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

  async setEnableDefaultSession(enableDefaultSession: boolean): Promise<void> {
    if (
      this.hasStoredEnableDefaultSession &&
      this.enableDefaultSession === enableDefaultSession
    ) {
      return;
    }

    const previousDefaultSession = !enableDefaultSession
      ? this.defaultSession
      : null;

    if (!enableDefaultSession) {
      this.containerGeneration++;
      this.defaultSession = null;
      this.defaultSessionInit = null;
    }

    if (previousDefaultSession) {
      await this.client.utils.deleteSession(previousDefaultSession);
    }

    if (!enableDefaultSession) {
      await this.ctx.storage.delete('defaultSession');
    }

    await this.ctx.storage.put('enableDefaultSession', enableDefaultSession);
    this.enableDefaultSession = enableDefaultSession;
    this.hasStoredEnableDefaultSession = true;
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

  async setTransport(transport: SandboxTransport): Promise<void> {
    if (
      transport !== 'http' &&
      transport !== 'websocket' &&
      transport !== 'rpc'
    ) {
      this.logger.warn(
        `Invalid transport value: "${transport}". Must be "http", "websocket", or "rpc". Ignoring.`
      );
      return;
    }

    if (this.hasStoredTransport && this.transport === transport) {
      return;
    }

    await this.ctx.storage.put('transport', transport);

    const previousClient = this.client;
    this.transport = transport;
    this.hasStoredTransport = true;
    this.client = this.createClientForTransport(transport);
    this.codeInterpreter = new CodeInterpreter(() => this.client.interpreter);
    // Drop the tunnels handler so the lazy getter rebinds it to the
    // new client on next access. Storage is unchanged: existing
    // tunnels are still backed by their cloudflared processes since the
    // container did not restart.
    this.tunnelsHandler = null;
    this.tunnelExitHandler = null;
    previousClient.disconnect();
    this.renewActivityTimeout();
    this.logger.debug('Transport updated', { transport });
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

  private validateR2EgressS3fsOptions(options?: string[]): void {
    if (!options) return;

    const protectedOptions = new Set(['passwd_file', 'url']);
    for (const option of options) {
      const [key] = option.split('=');
      if (protectedOptions.has(key)) {
        throw new InvalidMountConfigError(
          `s3fs option "${key}" cannot be overridden for R2 binding mounts`
        );
      }
    }
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

    try {
      validateBucketBindingName(bucket, mountPath);
      this.validateMountPath(mountPath);
      this.validateR2EgressS3fsOptions(options.s3fsOptions);

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

      const passwordFilePath = this.generatePasswordFilePath();
      // s3fs requires a passwd file before it will issue requests; the R2
      // egress handler resolves the Worker binding and ignores S3 signatures.
      await this.createPasswordFile(passwordFilePath, bucket, {
        accessKeyId: 'x',
        secretAccessKey: 'x'
      });

      const mountInfo: R2BindingMountInfo = {
        mountType: 'r2-egress',
        bucket,
        mountPath,
        passwordFilePath,
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

      // Generate unique password file path
      passwordFilePath = this.generatePasswordFilePath();

      // Reserve mount path before async operations so concurrent mounts see it
      const mountInfo: FuseMountInfo = {
        mountType: 'fuse',
        bucket: s3fsSource,
        mountPath,
        endpoint: options.endpoint,
        provider,
        passwordFilePath,
        mounted: false
      };
      this.activeMounts.set(mountPath, mountInfo);

      // Create password file with credentials (uses bucket name only, not prefix)
      await this.createPasswordFile(passwordFilePath, bucket, credentials);

      // Check if mount directory already exists before creating it, so we
      // only remove it on failure if the SDK created it
      dirExisted =
        (await this.execInternal(`test -d ${shellEscape(mountPath)}`))
          .exitCode === 0;
      await this.execInternal(`mkdir -p ${shellEscape(mountPath)}`);

      // Execute S3FS mount with password file (uses full s3fs source with prefix)
      await this.executeS3FSMount(
        s3fsSource,
        mountPath,
        options,
        provider,
        passwordFilePath
      );

      mountInfo.mounted = true;
      mountOutcome = 'success';
    } catch (error) {
      mountError = error instanceof Error ? error : new Error(String(error));
      // Clean up password file on failure
      if (passwordFilePath) {
        await this.deletePasswordFile(passwordFilePath);
      }
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

      // Clean up reservation on failure
      this.activeMounts.delete(mountPath);
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
      } else {
        // FUSE unmount
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
          mountInfo.mounted = false;

          // Only remove from tracking if unmount succeeded
          this.activeMounts.delete(mountPath);

          if (mountInfo.mountType === 'r2-egress') {
            await this.configureR2EgressOutbound(this.getR2EgressParams());
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
          // Always cleanup password file, even if unmount fails
          await this.deletePasswordFile(mountInfo.passwordFilePath);
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
      SESSIONLESS_SESSION_ID
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
   * Manually unmount a bucket filesystem
   *
   * @param mountPath - Absolute path where the bucket is mounted
   * @throws InvalidMountConfigError if mount path doesn't exist or isn't mounted
   */
  async unmountBucket(mountPath: string): Promise<void> {
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
      } else {
        // FUSE unmount
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
          mountInfo.mounted = false;

          // Only remove from tracking if unmount succeeded
          this.activeMounts.delete(mountPath);

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
          // Always cleanup password file, even if unmount fails
          await this.deletePasswordFile(mountInfo.passwordFilePath);
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
      // Best-effort desktop stop — only when container is already running
      if (this.ctx.container?.running) {
        try {
          await this.client.desktop.stop();
        } catch {
          // Desktop may not be running or available — continue cleanup
        }
      }

      // Unmount all mounted buckets and cleanup (requires an active connection
      // for execInternal calls, so this runs before disconnecting the transport)
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

          // Always cleanup password file for FUSE mounts
          await this.deletePasswordFile(mountInfo.passwordFilePath);
        }
      }

      // portTokens is cleared while still inside destroy()'s try block:
      // super.destroy() is not serialized by blockConcurrencyWhile, so
      // other DO RPCs run during the await. With storage already cleared,
      // a concurrent validatePortToken() from the preview URL proxy sees
      // no token and returns unauthorized, and a concurrent startup path
      // finds nothing to rehydrate via restoreExposedPorts(). Teardown is
      // still not atomic against concurrent writers, but the preview URL
      // authorization path is race-free.
      await this.ctx.storage.delete('portTokens');
      // Tunnels storage is the SDK's source of truth for which
      // *.trycloudflare.com URLs are live. Clearing it ensures any
      // post-destroy get() reads see an empty cache and a destroyed
      // sandbox's URLs are not resurrected after a new container
      // takes the same DO id.
      await this.ctx.storage.delete('tunnels');

      // Disconnect transport after all cleanup commands have completed
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

    // Fire-and-forget: version check is observability, not load-bearing.
    this.checkVersionCompatibility().catch((error) => {
      this.logger.error(
        'Version compatibility check failed',
        error instanceof Error ? error : new Error(String(error))
      );
    });

    // Re-expose ports that were exposed before the container restarted.
    // Tokens persist in DO storage across restarts (see onStop), but the
    // container runtime has no memory of which ports were exposed. The base
    // @cloudflare/containers class wraps onStart in blockConcurrencyWhile,
    // so awaiting restore here keeps the DO gate held until restore
    // completes — requests that arrive during the startup window (including
    // validatePortToken calls from the Worker preview-URL proxy) queue
    // behind it.
    try {
      await this.restoreExposedPorts();
    } catch (error) {
      this.logger.error(
        'Failed to restore exposed ports after container start',
        error instanceof Error ? error : new Error(String(error))
      );
    }

    // Tunnels are NOT restored across container restart. Every
    // cloudflared process the container was running died with it, so
    // every stored *.trycloudflare.com URL is dead. Clearing storage
    // here means the next get(port) call takes the miss branch and
    // spawns a fresh tunnel with a new URL. We do this inside onStart's
    // blockConcurrencyWhile gate so any get() that arrived during the
    // startup window sees the empty cache by the time it runs.
    try {
      await this.ctx.storage.delete('tunnels');
    } catch (error) {
      this.logger.error(
        'Failed to clear tunnel storage after container start',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Re-expose ports on the container runtime using tokens persisted in DO
   * storage. Called from onStart() after a container (re)start.
   *
   * The DO storage holds the source of truth for which ports should be
   * exposed, which tokens authorize them, and the friendly name (if any)
   * that the caller set when first exposing the port. If a port is already
   * exposed on the container this is a no-op for that port. Individual port
   * failures are logged but do not abort the overall restore — a transient
   * failure for one port must not prevent the others from being restored.
   */
  private async restoreExposedPorts(): Promise<void> {
    const savedTokens = await this.readPortTokens();
    const portEntries = Object.entries(savedTokens);
    if (portEntries.length === 0) {
      return;
    }

    const startTime = Date.now();
    let restored = 0;
    let skipped = 0;
    let failed = 0;

    // Fetch the container's current exposed-port list once, then check
    // membership in the loop. On a fresh restart this is empty; on a
    // retry path (re-entering onStart) it may already contain entries
    // that should be skipped.
    const exposedSet = await this.client.ports
      .getExposedPorts(SESSIONLESS_SESSION_ID)
      .then((response) => new Set(response.ports.map((p) => p.port)))
      .catch((error) => {
        this.logger.warn(
          'Failed to fetch exposed ports for restore; assuming none exposed',
          { error: error instanceof Error ? error.message : String(error) }
        );
        return new Set<number>();
      });

    for (const [portStr, entry] of portEntries) {
      const port = Number.parseInt(portStr, 10);
      if (!Number.isFinite(port) || !validatePort(port)) {
        this.logger.warn('Skipping restore of invalid port in storage', {
          port: portStr
        });
        failed++;
        continue;
      }

      if (exposedSet.has(port)) {
        skipped++;
        continue;
      }

      try {
        await this.client.ports.exposePort(
          port,
          SESSIONLESS_SESSION_ID,
          entry.name
        );
        restored++;
      } catch (error) {
        failed++;
        this.logger.warn('Failed to re-expose port on container restart', {
          port,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    logCanonicalEvent(this.logger, {
      event: 'port.restore',
      outcome: failed === 0 ? 'success' : 'error',
      durationMs: Date.now() - startTime,
      restored,
      skipped,
      failed,
      total: portEntries.length
    });
  }

  /**
   * Read the `portTokens` map from DO storage, normalizing the legacy
   * string-valued format (just a token) to the current object format
   * ({ token, name? }). The legacy format predates port-name persistence and
   * can appear on any DO whose storage was written before that change.
   */
  private async readPortTokens(): Promise<Record<string, PortTokenEntry>> {
    const raw =
      (await this.ctx.storage.get<Record<string, string | PortTokenEntry>>(
        'portTokens'
      )) ?? {};
    const normalized: Record<string, PortTokenEntry> = {};
    for (const [port, value] of Object.entries(raw)) {
      normalized[port] = typeof value === 'string' ? { token: value } : value;
    }
    return normalized;
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

    // Disconnect the active client so open sockets do not hold the DO alive.
    this.client.disconnect();

    // Stop local sync managers before clearing the map.
    let hadR2EgressMount = false;
    for (const [, m] of this.activeMounts) {
      if (m.mountType === 'local-sync') {
        await m.syncManager.stop().catch(() => {});
      } else if (m.mountType === 'r2-egress') {
        hadR2EgressMount = true;
      }
    }
    if (hadR2EgressMount) {
      await this.configureR2EgressOutbound({ buckets: {} }).catch(() => {});
    }

    this.activeMounts.clear();

    // Persist cleanup to storage so state is clean on next container start.
    // Port tokens are preserved so preview URLs survive container restarts;
    // they are only removed on explicit unexposePort() or full sandbox
    // destroy(). onStart's restoreExposedPorts() replays those tokens into
    // the container on the next start, which lets validatePortToken()
    // answer from storage alone.
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
            code: ErrorCode.INTERNAL_ERROR,
            message:
              'Container is currently provisioning. This can take several minutes on first deployment.',
            context: { phase: 'provisioning' },
            httpStatus: 503,
            timestamp: new Date().toISOString(),
            suggestion:
              'This is expected during first deployment. The SDK will retry automatically.'
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
            code: ErrorCode.INTERNAL_ERROR,
            message: 'Container is starting. Please retry in a moment.',
            context: {
              phase: 'startup',
              error: e instanceof Error ? e.message : String(e)
            },
            httpStatus: 503,
            timestamp: new Date().toISOString(),
            suggestion:
              'The container is booting. The SDK will retry automatically.'
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
          code: ErrorCode.INTERNAL_ERROR,
          message: 'Container is starting. Please retry in a moment.',
          context: {
            phase: 'startup',
            error: e instanceof Error ? e.message : String(e)
          },
          httpStatus: 503,
          timestamp: new Date().toISOString(),
          suggestion:
            'The SDK will retry automatically. If this persists, the container may need redeployment.'
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

  // Override fetch to route internal container requests to appropriate ports
  override async fetch(request: Request): Promise<Response> {
    // Extract or generate trace ID from request
    const traceId =
      TraceContext.fromHeaders(request.headers) || TraceContext.generate();

    // Create request-specific logger with trace ID
    const requestLogger = this.logger.child({ traceId, operation: 'fetch' });

    const url = new URL(request.url);

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

  private determinePort(url: URL): number {
    // Extract port from proxy requests (e.g., /proxy/8080/*)
    const proxyMatch = url.pathname.match(/^\/proxy\/(\d+)/);
    if (proxyMatch) {
      return parseInt(proxyMatch[1], 10);
    }

    // All other requests go to control plane on port 3000
    // This includes /api/* endpoints and any other control requests
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
      throw new Error(
        'Default session initialization was invalidated by a container stop'
      );
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
    if (explicitSessionId) {
      return { kind: 'session', sessionId: explicitSessionId };
    }

    if (this.enableDefaultSession) {
      return {
        kind: 'session',
        sessionId: await this.ensureDefaultSession()
      };
    }

    return { kind: 'sessionless' };
  }

  private serializeExecutionContext(context: SandboxExecutionContext): string {
    return context.kind === 'sessionless'
      ? SESSIONLESS_SESSION_ID
      : context.sessionId;
  }

  /**
   * Resolves the session ID to annotate returned Process objects.
   *
   * Unlike `resolveExecution`, this is synchronous and never creates a
   * session. When `enableDefaultSession` is true but the default session
   * hasn't been established yet, it returns `undefined` rather than
   * triggering session creation. The resolved value is only used to
   * populate `Process.sessionId` on the returned object — it is never
   * sent to the container API.
   */
  private getProcessSessionBinding(
    explicitSessionId?: string
  ): string | undefined {
    if (explicitSessionId) {
      return explicitSessionId;
    }

    return this.enableDefaultSession
      ? (this.defaultSession ?? undefined)
      : SESSIONLESS_SESSION_ID;
  }

  private resolveExecutionEnv(
    sessionId: string,
    env?: Record<string, string | undefined>
  ): Record<string, string | undefined> | undefined {
    if (sessionId === SESSIONLESS_SESSION_ID) {
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

  // Enhanced exec method - always returns ExecResult with optional streaming
  // This replaces the old exec method to match ISandbox interface
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const context = await this.resolveExecution();
    const session = this.serializeExecutionContext(context);
    return this.execWithSession(command, session, options);
  }

  /**
   * Execute an infrastructure command (backup, mount, env setup, etc.)
   * tagged with origin: 'internal' so logging demotes it to debug level.
   */
  private async execInternal(command: string): Promise<ExecResult> {
    return this.execWithSession(command, SESSIONLESS_SESSION_ID, {
      origin: 'internal'
    });
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
    const timestamp = new Date().toISOString();

    let timeoutId: NodeJS.Timeout | undefined;
    let execOutcome: { exitCode: number; success: boolean } | undefined;
    let execError: Error | undefined;

    try {
      // Handle cancellation
      if (options?.signal?.aborted) {
        throw new Error('Operation was aborted');
      }

      let result: ExecResult;

      if (options?.stream && options?.onOutput) {
        // Streaming with callbacks - we need to collect the final result
        result = await this.executeWithStreaming(
          command,
          sessionId,
          options,
          startTime,
          timestamp
        );
      } else {
        // Regular execution with session
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
        result = this.mapExecuteResponseToExecResult(
          response,
          duration,
          sessionId
        );
      }

      execOutcome = { exitCode: result.exitCode, success: result.success };

      // Call completion callback if provided
      if (options?.onComplete) {
        options.onComplete(result);
      }

      return result;
    } catch (error) {
      execError = error instanceof Error ? error : new Error(String(error));
      if (options?.onError && error instanceof Error) {
        options.onError(error);
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
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

  private async executeWithStreaming(
    command: string,
    sessionId: string,
    options: ExecOptions,
    startTime: number,
    timestamp: string
  ): Promise<ExecResult> {
    let stdout = '';
    let stderr = '';

    try {
      const stream = await this.client.commands.executeStream(
        command,
        sessionId,
        {
          timeoutMs: options.timeout,
          env: options.env,
          cwd: options.cwd,
          origin: options.origin
        }
      );

      for await (const event of parseSSEStream<ExecEvent>(stream)) {
        // Check for cancellation
        if (options.signal?.aborted) {
          throw new Error('Operation was aborted');
        }

        switch (event.type) {
          case 'stdout':
          case 'stderr':
            if (event.data) {
              // Update accumulated output
              if (event.type === 'stdout') stdout += event.data;
              if (event.type === 'stderr') stderr += event.data;

              // Call user's callback
              if (options.onOutput) {
                options.onOutput(event.type, event.data);
              }
            }
            break;

          case 'complete': {
            // Use result from complete event if available
            const duration = Date.now() - startTime;
            return {
              success: (event.exitCode ?? 0) === 0,
              exitCode: event.exitCode ?? 0,
              stdout,
              stderr,
              command,
              duration,
              timestamp,
              sessionId
            };
          }

          case 'error':
            throw new Error(event.data || 'Command execution failed');
        }
      }

      // If we get here without a complete event, something went wrong
      throw new Error('Stream ended without completion event');
    } catch (error) {
      if (options.signal?.aborted) {
        throw new Error('Operation was aborted');
      }
      throw error;
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
      const execution = await this.resolveExecution(sessionId);
      const session = this.serializeExecutionContext(execution);
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
        session
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
    let response;
    try {
      response = await this.client.processes.getProcess(id);
    } catch (error) {
      if (error instanceof ProcessNotFoundError) {
        return null;
      }
      throw error;
    }
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
  }

  async killProcess(
    id: string,
    signal?: string,
    sessionId?: string
  ): Promise<void> {
    // Note: signal parameter is not currently supported by the HTTP client.
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

  // Streaming methods - return ReadableStream for RPC compatibility
  async execStream(
    command: string,
    options?: StreamOptions
  ): Promise<ReadableStream<Uint8Array>> {
    // Check for cancellation
    if (options?.signal?.aborted) {
      throw new Error('Operation was aborted');
    }

    const context = await this.resolveExecution();
    const session = this.serializeExecutionContext(context);
    const executionOptions = this.buildExecutionRequestOptions(session, {
      timeout: options?.timeout,
      env: options?.env,
      cwd: options?.cwd
    });
    // Get the stream from CommandClient
    return this.client.commands.executeStream(
      command,
      session,
      executionOptions
    );
  }

  /**
   * Internal session-aware execStream implementation
   */
  private async execStreamWithSession(
    command: string,
    sessionId: string,
    options?: StreamOptions
  ): Promise<ReadableStream<Uint8Array>> {
    // Check for cancellation
    if (options?.signal?.aborted) {
      throw new Error('Operation was aborted');
    }

    return this.client.commands.executeStream(
      command,
      sessionId,
      this.buildExecutionRequestOptions(sessionId, {
        timeout: options?.timeout,
        env: options?.env,
        cwd: options?.cwd
      })
    );
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
   *              with no encoding overhead. **Requires `SANDBOX_TRANSPORT=rpc`.** Throws on HTTP/WebSocket transports.
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

  async listFiles(
    path: string,
    options?: { recursive?: boolean; includeHidden?: boolean }
  ) {
    const context = await this.resolveExecution();
    const session = this.serializeExecutionContext(context);
    return this.client.files.listFiles(path, session, options);
  }

  async exists(path: string, sessionId?: string) {
    const execution = await this.resolveExecution(sessionId);
    const session = this.serializeExecutionContext(execution);
    return this.client.files.exists(path, session);
  }

  /**
   * Get the noVNC preview URL for browser-based desktop viewing.
   * Confirms desktop is active, then uses exposePort() to generate
   * a token-authenticated preview URL for the noVNC port (6080).
   *
   * @param hostname - The custom domain hostname for preview URLs
   *   (e.g., 'preview.example.com'). Required because preview URLs
   *   use subdomain patterns that .workers.dev doesn't support.
   * @param options - Optional settings
   * @param options.token - Reuse an existing token instead of generating a new one
   * @returns The authenticated noVNC preview URL
   */
  async getDesktopStreamUrl(
    hostname: string,
    options?: { token?: string }
  ): Promise<{ url: string }> {
    // Confirm desktop is running before generating a URL
    const status = await this.client.desktop.status();
    if (status.status === 'inactive') {
      throw new Error(
        'Desktop is not running. Call sandbox.desktop.start() first.'
      );
    }

    let url: string;

    // Try exposing port 6080; if already exposed, construct the URL from stored token
    try {
      const result = await this.exposePort(6080, {
        hostname,
        token: options?.token
      });
      url = result.url;
    } catch {
      // Port may already be exposed — look up the existing token from DO storage
      const tokens = await this.readPortTokens();
      const existingEntry = tokens['6080'];
      if (existingEntry && this.sandboxName) {
        url = this.constructPreviewUrl(
          6080,
          this.sandboxName,
          hostname,
          existingEntry.token
        );
      } else {
        throw new Error(
          'Failed to get desktop stream URL: port 6080 could not be exposed and no existing token found.'
        );
      }
    }

    // Wait for the platform to detect port 6080 using the Containers runtime's
    // built-in port readiness mechanism (getTcpPort polling). This ensures the
    // preview URL is routable before returning it to the caller.
    try {
      await this.waitForPort({
        portToCheck: 6080,
        retries: 30,
        waitInterval: 500
      });
    } catch {
      // Best-effort: if detection times out after ~15s, return the URL anyway.
      // noVNC's WebSocket auto-connect will retry on the client side.
    }

    return { url };
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
   * Preview URLs survive transient container restarts: the token and any
   * friendly name are persisted in Durable Object storage, and the port is
   * automatically re-exposed on the container when it comes back up. Tokens
   * are cleared only on explicit `unexposePort()` or full sandbox
   * `destroy()`.
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

      let token: string;
      if (options.token !== undefined) {
        this.validateCustomToken(options.token);
        token = options.token;
      } else {
        token = this.generatePortToken();
      }

      // Allow re-exposing same port with same token, but reject if another port uses this token
      const tokens = await this.readPortTokens();
      const existingPort = Object.entries(tokens).find(
        ([p, entry]) => entry.token === token && p !== port.toString()
      );
      if (existingPort) {
        throw new SandboxSecurityError(
          `Token '${token}' is already in use by port ${existingPort[0]}. Please use a different token.`
        );
      }
      const sessionId = this.serializeExecutionContext(
        await this.resolveExecution()
      );
      await this.client.ports.exposePort(port, sessionId, options?.name);

      tokens[port.toString()] = { token, name: options?.name };
      await this.ctx.storage.put('portTokens', tokens);

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
        name: options?.name
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
        name: options?.name,
        hostname: options.hostname,
        error: caughtError
      });
    }
  }

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

      // Storage is the source of truth for preview-URL auth, so clear
      // the token before the container RPC. A preview request that
      // arrives during the container call sees no token, fails auth,
      // and is rejected before containerFetch() can route it to the
      // process running inside the sandbox. (containerFetch() does not
      // gate on the container's exposed-port registry; it connects to
      // the port number directly.)
      const tokens = await this.readPortTokens();
      if (tokens[port.toString()]) {
        delete tokens[port.toString()];
        await this.ctx.storage.put('portTokens', tokens);
      }

      const sessionId = this.serializeExecutionContext(
        await this.resolveExecution()
      );
      try {
        await this.client.ports.unexposePort(port, sessionId);
      } catch (error) {
        // A container that was asleep when we entered wakes with an
        // empty exposed-port registry; restoreExposedPorts() has
        // nothing to replay because we just cleared the token. The
        // container then reports the port was never exposed, which is
        // the state we wanted.
        if (!(error instanceof PortNotExposedError)) {
          throw error;
        }
      }

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

  async getExposedPorts(hostname: string) {
    const sessionId = this.serializeExecutionContext(
      await this.resolveExecution()
    );
    const response = await this.client.ports.getExposedPorts(sessionId);

    // We need the sandbox name to construct preview URLs
    if (!this.sandboxName) {
      throw new Error(
        'Sandbox name not available. Ensure sandbox is accessed through getSandbox()'
      );
    }

    // Read all tokens from storage (protected by input gates)
    const tokens = await this.readPortTokens();

    // A port reported by the container with no corresponding token in
    // storage is an orphan. It cannot produce a valid preview URL (the
    // token is what the URL binds to), so it is omitted from the
    // result. The next container restart reconciles the inconsistency
    // because restoreExposedPorts() rebuilds the container registry
    // from storage.
    return response.ports.flatMap((port) => {
      const entry = tokens[port.port.toString()];
      if (!entry) {
        this.logger.warn(
          'Port exposed on container but no token in storage; omitting from preview URL list',
          { port: port.port }
        );
        return [];
      }

      return [
        {
          url: this.constructPreviewUrl(
            port.port,
            this.sandboxName!,
            hostname,
            entry.token
          ),
          port: port.port,
          status: port.status
        }
      ];
    });
  }

  /**
   * Namespaced tunnel API. Quick tunnels are zero-config preview URLs
   * backed by Cloudflare's trycloudflare service.
   *
   * - `tunnels.get(port)` — idempotent. Returns the cached tunnel for
   *   `port` if one exists in DO storage, otherwise spawns a fresh
   *   cloudflared process and persists the record.
   * - `tunnels.list()` — records currently known to this sandbox, from
   *   DO storage.
   * - `tunnels.destroy(portOrInfo)` — tear down by port number or by
   *   the record returned from `get()`.
   *
   * Storage is cleared on container restart (`onStart`), so URLs do
   * not survive a container restart — the next `get(port)` call will
   * spawn a fresh tunnel with a new URL.
   *
   * Requires the RPC transport. Calling this on a route-based transport
   * throws "RPC transport required".
   */
  get tunnels(): TunnelsHandler {
    this.ensureTunnelsBuilt();
    // Non-null after ensureTunnelsBuilt(); cast for the type system.
    return this.tunnelsHandler as TunnelsHandler;
  }

  /**
   * Lazily construct both the public tunnels handler and its sibling
   * exit-handler callback. Called from the `tunnels` getter on first
   * access and on every access after a transport swap clears both
   * fields.
   */
  private ensureTunnelsBuilt(): void {
    if (this.tunnelsHandler) return;
    const built = createTunnelsHandler({
      client: this.client,
      storage: this.ctx.storage,
      logger: this.logger
    });
    this.tunnelsHandler = built.tunnels;
    this.tunnelExitHandler = built.handleTunnelExit;
  }

  async isPortExposed(port: number): Promise<boolean> {
    try {
      const sessionId = this.serializeExecutionContext(
        await this.resolveExecution()
      );
      const response = await this.client.ports.getExposedPorts(sessionId);
      return response.ports.some((exposedPort) => exposedPort.port === port);
    } catch (error) {
      this.logger.error(
        'Error checking if port is exposed',
        error instanceof Error ? error : new Error(String(error)),
        { port }
      );
      return false;
    }
  }

  async validatePortToken(port: number, token: string): Promise<boolean> {
    // Preview-URL auth answers from DO storage alone. onStart's
    // restoreExposedPorts() replays storage into the container on restart,
    // and destroy() clears portTokens before super.destroy() runs, so a
    // storage read gives the right answer for the interleavings this
    // method can race.
    const tokens = await this.readPortTokens();
    const entry = tokens[port.toString()];
    if (!entry) {
      return false;
    }

    const encoder = new TextEncoder();
    const a = encoder.encode(entry.token);
    const b = encoder.encode(token);

    try {
      // Workers runtime extends SubtleCrypto with timingSafeEqual
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
    // terminal: null here, added client-side by getSandbox() (WebSockets can't cross RPC)
    return {
      id: sessionId,
      terminal: null as unknown as ExecutionSession['terminal'],

      exec: (command, options) =>
        this.execWithSession(command, sessionId, options),
      execStream: (command, options) =>
        this.execStreamWithSession(command, sessionId, options),

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

      // Code interpreter methods - delegate to sandbox's code interpreter
      createCodeContext: (options) =>
        this.codeInterpreter.createCodeContext(options),
      runCode: async (code, options) => {
        const execution = await this.codeInterpreter.runCode(code, options);
        return execution.toJSON();
      },
      runCodeStream: (code, options) =>
        this.codeInterpreter.runCodeStream(code, options),
      listCodeContexts: () => this.codeInterpreter.listCodeContexts(),
      deleteCodeContext: (contextId) =>
        this.codeInterpreter.deleteCodeContext(contextId),

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
  // Code interpreter methods - delegate to CodeInterpreter wrapper
  // ============================================================================

  async createCodeContext(
    options?: CreateContextOptions
  ): Promise<CodeContext> {
    return this.codeInterpreter.createCodeContext(options);
  }

  async runCode(
    code: string,
    options?: RunCodeOptions
  ): Promise<ExecutionResult> {
    const execution = await this.codeInterpreter.runCode(code, options);
    return execution.toJSON();
  }

  async runCodeStream(
    code: string,
    options?: RunCodeOptions
  ): Promise<ReadableStream> {
    return this.codeInterpreter.runCodeStream(code, options);
  }

  async listCodeContexts(): Promise<CodeContext[]> {
    return this.codeInterpreter.listCodeContexts();
  }

  async deleteCodeContext(contextId: string): Promise<void> {
    return this.codeInterpreter.deleteCodeContext(contextId);
  }

  // ============================================================================
  // Backup methods — squashfs archive + R2 storage
  // ============================================================================

  /** UUID v4 format validator for backup IDs */
  private static readonly UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * Validate that a directory path is safe for backup operations.
   * Rejects empty, relative, traversal, null-byte, and unsupported-root paths.
   */
  private static validateBackupDir(dir: string, label: string): void {
    if (!dir || !dir.startsWith('/')) {
      throw new InvalidBackupConfigError({
        message: `${label} must be an absolute path`,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: `${label} must be an absolute path` },
        timestamp: new Date().toISOString()
      });
    }
    if (dir.includes('\0')) {
      throw new InvalidBackupConfigError({
        message: `${label} must not contain null bytes`,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: `${label} must not contain null bytes` },
        timestamp: new Date().toISOString()
      });
    }
    if (dir.split('/').includes('..')) {
      throw new InvalidBackupConfigError({
        message: `${label} must not contain ".." path segments`,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: `${label} must not contain ".." path segments` },
        timestamp: new Date().toISOString()
      });
    }
    const isAllowed = BACKUP_ALLOWED_PREFIXES.some(
      (prefix) => dir === prefix || dir.startsWith(`${prefix}/`)
    );
    if (!isAllowed) {
      throw new InvalidBackupConfigError({
        message: `${label} must be inside one of the supported backup roots (${BACKUP_ALLOWED_PREFIXES.join(', ')})`,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: {
          reason: `${label} must be inside one of the supported backup roots`
        },
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Returns the R2 bucket or throws if backup is not configured.
   */
  private requireBackupBucket(): R2Bucket {
    if (!this.backupBucket) {
      throw new InvalidBackupConfigError({
        message:
          'Backup not configured. Add a BACKUP_BUCKET R2 binding to your wrangler.jsonc.',
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: 'Missing BACKUP_BUCKET R2 binding' },
        timestamp: new Date().toISOString()
      });
    }
    return this.backupBucket;
  }

  private normalizeBackupExcludes(excludes: string[]): string[] {
    const normalizedExcludes: string[] = [];

    for (const pattern of excludes) {
      const normalized = normalizeBackupExcludePattern(pattern);
      if (normalized === null) {
        this.logger.warn(
          'Exclude pattern reduced to empty after globstar normalization; skipping',
          { original: pattern }
        );
        continue;
      }
      if (normalized !== pattern) {
        this.logger.warn(
          'Exclude pattern contained ** (globstar) which mksquashfs does not support; normalized automatically',
          { original: pattern, normalized }
        );
      }
      normalizedExcludes.push(normalized);
    }

    return normalizedExcludes;
  }

  private resolveBackupCompression(compression: unknown): {
    format: 'gzip' | 'lz4' | 'zstd';
    threads: number;
  } {
    if (compression !== undefined) {
      if (typeof compression !== 'object' || compression === null) {
        throw new InvalidBackupConfigError({
          message: 'BackupOptions.compression must be an object',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'compression must be an object' },
          timestamp: new Date().toISOString()
        });
      }
    }

    const compressionOptions = compression as
      | { format?: unknown; threads?: unknown }
      | undefined;
    const format = compressionOptions?.format ?? BACKUP_DEFAULT_COMPRESSION;
    const threads =
      compressionOptions?.threads ?? BACKUP_DEFAULT_COMPRESS_THREADS;
    const allowedCompressions = ['gzip', 'lz4', 'zstd'];

    if (
      typeof format !== 'string' ||
      !allowedCompressions.includes(
        format as (typeof allowedCompressions)[number]
      )
    ) {
      throw new InvalidBackupConfigError({
        message:
          'BackupOptions.compression.format must be one of: gzip, lz4, zstd',
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: {
          reason: 'compression.format must be one of: gzip, lz4, zstd'
        },
        timestamp: new Date().toISOString()
      });
    }

    if (
      typeof threads !== 'number' ||
      !Number.isInteger(threads) ||
      threads < 1
    ) {
      throw new InvalidBackupConfigError({
        message: 'BackupOptions.compression.threads must be a positive integer',
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: {
          reason: 'compression.threads must be a positive integer'
        },
        timestamp: new Date().toISOString()
      });
    }

    return {
      format: format as 'gzip' | 'lz4' | 'zstd',
      threads
    };
  }

  private static readonly PRESIGNED_URL_EXPIRY_SECONDS = 3600;

  /**
   * Create a unique, dedicated session for a single backup operation.
   * Each call produces a fresh session ID so concurrent or sequential
   * operations never share shell state. Callers must destroy the session
   * in a finally block via `client.utils.deleteSession()`.
   */
  private async ensureBackupSession(): Promise<string> {
    const sessionId = `__sandbox_backup_${crypto.randomUUID()}`;
    await this.client.utils.createSession({ id: sessionId, cwd: '/' });
    return sessionId;
  }

  /**
   * Returns validated presigned URL configuration or throws if not configured.
   * All credential fields plus the R2 binding are required for backup to work.
   */
  private requirePresignedUrlSupport(): {
    client: AwsClient;
    accountId: string;
    bucketName: string;
  } {
    if (!this.r2Client || !this.r2AccountId || !this.backupBucketName) {
      const missing: string[] = [];
      if (!this.r2AccountId) missing.push('CLOUDFLARE_ACCOUNT_ID');
      if (!this.r2AccessKeyId) missing.push('R2_ACCESS_KEY_ID');
      if (!this.r2SecretAccessKey) missing.push('R2_SECRET_ACCESS_KEY');
      if (!this.backupBucketName) missing.push('BACKUP_BUCKET_NAME');

      throw new InvalidBackupConfigError({
        message:
          `Backup requires R2 presigned URL credentials. ` +
          `Missing: ${missing.join(', ')}. ` +
          'Set these as environment variables or secrets in your wrangler.jsonc.',
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: `Missing env vars: ${missing.join(', ')}` },
        timestamp: new Date().toISOString()
      });
    }

    return {
      client: this.r2Client,
      accountId: this.r2AccountId,
      bucketName: this.backupBucketName
    };
  }

  /**
   * Generate a presigned GET URL for downloading an object from R2.
   * The container can curl this URL directly without credentials.
   */
  private async generatePresignedGetUrl(r2Key: string): Promise<string> {
    const { client, accountId, bucketName } = this.requirePresignedUrlSupport();

    const encodedBucket = encodeURIComponent(bucketName);
    const encodedKey = r2Key
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const url = new URL(
      `https://${accountId}.r2.cloudflarestorage.com/${encodedBucket}/${encodedKey}`
    );
    url.searchParams.set(
      'X-Amz-Expires',
      String(Sandbox.PRESIGNED_URL_EXPIRY_SECONDS)
    );

    const signed = await client.sign(new Request(url), {
      aws: { signQuery: true }
    });

    return signed.url;
  }

  /**
   * Generate a presigned PUT URL for uploading an object to R2.
   * The container can curl PUT to this URL directly without credentials.
   */
  private async generatePresignedPutUrl(r2Key: string): Promise<string> {
    const { client, accountId, bucketName } = this.requirePresignedUrlSupport();

    const encodedBucket = encodeURIComponent(bucketName);
    const encodedKey = r2Key
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const url = new URL(
      `https://${accountId}.r2.cloudflarestorage.com/${encodedBucket}/${encodedKey}`
    );
    url.searchParams.set(
      'X-Amz-Expires',
      String(Sandbox.PRESIGNED_URL_EXPIRY_SECONDS)
    );

    const signed = await client.sign(new Request(url, { method: 'PUT' }), {
      aws: { signQuery: true }
    });

    return signed.url;
  }

  /**
   * Upload a backup archive via presigned PUT URL.
   * The container curls the archive directly to R2, bypassing the DO.
   * ~24 MB/s throughput vs ~0.6 MB/s for base64 readFile.
   */
  private async uploadBackupPresigned(
    archivePath: string,
    r2Key: string,
    archiveSize: number,
    backupId: string,
    dir: string,
    backupSession: string
  ): Promise<void> {
    const presignedUrl = await this.generatePresignedPutUrl(r2Key);

    const curlCmd = [
      'curl -sSf',
      '-X PUT',
      "-H 'Content-Type: application/octet-stream'",
      '--connect-timeout 10',
      '--max-time 1800',
      '--retry 2',
      '--retry-max-time 60',
      `-T ${shellEscape(archivePath)}`,
      shellEscape(presignedUrl)
    ].join(' ');

    const result = await this.execWithSession(curlCmd, backupSession, {
      timeout: 1810_000,
      origin: 'internal'
    });

    if (result.exitCode !== 0) {
      throw new BackupCreateError({
        message: `Presigned URL upload failed (exit code ${result.exitCode}): ${result.stderr}`,
        code: ErrorCode.BACKUP_CREATE_FAILED,
        httpStatus: 500,
        context: { dir, backupId },
        timestamp: new Date().toISOString()
      });
    }

    // Verify the upload landed correctly in R2
    const bucket = this.requireBackupBucket();
    const head = await bucket.head(r2Key);
    if (!head || head.size !== archiveSize) {
      const actualSize = head?.size ?? 0;
      // curl succeeded but R2 binding sees nothing — almost certainly a
      // local-dev mismatch where presigned URLs target real R2 while the
      // BACKUP_BUCKET binding points to local (miniflare) storage.
      const localDevHint =
        result.exitCode === 0 && actualSize === 0
          ? ' This usually means the BACKUP_BUCKET R2 binding is using local storage ' +
            'while presigned URLs upload to remote R2. Add `"remote": true` to your ' +
            'BACKUP_BUCKET R2 binding in wrangler.jsonc to fix this.'
          : '';
      throw new BackupCreateError({
        message: `Upload verification failed: expected ${archiveSize} bytes, got ${actualSize}.${localDevHint}`,
        code: ErrorCode.BACKUP_CREATE_FAILED,
        httpStatus: 500,
        context: { dir, backupId },
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Generate a presigned PUT URL for a single part in a multipart upload.
   */
  private async generatePresignedPartUrl(
    r2Key: string,
    uploadId: string,
    partNumber: number
  ): Promise<string> {
    const { client, accountId, bucketName } = this.requirePresignedUrlSupport();

    const encodedBucket = encodeURIComponent(bucketName);
    const encodedKey = r2Key
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const url = new URL(
      `https://${accountId}.r2.cloudflarestorage.com/${encodedBucket}/${encodedKey}`
    );
    url.searchParams.set(
      'X-Amz-Expires',
      String(Sandbox.PRESIGNED_URL_EXPIRY_SECONDS)
    );
    url.searchParams.set('partNumber', String(partNumber));
    url.searchParams.set('uploadId', uploadId);

    const signed = await client.sign(new Request(url, { method: 'PUT' }), {
      aws: { signQuery: true }
    });

    return signed.url;
  }

  /**
   * Upload a backup archive to R2 using parallel multipart upload.
   * Uses the S3-compatible API exclusively for create/complete/abort so that
   * the uploadId is in the same namespace as the presigned part PUT URLs.
   */
  private async uploadBackupMultipart(
    archivePath: string,
    r2Key: string,
    sizeBytes: number,
    backupId: string,
    dir: string,
    backupSession: string
  ): Promise<void> {
    const targetParts = calculatePartCount(
      sizeBytes,
      BACKUP_MULTIPART_TARGET_PARTS,
      BACKUP_MULTIPART_MAX_PARTS
    );
    const numParts = Math.min(
      targetParts,
      Math.floor(sizeBytes / BACKUP_MULTIPART_MIN_PART_SIZE)
    );

    if (numParts <= 1) {
      return this.uploadBackupPresigned(
        archivePath,
        r2Key,
        sizeBytes,
        backupId,
        dir,
        backupSession
      );
    }

    const { client, accountId, bucketName } = this.requirePresignedUrlSupport();
    const encodedBucket = encodeURIComponent(bucketName);
    const encodedKey = r2Key
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const objectUrl = `https://${accountId}.r2.cloudflarestorage.com/${encodedBucket}/${encodedKey}`;

    const createResp = await client.fetch(`${objectUrl}?uploads`, {
      method: 'POST'
    });
    if (!createResp.ok) {
      throw new BackupCreateError({
        message: `Failed to initiate multipart upload: HTTP ${createResp.status}`,
        code: ErrorCode.BACKUP_CREATE_FAILED,
        httpStatus: 500,
        context: { dir, backupId },
        timestamp: new Date().toISOString()
      });
    }

    const createXml = await createResp.text();
    const uploadIdMatch = createXml.match(/<UploadId>([^<]+)<\/UploadId>/);
    const uploadId = uploadIdMatch?.[1];
    if (!uploadId) {
      throw new BackupCreateError({
        message: 'Multipart upload response did not contain an UploadId',
        code: ErrorCode.BACKUP_CREATE_FAILED,
        httpStatus: 500,
        context: { dir, backupId },
        timestamp: new Date().toISOString()
      });
    }

    const abortMultipart = async () => {
      await client
        .fetch(`${objectUrl}?uploadId=${encodeURIComponent(uploadId)}`, {
          method: 'DELETE'
        })
        .catch(() => {});
    };

    try {
      const partSize = Math.ceil(sizeBytes / numParts);
      const parts = await Promise.all(
        Array.from({ length: numParts }, (_, i) => ({
          partNumber: i + 1,
          url: '',
          offset: i * partSize,
          size: i === numParts - 1 ? sizeBytes - i * partSize : partSize
        })).map(async (part) => ({
          ...part,
          url: await this.generatePresignedPartUrl(
            r2Key,
            uploadId,
            part.partNumber
          )
        }))
      );

      let uploadResult: Awaited<
        ReturnType<typeof this.client.backup.uploadParts>
      >;
      try {
        uploadResult = await this.client.backup.uploadParts({
          archivePath,
          parts,
          sessionId: backupSession
        });
      } catch (err) {
        if (
          err instanceof SandboxError &&
          err.errorResponse.httpStatus === 404
        ) {
          await abortMultipart();
          return this.uploadBackupPresigned(
            archivePath,
            r2Key,
            sizeBytes,
            backupId,
            dir,
            backupSession
          );
        }
        throw err;
      }

      if (!uploadResult.success || uploadResult.parts.length !== numParts) {
        throw new BackupCreateError({
          message: `Multipart upload returned ${uploadResult.parts.length} of ${numParts} parts`,
          code: ErrorCode.BACKUP_CREATE_FAILED,
          httpStatus: 500,
          context: { dir, backupId },
          timestamp: new Date().toISOString()
        });
      }

      const completeXml = [
        '<CompleteMultipartUpload>',
        ...uploadResult.parts.map(
          (p: { partNumber: number; etag: string }) =>
            `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`
        ),
        '</CompleteMultipartUpload>'
      ].join('');

      const completeResp = await client.fetch(
        `${objectUrl}?uploadId=${encodeURIComponent(uploadId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/xml' },
          body: completeXml
        }
      );

      if (!completeResp.ok) {
        const body = await completeResp.text().catch(() => '');
        throw new BackupCreateError({
          message: `Multipart upload completion failed: HTTP ${completeResp.status} ${body}`,
          code: ErrorCode.BACKUP_CREATE_FAILED,
          httpStatus: 500,
          context: { dir, backupId },
          timestamp: new Date().toISOString()
        });
      }

      const head = await this.requireBackupBucket().head(r2Key);
      if (!head || head.size !== sizeBytes) {
        throw new BackupCreateError({
          message: `Multipart upload verification failed: expected ${sizeBytes} bytes, got ${head?.size ?? 0}`,
          code: ErrorCode.BACKUP_CREATE_FAILED,
          httpStatus: 500,
          context: { dir, backupId },
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      await abortMultipart();
      throw error;
    }
  }

  /**
   * Download a backup archive from R2 via presigned GET URL.
   * For archives >= BACKUP_DOWNLOAD_PARALLEL_MIN_SIZE, uses BACKUP_DOWNLOAD_PARALLEL_PARTS
   * concurrent curl processes (each downloading a byte-range) to maximise both
   * network and disk-write throughput. Parts are written into a pre-sized file
   * with dd using byte offsets, then atomically moved to the final path.
   */
  private async downloadBackupParallel(
    archivePath: string,
    r2Key: string,
    expectedSize: number,
    backupId: string,
    dir: string,
    backupSession: string
  ): Promise<void> {
    const presignedUrl = await this.generatePresignedGetUrl(r2Key);
    await this.execWithSession(
      `mkdir -p ${BACKUP_CONTAINER_DIR}`,
      backupSession,
      { origin: 'internal' }
    );

    const tmpPath = `${archivePath}.tmp`;

    if (expectedSize < BACKUP_DOWNLOAD_PARALLEL_MIN_SIZE) {
      const curlCmd = [
        'curl -sSf',
        '--connect-timeout 10',
        '--max-time 1800',
        '--retry 2',
        '--retry-max-time 60',
        `-o ${shellEscape(tmpPath)}`,
        shellEscape(presignedUrl)
      ].join(' ');

      const result = await this.execWithSession(curlCmd, backupSession, {
        timeout: 1810_000,
        origin: 'internal'
      });

      if (result.exitCode !== 0) {
        await this.execWithSession(
          `rm -f ${shellEscape(tmpPath)}`,
          backupSession,
          { origin: 'internal' }
        ).catch(() => {});
        throw new BackupRestoreError({
          message: `Presigned URL download failed (exit code ${result.exitCode}): ${result.stderr}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          httpStatus: 500,
          context: { dir, backupId },
          timestamp: new Date().toISOString()
        });
      }
    } else {
      const numParts = calculatePartCount(
        expectedSize,
        BACKUP_DOWNLOAD_PARALLEL_PARTS,
        BACKUP_DOWNLOAD_MAX_PARTS
      );
      const partSize = Math.floor(expectedSize / numParts);
      const ranges = Array.from({ length: numParts }, (_, i) => {
        const start = i * partSize;
        const end = i < numParts - 1 ? start + partSize - 1 : expectedSize - 1;
        return { start, range: `${start}-${end}` };
      });

      const curlCmds = ranges.map(({ start, range }) =>
        [
          'curl -sSf',
          '--connect-timeout 10',
          '--max-time 1800',
          `-H ${shellEscape(`Range: bytes=${range}`)}`,
          shellEscape(presignedUrl),
          '|',
          'dd',
          `of=${shellEscape(tmpPath)}`,
          'oflag=seek_bytes',
          `seek=${start}`,
          'conv=notrunc',
          '2>/dev/null'
        ].join(' ')
      );

      const startLines = curlCmds.map(
        (cmd, i) => `(set -o pipefail; ${cmd}) & J${i}=$!`
      );
      const waitLines = Array.from(
        { length: numParts },
        (_, i) => `wait $J${i}; E${i}=$?`
      );
      const exitVars = Array.from({ length: numParts }, (_, i) => `$E${i}`);

      const script = [
        `rm -f ${shellEscape(tmpPath)}`,
        `truncate -s ${expectedSize} ${shellEscape(tmpPath)}`,
        ...startLines,
        ...waitLines,
        `FAILED=$(( ${exitVars.join(' + ')} ))`,
        `if [ "$FAILED" -ne 0 ]; then rm -f ${shellEscape(tmpPath)}; exit 1; fi`
      ].join('; ');

      const result = await this.execWithSession(script, backupSession, {
        timeout: 1810_000,
        origin: 'internal'
      });

      if (result.exitCode !== 0) {
        await this.execWithSession(
          `rm -f ${shellEscape(tmpPath)}`,
          backupSession,
          { origin: 'internal' }
        ).catch(() => {});
        throw new BackupRestoreError({
          message: `Parallel download failed (exit code ${result.exitCode}): ${result.stderr}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          httpStatus: 500,
          context: { dir, backupId },
          timestamp: new Date().toISOString()
        });
      }
    }

    const sizeCheck = await this.execWithSession(
      `stat -c %s ${shellEscape(tmpPath)}`,
      backupSession,
      { origin: 'internal' }
    );
    const actualSize = parseInt(sizeCheck.stdout.trim(), 10);
    if (actualSize !== expectedSize) {
      await this.execWithSession(
        `rm -f ${shellEscape(tmpPath)}`,
        backupSession,
        { origin: 'internal' }
      ).catch(() => {});
      throw new BackupRestoreError({
        message: `Downloaded archive size mismatch: expected ${expectedSize}, got ${actualSize}`,
        code: ErrorCode.BACKUP_RESTORE_FAILED,
        httpStatus: 500,
        context: { dir, backupId },
        timestamp: new Date().toISOString()
      });
    }

    const mvResult = await this.execWithSession(
      `mv ${shellEscape(tmpPath)} ${shellEscape(archivePath)}`,
      backupSession,
      { origin: 'internal' }
    );
    if (mvResult.exitCode !== 0) {
      await this.execWithSession(
        `rm -f ${shellEscape(tmpPath)}`,
        backupSession,
        { origin: 'internal' }
      ).catch(() => {});
      throw new BackupRestoreError({
        message: `Failed to finalize downloaded archive: ${mvResult.stderr}`,
        code: ErrorCode.BACKUP_RESTORE_FAILED,
        httpStatus: 500,
        context: { dir, backupId },
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Serialize backup operations on this sandbox instance.
   * Concurrent backup/restore calls are queued so the multi-step
   * create-archive → read → upload (or mount → extract) flow
   * is not interleaved with another backup operation on the same directory.
   */
  private enqueueBackupOp<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.backupInProgress.then(fn, () => fn());
    this.backupInProgress = next.catch(() => {});
    return next;
  }

  /**
   * Create a backup of a directory and upload it to R2.
   *
   * Flow:
   *   1. Container creates squashfs archive from the directory
   *   2. Container uploads the archive directly to R2 via presigned URL
   *   3. DO writes metadata to R2
   *   4. Container cleans up the local archive
   *
   * The returned DirectoryBackup handle is serializable. Store it anywhere
   * (KV, D1, DO storage) and pass it to restoreBackup() later.
   *
   * Concurrent backup/restore calls on the same sandbox are serialized.
   *
   * Partially-written files in the target directory may not be captured
   * consistently. Completed writes are captured.
   *
   * NOTE: Expired backups are not automatically deleted from R2. Configure
   * R2 lifecycle rules on the BACKUP_BUCKET to garbage-collect objects
   * under the `backups/` prefix after the desired retention period.
   */
  async createBackup(options: BackupOptions): Promise<DirectoryBackup> {
    if (options.localBucket) {
      return this.enqueueBackupOp(() => this.doCreateBackupLocal(options));
    }
    this.requireBackupBucket();
    return this.enqueueBackupOp(() => this.doCreateBackup(options));
  }

  private async doCreateBackup(
    options: BackupOptions
  ): Promise<DirectoryBackup> {
    const bucket = this.requireBackupBucket();
    this.requirePresignedUrlSupport();
    const {
      dir,
      name,
      ttl = BACKUP_DEFAULT_TTL_SECONDS,
      gitignore = false,
      excludes = [],
      compression,
      multipart = true
    } = options;

    const backupStartTime = Date.now();
    let backupId: string | undefined;
    let sizeBytes: number | undefined;
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    let backupSession: string | undefined;

    try {
      Sandbox.validateBackupDir(dir, 'BackupOptions.dir');
      if (name !== undefined) {
        if (typeof name !== 'string' || name.length > BACKUP_MAX_NAME_LENGTH) {
          throw new InvalidBackupConfigError({
            message: `BackupOptions.name must be a string of at most ${BACKUP_MAX_NAME_LENGTH} characters`,
            code: ErrorCode.INVALID_BACKUP_CONFIG,
            httpStatus: 400,
            context: {
              reason: `name must be a string of at most ${BACKUP_MAX_NAME_LENGTH} characters`
            },
            timestamp: new Date().toISOString()
          });
        }
        // Reject control characters (could cause issues in R2 metadata or downstream systems)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars
        if (/[\u0000-\u001f\u007f]/.test(name)) {
          throw new InvalidBackupConfigError({
            message: 'BackupOptions.name must not contain control characters',
            code: ErrorCode.INVALID_BACKUP_CONFIG,
            httpStatus: 400,
            context: { reason: 'name must not contain control characters' },
            timestamp: new Date().toISOString()
          });
        }
      }
      if (ttl <= 0) {
        throw new InvalidBackupConfigError({
          message: 'BackupOptions.ttl must be a positive number of seconds',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'ttl must be a positive number of seconds' },
          timestamp: new Date().toISOString()
        });
      }

      if (typeof gitignore !== 'boolean') {
        throw new InvalidBackupConfigError({
          message: 'BackupOptions.gitignore must be a boolean',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'gitignore must be a boolean' },
          timestamp: new Date().toISOString()
        });
      }

      if (
        !Array.isArray(excludes) ||
        !excludes.every((e: unknown) => typeof e === 'string')
      ) {
        throw new InvalidBackupConfigError({
          message: 'BackupOptions.excludes must be an array of strings',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'excludes must be an array of strings' },
          timestamp: new Date().toISOString()
        });
      }

      const resolvedCompression = this.resolveBackupCompression(compression);

      const normalizedExcludes = this.normalizeBackupExcludes(excludes);

      backupSession = await this.ensureBackupSession();
      backupId = crypto.randomUUID();
      const archivePath = `${BACKUP_CONTAINER_DIR}/${backupId}.sqsh`;

      const createResult = await this.client.backup.createArchive(
        dir,
        archivePath,
        backupSession,
        {
          gitignore,
          excludes: normalizedExcludes,
          compression: resolvedCompression
        }
      );

      if (!createResult.success) {
        throw new BackupCreateError({
          message: 'Container failed to create backup archive',
          code: ErrorCode.BACKUP_CREATE_FAILED,
          httpStatus: 500,
          context: { dir, backupId },
          timestamp: new Date().toISOString()
        });
      }

      sizeBytes = createResult.sizeBytes;
      const r2Key = `${BACKUP_STORAGE_PREFIX}/${backupId}/${BACKUP_ARCHIVE_OBJECT_NAME}`;
      const metaKey = `${BACKUP_STORAGE_PREFIX}/${backupId}/${BACKUP_METADATA_OBJECT_NAME}`;

      // Step 2: Upload archive to R2
      if (multipart && createResult.sizeBytes >= BACKUP_MULTIPART_MIN_SIZE) {
        await this.uploadBackupMultipart(
          archivePath,
          r2Key,
          createResult.sizeBytes,
          backupId,
          dir,
          backupSession
        );
      } else {
        await this.uploadBackupPresigned(
          archivePath,
          r2Key,
          createResult.sizeBytes,
          backupId,
          dir,
          backupSession
        );
      }

      // Step 3: Write metadata alongside the archive
      const metadata = {
        id: backupId,
        dir,
        name: name || null,
        sizeBytes: createResult.sizeBytes,
        ttl,
        createdAt: new Date().toISOString()
      };
      await bucket.put(metaKey, JSON.stringify(metadata));

      outcome = 'success';

      // Clean up the local archive in the container
      await this.execWithSession(
        `rm -f ${shellEscape(archivePath)}`,
        backupSession,
        { origin: 'internal' }
      ).catch(() => {});

      return { id: backupId, dir };
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      // Clean up local archive and any partially-uploaded R2 objects
      if (backupId && backupSession) {
        const archivePath = `${BACKUP_CONTAINER_DIR}/${backupId}.sqsh`;
        const r2Key = `${BACKUP_STORAGE_PREFIX}/${backupId}/${BACKUP_ARCHIVE_OBJECT_NAME}`;
        const metaKey = `${BACKUP_STORAGE_PREFIX}/${backupId}/${BACKUP_METADATA_OBJECT_NAME}`;
        await this.execWithSession(
          `rm -f ${shellEscape(archivePath)}`,
          backupSession,
          { origin: 'internal' }
        ).catch(() => {});
        await bucket.delete(r2Key).catch(() => {});
        await bucket.delete(metaKey).catch(() => {});
      }
      throw error;
    } finally {
      if (backupSession) {
        await this.client.utils.deleteSession(backupSession).catch(() => {});
      }
      logCanonicalEvent(this.logger, {
        event: 'backup.create',
        outcome,
        durationMs: Date.now() - backupStartTime,
        backupId,
        dir,
        name,
        sizeBytes,
        error: caughtError
      });
    }
  }

  /**
   * Local-dev implementation of createBackup.
   * Uses the R2 binding directly instead of presigned URLs.
   * Archive format is identical to production (squashfs + meta.json).
   */
  private async doCreateBackupLocal(
    options: BackupOptions
  ): Promise<DirectoryBackup> {
    const {
      dir,
      name,
      ttl = BACKUP_DEFAULT_TTL_SECONDS,
      gitignore = false,
      excludes = [],
      compression
    } = options;

    const backupStartTime = Date.now();
    let backupId: string | undefined;
    let sizeBytes: number | undefined;
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    let backupSession: string | undefined;

    // Resolve backup bucket from env as an R2 binding
    const envObj = this.env as Record<string, unknown>;
    const bucket = envObj.BACKUP_BUCKET;
    if (!bucket || !isR2Bucket(bucket)) {
      throw new InvalidBackupConfigError({
        message:
          'BACKUP_BUCKET R2 binding not found in env. ' +
          'Add a BACKUP_BUCKET R2 binding to your wrangler.jsonc for local backup support.',
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: 'Missing BACKUP_BUCKET R2 binding' },
        timestamp: new Date().toISOString()
      });
    }

    try {
      Sandbox.validateBackupDir(dir, 'BackupOptions.dir');
      if (name !== undefined) {
        if (typeof name !== 'string' || name.length > BACKUP_MAX_NAME_LENGTH) {
          throw new InvalidBackupConfigError({
            message: `BackupOptions.name must be a string of at most ${BACKUP_MAX_NAME_LENGTH} characters`,
            code: ErrorCode.INVALID_BACKUP_CONFIG,
            httpStatus: 400,
            context: {
              reason: `name must be a string of at most ${BACKUP_MAX_NAME_LENGTH} characters`
            },
            timestamp: new Date().toISOString()
          });
        }
        // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars
        if (/[\u0000-\u001f\u007f]/.test(name)) {
          throw new InvalidBackupConfigError({
            message: 'BackupOptions.name must not contain control characters',
            code: ErrorCode.INVALID_BACKUP_CONFIG,
            httpStatus: 400,
            context: { reason: 'name must not contain control characters' },
            timestamp: new Date().toISOString()
          });
        }
      }
      if (ttl <= 0) {
        throw new InvalidBackupConfigError({
          message: 'BackupOptions.ttl must be a positive number of seconds',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'ttl must be a positive number of seconds' },
          timestamp: new Date().toISOString()
        });
      }
      if (typeof gitignore !== 'boolean') {
        throw new InvalidBackupConfigError({
          message: 'BackupOptions.gitignore must be a boolean',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'gitignore must be a boolean' },
          timestamp: new Date().toISOString()
        });
      }
      if (
        !Array.isArray(excludes) ||
        !excludes.every((e: unknown) => typeof e === 'string')
      ) {
        throw new InvalidBackupConfigError({
          message: 'BackupOptions.excludes must be an array of strings',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'excludes must be an array of strings' },
          timestamp: new Date().toISOString()
        });
      }

      const resolvedCompression = this.resolveBackupCompression(compression);

      const normalizedExcludes = this.normalizeBackupExcludes(excludes);

      backupSession = await this.ensureBackupSession();
      backupId = crypto.randomUUID();
      const archivePath = `${BACKUP_CONTAINER_DIR}/${backupId}.sqsh`;

      // Step 1: Create squashfs archive in the container (same as production)
      const createResult = await this.client.backup.createArchive(
        dir,
        archivePath,
        backupSession,
        {
          gitignore,
          excludes: normalizedExcludes,
          compression: resolvedCompression
        }
      );

      if (!createResult.success) {
        throw new BackupCreateError({
          message: 'Container failed to create backup archive',
          code: ErrorCode.BACKUP_CREATE_FAILED,
          httpStatus: 500,
          context: { dir, backupId },
          timestamp: new Date().toISOString()
        });
      }

      sizeBytes = createResult.sizeBytes;
      const r2Key = `${BACKUP_STORAGE_PREFIX}/${backupId}/${BACKUP_ARCHIVE_OBJECT_NAME}`;
      const metaKey = `${BACKUP_STORAGE_PREFIX}/${backupId}/${BACKUP_METADATA_OBJECT_NAME}`;

      // Step 2: Read archive from container and stream it into R2 via binding.
      // readFileStream returns SSE-framed base64 chunks, so we pipe it through
      // streamFile (which decodes SSE frames + base64 on the fly) into a
      // FixedLengthStream backed by the known archive size. This avoids
      // buffering the whole archive in Worker memory.
      const archiveStream = await this.client.files.readFileStream(
        archivePath,
        backupSession
      );
      const sseDecoded = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const chunk of streamFile(archiveStream)) {
              if (chunk instanceof Uint8Array) {
                controller.enqueue(chunk);
              }
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        }
      });
      const fixedStream = new FixedLengthStream(createResult.sizeBytes);
      sseDecoded.pipeTo(fixedStream.writable).catch(() => {});
      await bucket.put(r2Key, fixedStream.readable);

      // Verify upload — size comes from createArchive result, not the stream.
      const head = await bucket.head(r2Key);
      if (!head || head.size !== createResult.sizeBytes) {
        throw new BackupCreateError({
          message: `Upload verification failed: expected ${createResult.sizeBytes} bytes, got ${head?.size ?? 0}`,
          code: ErrorCode.BACKUP_CREATE_FAILED,
          httpStatus: 500,
          context: { dir, backupId },
          timestamp: new Date().toISOString()
        });
      }

      // Step 3: Write metadata
      const metadata = {
        id: backupId,
        dir,
        name: name || null,
        sizeBytes: createResult.sizeBytes,
        ttl,
        createdAt: new Date().toISOString()
      };
      await bucket.put(metaKey, JSON.stringify(metadata));

      outcome = 'success';

      // Clean up local archive
      await this.execWithSession(
        `rm -f ${shellEscape(archivePath)}`,
        backupSession,
        { origin: 'internal' }
      ).catch(() => {});

      return { id: backupId, dir, localBucket: true };
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      if (backupId && backupSession) {
        const archivePath = `${BACKUP_CONTAINER_DIR}/${backupId}.sqsh`;
        const r2Key = `${BACKUP_STORAGE_PREFIX}/${backupId}/${BACKUP_ARCHIVE_OBJECT_NAME}`;
        const metaKey = `${BACKUP_STORAGE_PREFIX}/${backupId}/${BACKUP_METADATA_OBJECT_NAME}`;
        await this.execWithSession(
          `rm -f ${shellEscape(archivePath)}`,
          backupSession,
          { origin: 'internal' }
        ).catch(() => {});
        await bucket.delete(r2Key).catch(() => {});
        await bucket.delete(metaKey).catch(() => {});
      }
      throw error;
    } finally {
      if (backupSession) {
        await this.client.utils.deleteSession(backupSession).catch(() => {});
      }
      logCanonicalEvent(this.logger, {
        event: 'backup.create',
        outcome,
        durationMs: Date.now() - backupStartTime,
        backupId,
        dir,
        name,
        sizeBytes,
        provider: 'local-binding',
        error: caughtError
      });
    }
  }

  /**
   * Restore a backup from R2 into a directory.
   *
   * **Production flow** (`localBucket` not set):
   *   1. DO reads metadata from R2 and checks TTL
   *   2. Container mounts the backup archive from R2 via s3fs
   *   3. Container mounts the squashfs archive with FUSE overlayfs
   *
   * The target directory becomes an overlay mount with the backup as a
   * read-only lower layer and a writable upper layer for copy-on-write.
   * Any processes writing to the directory should be stopped first.
   *
   * **Mount Lifecycle**: The FUSE overlay mount persists only while the
   * container is running. When the sandbox sleeps or the container restarts,
   * the mount is lost and the directory becomes empty. Re-restore from the
   * backup handle to recover. This is an ephemeral restore, not a persistent
   * extraction.
   *
   * **Local-dev flow** (`localBucket: true` on the originating `createBackup` call):
   *   1. DO reads metadata and checks TTL via R2 binding
   *   2. DO downloads the archive from R2 and writes it to the container
   *   3. Container extracts the archive with `unsquashfs` (no FUSE needed)
   *
   * The backup is restored into `backup.dir`. This may differ from the
   * directory that was originally backed up, allowing cross-directory restore.
   *
   * Overlapping backups are independent: restoring a parent directory
   * overwrites everything inside it, including subdirectories that were
   * backed up separately. When restoring both, restore the parent first.
   *
   * Concurrent backup/restore calls on the same sandbox are serialized.
   */
  async restoreBackup(backup: DirectoryBackup): Promise<RestoreBackupResult> {
    if (backup.localBucket) {
      return this.enqueueBackupOp(() => this.doRestoreBackupLocal(backup));
    }
    this.requireBackupBucket();
    return this.enqueueBackupOp(() => this.doRestoreBackup(backup));
  }

  private async doRestoreBackup(
    backup: DirectoryBackup
  ): Promise<RestoreBackupResult> {
    const restoreStartTime = Date.now();
    const bucket = this.requireBackupBucket();
    this.requirePresignedUrlSupport();
    const { id, dir } = backup;

    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    let backupSession: string | undefined;

    try {
      // Validate user-provided inputs (DirectoryBackup is deserialized from external storage)
      if (!id || typeof id !== 'string') {
        throw new InvalidBackupConfigError({
          message: 'Invalid backup: missing or invalid id',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'missing or invalid id' },
          timestamp: new Date().toISOString()
        });
      }
      if (!Sandbox.UUID_REGEX.test(id)) {
        throw new InvalidBackupConfigError({
          message:
            'Invalid backup: id must be a valid UUID (e.g. from createBackup)',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'id must be a valid UUID' },
          timestamp: new Date().toISOString()
        });
      }
      Sandbox.validateBackupDir(dir, 'Invalid backup: dir');

      // Step 1: Read metadata to check TTL
      const metaKey = `${BACKUP_STORAGE_PREFIX}/${id}/${BACKUP_METADATA_OBJECT_NAME}`;
      const metaObject = await bucket.get(metaKey);
      if (!metaObject) {
        throw new BackupNotFoundError({
          message:
            `Backup not found: ${id}. ` +
            'Verify the backup ID is correct and the backup has not been deleted.',
          code: ErrorCode.BACKUP_NOT_FOUND,
          httpStatus: 404,
          context: { backupId: id },
          timestamp: new Date().toISOString()
        });
      }

      const metadata = await metaObject.json<{
        ttl: number;
        createdAt: string;
        dir: string;
      }>();

      // Check TTL with 60-second buffer to prevent race between check and restore completion
      const TTL_BUFFER_MS = 60 * 1000;
      const createdAt = new Date(metadata.createdAt).getTime();
      if (Number.isNaN(createdAt)) {
        throw new BackupRestoreError({
          message: `Backup metadata has invalid createdAt timestamp: ${metadata.createdAt}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          httpStatus: 500,
          context: { dir, backupId: id },
          timestamp: new Date().toISOString()
        });
      }
      const expiresAt = createdAt + metadata.ttl * 1000;
      if (Date.now() + TTL_BUFFER_MS > expiresAt) {
        throw new BackupExpiredError({
          message:
            `Backup ${id} has expired ` +
            `(created: ${metadata.createdAt}, TTL: ${metadata.ttl}s). ` +
            'Create a new backup.',
          code: ErrorCode.BACKUP_EXPIRED,
          httpStatus: 400,
          context: {
            backupId: id,
            expiredAt: new Date(expiresAt).toISOString()
          },
          timestamp: new Date().toISOString()
        });
      }

      // Step 2: Check archive exists and get its size via HEAD (no body stream)
      const r2Key = `${BACKUP_STORAGE_PREFIX}/${id}/${BACKUP_ARCHIVE_OBJECT_NAME}`;
      const archiveHead = await bucket.head(r2Key);
      if (!archiveHead) {
        throw new BackupNotFoundError({
          message:
            `Backup archive not found in R2: ${id}. ` +
            'The archive may have been deleted by R2 lifecycle rules.',
          code: ErrorCode.BACKUP_NOT_FOUND,
          httpStatus: 404,
          context: { backupId: id },
          timestamp: new Date().toISOString()
        });
      }

      backupSession = await this.ensureBackupSession();
      const archivePath = `${BACKUP_CONTAINER_DIR}/${id}.sqsh`;

      // Step 3: Tear down existing FUSE mounts before overwriting the archive.
      // squashfuse holds the .sqsh file open; writing a new archive to the same
      // path while the old mount is active corrupts the backing store.
      // Unmount the overlay on dir, then iterate over all mount bases for this
      // backup (both suffixed UUID_* and legacy unsuffixed UUID) and unmount
      // their squashfuse lower dirs.
      const mountGlob = `${BACKUP_CONTAINER_DIR}/mounts/${id}`;
      await this.execWithSession(
        `/usr/bin/fusermount3 -uz ${shellEscape(dir)} 2>/dev/null || true`,
        backupSession,
        { origin: 'internal' }
      ).catch(() => {});
      await this.execWithSession(
        `for d in ${shellEscape(mountGlob)}_*/lower ${shellEscape(mountGlob)}/lower; do [ -d "$d" ] && /usr/bin/fusermount3 -uz "$d" 2>/dev/null; done; true`,
        backupSession,
        { origin: 'internal' }
      ).catch(() => {});

      // Step 4: Write archive to the container (skip if already present and
      // same size — avoids overwriting a file that a lazily-unmounted
      // squashfuse may still hold open).
      const sizeCheck = await this.execWithSession(
        `stat -c %s ${shellEscape(archivePath)} 2>/dev/null || echo 0`,
        backupSession,
        { origin: 'internal' }
      ).catch(() => ({ stdout: '0' }));
      const existingSize = Number.parseInt(
        (sizeCheck.stdout ?? '0').trim(),
        10
      );

      if (existingSize !== archiveHead.size) {
        await this.downloadBackupParallel(
          archivePath,
          r2Key,
          archiveHead.size,
          id,
          dir,
          backupSession
        );
      }

      const restoreResult = await this.client.backup.restoreArchive(
        dir,
        archivePath,
        backupSession
      );

      if (!restoreResult.success) {
        throw new BackupRestoreError({
          message: 'Container failed to restore backup archive',
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          httpStatus: 500,
          context: { dir, backupId: id },
          timestamp: new Date().toISOString()
        });
      }

      outcome = 'success';

      return {
        success: true,
        dir,
        id
      };
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      if (id && backupSession) {
        const cleanupPath = `${BACKUP_CONTAINER_DIR}/${id}.sqsh`;
        await this.execWithSession(
          `rm -f ${shellEscape(cleanupPath)}`,
          backupSession,
          { origin: 'internal' }
        ).catch(() => {});
      }
      throw error;
    } finally {
      if (backupSession) {
        await this.client.utils.deleteSession(backupSession).catch(() => {});
      }
      logCanonicalEvent(this.logger, {
        event: 'backup.restore',
        outcome,
        durationMs: Date.now() - restoreStartTime,
        backupId: id,
        dir,
        error: caughtError
      });
    }
  }

  /**
   * Local-dev implementation of restoreBackup.
   * Uses the R2 binding directly instead of presigned URLs, and
   * unsquashfs for extraction instead of squashfuse + fuse-overlayfs.
   */
  private async doRestoreBackupLocal(
    backup: DirectoryBackup
  ): Promise<RestoreBackupResult> {
    const restoreStartTime = Date.now();
    const { id, dir } = backup;

    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    let backupSession: string | undefined;

    // Resolve backup bucket from env as an R2 binding
    const envObj = this.env as Record<string, unknown>;
    const bucket = envObj.BACKUP_BUCKET;
    if (!bucket || !isR2Bucket(bucket)) {
      throw new InvalidBackupConfigError({
        message:
          'BACKUP_BUCKET R2 binding not found in env. ' +
          'Add a BACKUP_BUCKET R2 binding to your wrangler.jsonc for local backup support.',
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: 'Missing BACKUP_BUCKET R2 binding' },
        timestamp: new Date().toISOString()
      });
    }

    try {
      // Validate user-provided inputs
      if (!id || typeof id !== 'string') {
        throw new InvalidBackupConfigError({
          message: 'Invalid backup: missing or invalid id',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'missing or invalid id' },
          timestamp: new Date().toISOString()
        });
      }
      if (!Sandbox.UUID_REGEX.test(id)) {
        throw new InvalidBackupConfigError({
          message:
            'Invalid backup: id must be a valid UUID (e.g. from createBackup)',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'id must be a valid UUID' },
          timestamp: new Date().toISOString()
        });
      }
      Sandbox.validateBackupDir(dir, 'Invalid backup: dir');

      // Step 1: Read metadata to check TTL
      const metaKey = `${BACKUP_STORAGE_PREFIX}/${id}/${BACKUP_METADATA_OBJECT_NAME}`;
      const metaObject = await bucket.get(metaKey);
      if (!metaObject) {
        throw new BackupNotFoundError({
          message:
            `Backup not found: ${id}. ` +
            'Verify the backup ID is correct and the backup has not been deleted.',
          code: ErrorCode.BACKUP_NOT_FOUND,
          httpStatus: 404,
          context: { backupId: id },
          timestamp: new Date().toISOString()
        });
      }

      const metadata = await metaObject.json<{
        ttl: number;
        createdAt: string;
        dir: string;
      }>();

      // Check TTL with 60-second buffer
      const TTL_BUFFER_MS = 60 * 1000;
      const createdAt = new Date(metadata.createdAt).getTime();
      if (Number.isNaN(createdAt)) {
        throw new BackupRestoreError({
          message: `Backup metadata has invalid createdAt timestamp: ${metadata.createdAt}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          httpStatus: 500,
          context: { dir, backupId: id },
          timestamp: new Date().toISOString()
        });
      }
      const expiresAt = createdAt + metadata.ttl * 1000;
      if (Date.now() + TTL_BUFFER_MS > expiresAt) {
        throw new BackupExpiredError({
          message:
            `Backup ${id} has expired ` +
            `(created: ${metadata.createdAt}, TTL: ${metadata.ttl}s). ` +
            'Create a new backup.',
          code: ErrorCode.BACKUP_EXPIRED,
          httpStatus: 400,
          context: {
            backupId: id,
            expiredAt: new Date(expiresAt).toISOString()
          },
          timestamp: new Date().toISOString()
        });
      }

      // Step 2: Download archive from R2 via binding and write to container
      const r2Key = `${BACKUP_STORAGE_PREFIX}/${id}/${BACKUP_ARCHIVE_OBJECT_NAME}`;
      const archiveObject = await bucket.get(r2Key);
      if (!archiveObject) {
        throw new BackupNotFoundError({
          message:
            `Backup archive not found in R2: ${id}. ` +
            'The archive may have been deleted by R2 lifecycle rules.',
          code: ErrorCode.BACKUP_NOT_FOUND,
          httpStatus: 404,
          context: { backupId: id },
          timestamp: new Date().toISOString()
        });
      }

      backupSession = await this.ensureBackupSession();
      const archivePath = `${BACKUP_CONTAINER_DIR}/${id}.sqsh`;

      // Ensure backup directory exists
      await this.execWithSession(
        `mkdir -p ${BACKUP_CONTAINER_DIR}`,
        backupSession,
        { origin: 'internal' }
      );

      // Write the archive into the container.
      // On the rpc transport, stream R2ObjectBody.body directly via
      // writeFileStream to avoid base64-encoding the whole archive in Worker
      // memory and hitting workerd's 32 MiB RPC payload cap.
      // On http/websocket transports, fall back to the base64 writeFile path
      // (those transports send via HTTP POST to the container, no RPC cap).
      if (this.transport === 'rpc') {
        const body = archiveObject.body;
        if (!body) {
          throw new BackupRestoreError({
            message: `R2 archive object has no body stream for backup ${id}`,
            code: ErrorCode.BACKUP_RESTORE_FAILED,
            httpStatus: 500,
            context: { dir, backupId: id },
            timestamp: new Date().toISOString()
          });
        }
        await this.client.files.writeFileStream(
          archivePath,
          body,
          backupSession
        );
      } else {
        const archiveBuffer = await archiveObject.arrayBuffer();
        const base64Content = Buffer.from(archiveBuffer).toString('base64');
        const writeResult = await this.client.files.writeFile(
          archivePath,
          base64Content,
          backupSession,
          { encoding: 'base64' }
        );
        if (!writeResult.success) {
          const writeErrorMessage =
            'error' in writeResult &&
            typeof writeResult.error === 'object' &&
            writeResult.error !== null &&
            'message' in writeResult.error &&
            typeof writeResult.error.message === 'string'
              ? writeResult.error.message
              : `File write returned success: false for '${archivePath}'`;
          throw new BackupRestoreError({
            message: `Failed to write backup archive to ${archivePath}: ${writeErrorMessage}`,
            code: ErrorCode.BACKUP_RESTORE_FAILED,
            httpStatus: 500,
            context: { dir, backupId: id },
            timestamp: new Date().toISOString()
          });
        }
      }

      // Step 3: Extract archive using unsquashfs (no FUSE needed)
      const extractResult = await this.execWithSession(
        `/usr/bin/unsquashfs -f -d ${shellEscape(dir)} ${shellEscape(archivePath)}`,
        backupSession,
        { origin: 'internal' }
      );

      if (extractResult.exitCode !== 0) {
        throw new BackupRestoreError({
          message: `unsquashfs extraction failed (exit code ${extractResult.exitCode}): ${extractResult.stderr}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          httpStatus: 500,
          context: { dir, backupId: id },
          timestamp: new Date().toISOString()
        });
      }

      // Clean up archive after extraction (no FUSE mount holds it open)
      await this.execWithSession(
        `rm -f ${shellEscape(archivePath)}`,
        backupSession,
        { origin: 'internal' }
      ).catch(() => {});

      outcome = 'success';

      return {
        success: true,
        dir,
        id
      };
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      if (id && backupSession) {
        const archivePath = `${BACKUP_CONTAINER_DIR}/${id}.sqsh`;
        await this.execWithSession(
          `rm -f ${shellEscape(archivePath)}`,
          backupSession,
          { origin: 'internal' }
        ).catch(() => {});
      }
      throw error;
    } finally {
      if (backupSession) {
        await this.client.utils.deleteSession(backupSession).catch(() => {});
      }
      logCanonicalEvent(this.logger, {
        event: 'backup.restore',
        outcome,
        durationMs: Date.now() - restoreStartTime,
        backupId: id,
        dir,
        provider: 'local-binding',
        error: caughtError
      });
    }
  }

  private async configureR2EgressOutbound(
    params: R2EgressParams
  ): Promise<void> {
    const ctx = this.ctx as R2EgressContainerState;
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

    const fetcher = ctx.exports.ContainerProxy({
      props: {
        enableInternet: this.enableInternet,
        containerId: this.ctx.id.toString(),
        className: R2_EGRESS_PROXY_TARGET_CLASS_NAME,
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
}
