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
  ISandbox,
  LocalMountBucketOptions,
  LogEvent,
  MountBucketOptions,
  PortWatchEvent,
  Process,
  ProcessOptions,
  ProcessStatus,
  PtyOptions,
  RemoteMountBucketOptions,
  RestoreBackupResult,
  RunCodeOptions,
  SandboxOptions,
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
  isTerminalStatus,
  logCanonicalEvent,
  partitionEnvVars,
  type SessionDeleteResult,
  shellEscape,
  TraceContext
} from '@repo/shared';
import { BACKUP_ALLOWED_PREFIXES } from '@repo/shared/backup';
import { AwsClient } from 'aws4fetch';
import { type Desktop, type ExecuteResponse, SandboxClient } from './clients';
import type { ErrorResponse } from './errors';
import {
  BackupCreateError,
  BackupExpiredError,
  BackupNotFoundError,
  BackupRestoreError,
  CustomDomainRequiredError,
  ErrorCode,
  InvalidBackupConfigError,
  ProcessExitedBeforeReadyError,
  ProcessReadyTimeoutError,
  SessionAlreadyExistsError
} from './errors';
import { CodeInterpreter } from './interpreter';
import { LocalMountSyncManager } from './local-mount-sync';
import { proxyTerminal } from './pty';
import { isLocalhostPattern } from './request-handler';
import { SecurityError, sanitizeSandboxId, validatePort } from './security';
import { parseSSEStream } from './sse-parser';
import {
  buildS3fsSource,
  detectCredentials,
  detectProviderFromUrl,
  resolveS3fsOptions,
  validateBucketName,
  validatePrefix
} from './storage-mount';
import {
  InvalidMountConfigError,
  S3FSMountError
} from './storage-mount/errors';
import type {
  FuseMountInfo,
  LocalSyncMountInfo,
  MountInfo
} from './storage-mount/types';
import { SDK_VERSION } from './version';

type SandboxConfiguration = {
  sandboxName?: {
    name: string;
    normalizeId?: boolean;
  };
  baseUrl?: string;
  sleepAfter?: string | number;
  keepAlive?: boolean;
  containerTimeouts?: NonNullable<SandboxOptions['containerTimeouts']>;
};

type CachedSandboxConfiguration = {
  sandboxName?: string;
  normalizeId?: boolean;
  baseUrl?: string;
  sleepAfter?: string | number;
  keepAlive?: boolean;
  containerTimeouts?: NonNullable<SandboxOptions['containerTimeouts']>;
};

type ConfigurableSandboxStub = {
  configure?: (configuration: SandboxConfiguration) => Promise<void>;
  setSandboxName?: (name: string, normalizeId?: boolean) => Promise<void>;
  setBaseUrl?: (baseUrl: string) => Promise<void>;
  setSleepAfter?: (sleepAfter: string | number) => Promise<void>;
  setKeepAlive?: (keepAlive: boolean) => Promise<void>;
  setContainerTimeouts?: (
    timeouts: NonNullable<SandboxOptions['containerTimeouts']>
  ) => Promise<void>;
};

const sandboxConfigurationCache = new WeakMap<
  object,
  Map<string, CachedSandboxConfiguration>
>();

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

  if (options?.baseUrl !== undefined && cached?.baseUrl !== options.baseUrl) {
    configuration.baseUrl = options.baseUrl;
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
    configuration.baseUrl !== undefined ||
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
    ...(configuration.baseUrl !== undefined && {
      baseUrl: configuration.baseUrl
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

  if (configuration.baseUrl !== undefined) {
    operations.push(
      stub.setBaseUrl?.(configuration.baseUrl) ?? Promise.resolve()
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
    // to the DO's callDesktop() method, avoiding RPC pipelining through getters.
    desktop: new Proxy({} as Desktop, {
      get(_, method) {
        if (typeof method !== 'string' || method === 'then') return undefined;
        return (...args: unknown[]) => stub.callDesktop(method, args);
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
      throw new SecurityError(
        `Invalid port number: ${port}. Must be 1024-65535, excluding 3000 (sandbox control plane).`
      );
    }
    const portSwitchedRequest = switchPort(request, port);
    return await stub.fetch(portSwitchedRequest);
  };
}

/**
 * Type guard for R2Bucket binding.
 * Checks for the minimal R2Bucket interface methods we use.
 */
function isR2Bucket(value: unknown): value is R2Bucket {
  return (
    typeof value === 'object' &&
    value !== null &&
    'put' in value &&
    typeof (value as Record<string, unknown>).put === 'function' &&
    'get' in value &&
    typeof (value as Record<string, unknown>).get === 'function' &&
    'head' in value &&
    typeof (value as Record<string, unknown>).head === 'function' &&
    'delete' in value &&
    typeof (value as Record<string, unknown>).delete === 'function'
  );
}

export class Sandbox<Env = unknown> extends Container<Env> implements ISandbox {
  defaultPort = 3000; // Default port for the container's Bun server
  sleepAfter: string | number = '10m'; // Sleep the sandbox if no requests are made in this timeframe

  client: SandboxClient;
  private codeInterpreter: CodeInterpreter;
  private sandboxName: string | null = null;
  private normalizeId: boolean = false;
  private baseUrl: string | null = null;
  private defaultSession: string | null = null;
  envVars: Record<string, string> = {};
  private logger: ReturnType<typeof createLogger>;
  private keepAliveEnabled: boolean = false;
  private activeMounts: Map<string, MountInfo> = new Map();
  private transport: 'http' | 'websocket' = 'http';

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
   * through property getters.
   */
  async callDesktop(method: string, args: unknown[]): Promise<unknown> {
    if (!Sandbox.DESKTOP_METHODS.has(method)) {
      throw new Error(`Unknown desktop method: ${method}`);
    }
    const client = this.client.desktop;
    const fn = client[method as keyof typeof client];
    if (typeof fn !== 'function') {
      throw new Error(`Unknown desktop method: ${method}`);
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
   * Create a SandboxClient with current transport settings
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
    if (transportEnv === 'websocket') {
      this.transport = 'websocket';
    } else if (transportEnv != null && transportEnv !== 'http') {
      this.logger.warn(
        `Invalid SANDBOX_TRANSPORT value: "${transportEnv}". Must be "http" or "websocket". Defaulting to "http".`
      );
    }

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

    // Create client with transport based on env var (may be updated from storage)
    this.client = this.createSandboxClient();

    // Initialize code interpreter - pass 'this' after client is ready
    // The CodeInterpreter extracts client.interpreter from the sandbox
    this.codeInterpreter = new CodeInterpreter(this);

    this.ctx.blockConcurrencyWhile(async () => {
      this.sandboxName =
        (await this.ctx.storage.get<string>('sandboxName')) || null;
      this.normalizeId =
        (await this.ctx.storage.get<boolean>('normalizeId')) || false;
      this.defaultSession =
        (await this.ctx.storage.get<string>('defaultSession')) || null;
      this.keepAliveEnabled =
        (await this.ctx.storage.get<boolean>('keepAliveEnabled')) || false;

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

      // @ts-expect-error - interceptHttps is supplied by the container primitive subclass shape
      if (this.interceptHttps) {
        this.envVars = { ...this.envVars, SANDBOX_INTERCEPT_HTTPS: '1' };
      }
    });
  }

  async setSandboxName(name: string, normalizeId?: boolean): Promise<void> {
    if (!this.sandboxName) {
      this.sandboxName = name;
      this.normalizeId = normalizeId || false;
      await this.ctx.storage.put('sandboxName', name);
      await this.ctx.storage.put('normalizeId', this.normalizeId);
    }
  }

  async configure(configuration: SandboxConfiguration): Promise<void> {
    if (configuration.sandboxName) {
      await this.setSandboxName(
        configuration.sandboxName.name,
        configuration.sandboxName.normalizeId
      );
    }

    if (configuration.baseUrl !== undefined) {
      await this.setBaseUrl(configuration.baseUrl);
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

  // RPC method to set the base URL
  async setBaseUrl(baseUrl: string): Promise<void> {
    if (!this.baseUrl) {
      this.baseUrl = baseUrl;
      await this.ctx.storage.put('baseUrl', baseUrl);
    } else {
      if (this.baseUrl !== baseUrl) {
        throw new Error(
          'Base URL already set and different from one previously provided'
        );
      }
    }
  }

  // RPC method to set the sleep timeout
  async setSleepAfter(sleepAfter: string | number): Promise<void> {
    this.sleepAfter = sleepAfter;
    await this.ctx.storage.put('sleepAfter', sleepAfter);
    // Reschedule activity timeout to apply the new sleepAfter value immediately
    this.renewActivityTimeout();
  }

  // RPC method to enable keepAlive mode
  async setKeepAlive(keepAlive: boolean): Promise<void> {
    this.keepAliveEnabled = keepAlive;
    await this.ctx.storage.put('keepAliveEnabled', keepAlive);

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

  /**
   * RPC method to configure container startup timeouts
   */
  async setContainerTimeouts(
    timeouts: NonNullable<SandboxOptions['containerTimeouts']>
  ): Promise<void> {
    const validated = { ...this.containerTimeouts };

    // Validate each timeout if provided
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

    this.containerTimeouts = validated;

    // Persist to storage
    await this.ctx.storage.put('containerTimeouts', this.containerTimeouts);

    // Update the transport retry budget to reflect new timeouts
    this.client.setRetryTimeoutMs(this.computeRetryTimeoutMs());

    this.logger.debug('Container timeouts updated', this.containerTimeouts);
  }

  /**
   * Validate a timeout value is within acceptable range
   * Throws error if invalid - used for user-provided values
   */
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

  /**
   * Get default timeouts with env var fallbacks and validation
   * Precedence: SDK defaults < Env vars < User config
   */
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
        5_000, // Min 5s
        300_000 // Max 5min
      ),
      portReadyTimeoutMS: parseAndValidate(
        getEnvString(env, 'SANDBOX_PORT_TIMEOUT_MS'),
        'portReadyTimeoutMS',
        10_000, // Min 10s
        600_000 // Max 10min
      ),
      waitIntervalMS: parseAndValidate(
        getEnvString(env, 'SANDBOX_POLL_INTERVAL_MS'),
        'waitIntervalMS',
        100, // Min 100ms
        5_000 // Max 5s
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
    if ('localBucket' in options && options.localBucket) {
      await this.mountBucketLocal(bucket, mountPath, options);
      return;
    }

    await this.mountBucketFuse(
      bucket,
      mountPath,
      options as RemoteMountBucketOptions
    );
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

  /**
   * Production mount: S3FS-FUSE inside the container
   */
  private async mountBucketFuse(
    bucket: string,
    mountPath: string,
    options: RemoteMountBucketOptions
  ): Promise<void> {
    const mountStartTime = Date.now();
    const prefix = options.prefix || undefined;
    let mountOutcome: 'success' | 'error' = 'error';
    let mountError: Error | undefined;
    let passwordFilePath: string | undefined;
    let provider: BucketProvider | null = null;
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

      // Create mount directory
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
          await this.execInternal(`fusermount -u ${shellEscape(mountPath)}`);
          mountInfo.mounted = false;

          // Only remove from tracking if unmount succeeded
          this.activeMounts.delete(mountPath);
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
   * Validate mount options
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

    // Validate mount path is absolute
    if (!mountPath.startsWith('/')) {
      throw new InvalidMountConfigError(
        `Mount path must be absolute (start with /): "${mountPath}"`
      );
    }

    // Check for duplicate mount path
    if (this.activeMounts.has(mountPath)) {
      const existingMount = this.activeMounts.get(mountPath);
      throw new InvalidMountConfigError(
        `Mount path "${mountPath}" is already in use by bucket "${existingMount?.bucket}". ` +
          `Unmount the existing bucket first or use a different mount path.`
      );
    }

    // Validate prefix format if provided
    if (options.prefix !== undefined) {
      validatePrefix(options.prefix);
    }
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

    await this.writeFile(passwordFilePath, content);

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
    passwordFilePath: string
  ): Promise<void> {
    // Resolve s3fs options (provider defaults + user overrides)
    const resolvedOptions = resolveS3fsOptions(provider, options.s3fsOptions);

    // Build s3fs mount command
    const s3fsArgs: string[] = [];

    // Add password file option FIRST
    s3fsArgs.push(`passwd_file=${passwordFilePath}`);

    // Add resolved provider-specific and user options
    s3fsArgs.push(...resolvedOptions);

    // Add read-only flag if requested
    if (options.readOnly) {
      s3fsArgs.push('ro');
    }

    // Add endpoint URL
    s3fsArgs.push(`url=${options.endpoint}`);

    // Build final command with escaped options
    const optionsStr = shellEscape(s3fsArgs.join(','));
    const mountCmd = `s3fs ${shellEscape(bucket)} ${shellEscape(mountPath)} -o ${optionsStr}`;

    // Execute mount command
    const result = await this.execInternal(mountCmd);

    if (result.exitCode !== 0) {
      throw new S3FSMountError(
        `S3FS mount failed: ${result.stderr || result.stdout || 'Unknown error'}`
      );
    }
  }

  /**
   * Cleanup and destroy the sandbox container
   */
  override async destroy(): Promise<void> {
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

      // Disconnect WebSocket transport if active
      this.client.disconnect();

      // Unmount all mounted buckets and cleanup
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
          if (mountInfo.mounted) {
            try {
              this.logger.debug(
                `Unmounting bucket ${mountInfo.bucket} from ${mountPath}`
              );
              await this.execInternal(
                `fusermount -u ${shellEscape(mountPath)}`
              );
              mountInfo.mounted = false;
            } catch (error) {
              mountFailures++;
              const errorMsg =
                error instanceof Error ? error.message : String(error);
              this.logger.warn(
                `Failed to unmount bucket ${mountInfo.bucket} from ${mountPath}: ${errorMsg}`
              );
            }
          }

          // Always cleanup password file for FUSE mounts
          await this.deletePasswordFile(mountInfo.passwordFilePath);
        }
      }

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

  override onStart() {
    this.logger.debug('Sandbox started');

    // Check version compatibility asynchronously (don't block startup)
    this.checkVersionCompatibility().catch((error) => {
      this.logger.error(
        'Version compatibility check failed',
        error instanceof Error ? error : new Error(String(error))
      );
    });
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

    // Stop local sync managers before clearing the map to avoid leaking timers
    for (const [, m] of this.activeMounts) {
      if (m.mountType === 'local-sync')
        await m.syncManager.stop().catch(() => {});
    }

    this.defaultSession = null;
    this.activeMounts.clear();

    // Persist cleanup to storage so state is clean on next container start
    await Promise.all([
      this.ctx.storage.delete('portTokens'),
      this.ctx.storage.delete('defaultSession')
    ]);
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
   * Ensure default session exists - lazy initialization
   * This is called automatically by all public methods that need a session
   *
   * The session ID is persisted to DO storage. On container restart, if the
   * container already has this session (from a previous instance), we sync
   * our state rather than failing on duplicate creation.
   */
  private async ensureDefaultSession(): Promise<string> {
    const sessionId = `sandbox-${this.sandboxName || 'default'}`;

    // Fast path: session already initialized in this instance
    if (this.defaultSession === sessionId) {
      return this.defaultSession;
    }

    // Create session in container
    try {
      await this.client.utils.createSession({
        id: sessionId,
        env: this.envVars || {},
        cwd: '/workspace'
      });

      this.defaultSession = sessionId;
      await this.ctx.storage.put('defaultSession', sessionId);
      this.logger.debug('Default session initialized', { sessionId });
    } catch (error: unknown) {
      // Session may already exist (e.g., after hot reload or concurrent request)
      if (error instanceof SessionAlreadyExistsError) {
        this.logger.debug(
          'Session exists in container but not in DO state, syncing',
          { sessionId }
        );
        this.defaultSession = sessionId;
        await this.ctx.storage.put('defaultSession', sessionId);
      } else {
        throw error;
      }
    }

    return this.defaultSession;
  }

  // Enhanced exec method - always returns ExecResult with optional streaming
  // This replaces the old exec method to match ISandbox interface
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const session = await this.ensureDefaultSession();
    return this.execWithSession(command, session, options);
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
        const commandOptions =
          options &&
          (options.timeout !== undefined ||
            options.env !== undefined ||
            options.cwd !== undefined ||
            options.origin !== undefined)
            ? {
                timeoutMs: options.timeout,
                env: options.env,
                cwd: options.cwd,
                origin: options.origin
              }
            : undefined;

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
    sessionId: string
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
      const session = sessionId ?? (await this.ensureDefaultSession());
      const requestOptions = {
        ...(options?.processId !== undefined && {
          processId: options.processId
        }),
        ...(options?.timeout !== undefined && { timeoutMs: options.timeout }),
        ...(options?.env !== undefined && { env: filterEnvVars(options.env) }),
        ...(options?.cwd !== undefined && { cwd: options.cwd }),
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
    const session = sessionId ?? (await this.ensureDefaultSession());
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
    const session = sessionId ?? (await this.ensureDefaultSession());
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
  }

  async killProcess(
    id: string,
    signal?: string,
    sessionId?: string
  ): Promise<void> {
    // Note: signal parameter is not currently supported by the HTTP client
    await this.client.processes.killProcess(id);
  }

  async killAllProcesses(sessionId?: string): Promise<number> {
    const response = await this.client.processes.killAllProcesses();
    return response.cleanedCount;
  }

  async cleanupCompletedProcesses(sessionId?: string): Promise<number> {
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

    const session = await this.ensureDefaultSession();
    // Get the stream from CommandClient
    return this.client.commands.executeStream(command, session, {
      timeoutMs: options?.timeout,
      env: options?.env,
      cwd: options?.cwd
    });
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

    return this.client.commands.executeStream(command, sessionId, {
      timeoutMs: options?.timeout,
      env: options?.env,
      cwd: options?.cwd
    });
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
    }
  ) {
    const session = options?.sessionId ?? (await this.ensureDefaultSession());
    return this.client.git.checkout(repoUrl, session, {
      branch: options?.branch,
      targetDir: options?.targetDir,
      depth: options?.depth
    });
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean; sessionId?: string } = {}
  ) {
    const session = options.sessionId ?? (await this.ensureDefaultSession());
    return this.client.files.mkdir(path, session, {
      recursive: options.recursive
    });
  }

  async writeFile(
    path: string,
    content: string,
    options: { encoding?: string; sessionId?: string } = {}
  ) {
    const session = options.sessionId ?? (await this.ensureDefaultSession());
    return this.client.files.writeFile(path, content, session, {
      encoding: options.encoding
    });
  }

  async deleteFile(path: string, sessionId?: string) {
    const session = sessionId ?? (await this.ensureDefaultSession());
    return this.client.files.deleteFile(path, session);
  }

  async renameFile(oldPath: string, newPath: string, sessionId?: string) {
    const session = sessionId ?? (await this.ensureDefaultSession());
    return this.client.files.renameFile(oldPath, newPath, session);
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string,
    sessionId?: string
  ) {
    const session = sessionId ?? (await this.ensureDefaultSession());
    return this.client.files.moveFile(sourcePath, destinationPath, session);
  }

  async readFile(
    path: string,
    options: { encoding?: string; sessionId?: string } = {}
  ) {
    const session = options.sessionId ?? (await this.ensureDefaultSession());
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
    const session = options.sessionId ?? (await this.ensureDefaultSession());
    return this.client.files.readFileStream(path, session);
  }

  async listFiles(
    path: string,
    options?: { recursive?: boolean; includeHidden?: boolean }
  ) {
    const session = await this.ensureDefaultSession();
    return this.client.files.listFiles(path, session, options);
  }

  async exists(path: string, sessionId?: string) {
    const session = sessionId ?? (await this.ensureDefaultSession());
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
      const tokens =
        (await this.ctx.storage.get<Record<string, string>>('portTokens')) ||
        {};
      const existingToken = tokens['6080'];
      if (existingToken && this.sandboxName) {
        url = this.constructPreviewUrl(
          6080,
          this.sandboxName,
          hostname,
          existingToken
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
    const sessionId = options.sessionId ?? (await this.ensureDefaultSession());
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
    const sessionId = options.sessionId ?? (await this.ensureDefaultSession());
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
        throw new SecurityError(
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
      const tokens =
        (await this.ctx.storage.get<Record<string, string>>('portTokens')) ||
        {};
      const existingPort = Object.entries(tokens).find(
        ([p, t]) => t === token && p !== port.toString()
      );
      if (existingPort) {
        throw new SecurityError(
          `Token '${token}' is already in use by port ${existingPort[0]}. Please use a different token.`
        );
      }
      const sessionId = await this.ensureDefaultSession();
      await this.client.ports.exposePort(port, sessionId, options?.name);

      tokens[port.toString()] = token;
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
        throw new SecurityError(
          `Invalid port number: ${port}. Must be 1024-65535, excluding 3000 (sandbox control plane).`
        );
      }
      const sessionId = await this.ensureDefaultSession();
      await this.client.ports.unexposePort(port, sessionId);

      // Clean up token for this port (storage is protected by input gates)
      const tokens =
        (await this.ctx.storage.get<Record<string, string>>('portTokens')) ||
        {};
      if (tokens[port.toString()]) {
        delete tokens[port.toString()];
        await this.ctx.storage.put('portTokens', tokens);
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
    const sessionId = await this.ensureDefaultSession();
    const response = await this.client.ports.getExposedPorts(sessionId);

    // We need the sandbox name to construct preview URLs
    if (!this.sandboxName) {
      throw new Error(
        'Sandbox name not available. Ensure sandbox is accessed through getSandbox()'
      );
    }

    // Read all tokens from storage (protected by input gates)
    const tokens =
      (await this.ctx.storage.get<Record<string, string>>('portTokens')) || {};

    return response.ports.map((port) => {
      const token = tokens[port.port.toString()];
      if (!token) {
        throw new Error(
          `Port ${port.port} is exposed but has no token. This should not happen.`
        );
      }

      return {
        url: this.constructPreviewUrl(
          port.port,
          this.sandboxName!,
          hostname,
          token
        ),
        port: port.port,
        status: port.status
      };
    });
  }

  async isPortExposed(port: number): Promise<boolean> {
    try {
      const sessionId = await this.ensureDefaultSession();
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
    // First check if port is exposed
    const isExposed = await this.isPortExposed(port);
    if (!isExposed) {
      return false;
    }

    // Read stored token from storage (protected by input gates)
    const tokens =
      (await this.ctx.storage.get<Record<string, string>>('portTokens')) || {};
    const storedToken = tokens[port.toString()];
    if (!storedToken) {
      this.logger.error(
        'Port is exposed but has no token - bug detected',
        undefined,
        { port }
      );
      return false;
    }

    const encoder = new TextEncoder();
    const a = encoder.encode(storedToken);
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
      throw new SecurityError(`Custom token cannot be empty.`);
    }

    if (token.length > 16) {
      throw new SecurityError(
        `Custom token too long. Maximum 16 characters allowed. Received: ${token.length} characters.`
      );
    }

    if (!/^[a-z0-9_]+$/.test(token)) {
      throw new SecurityError(
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
      throw new SecurityError(
        `Invalid port number: ${port}. Must be 1024-65535, excluding 3000 (sandbox control plane).`
      );
    }

    // Hostnames are case-insensitive, routing requests to wrong DO instance when keys contain uppercase letters
    const effectiveId = this.sandboxName || sandboxId;
    const hasUppercase = /[A-Z]/.test(effectiveId);
    if (!this.normalizeId && hasUppercase) {
      throw new SecurityError(
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
        throw new SecurityError(
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
      throw new SecurityError(
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
    await this.client.utils.createSession({
      id: sessionId,
      ...(envPayload && { env: envPayload }),
      ...(options?.cwd && { cwd: options.cwd }),
      ...(options?.commandTimeoutMs !== undefined && {
        commandTimeoutMs: options.commandTimeoutMs
      })
    });

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
      readFile: (path, options) =>
        this.readFile(path, { ...options, sessionId }),
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
   * Download a backup archive via presigned GET URL.
   * The container curls the archive directly from R2, bypassing the DO.
   * ~93 MB/s throughput vs ~0.6 MB/s for base64 writeFile.
   */
  private async downloadBackupPresigned(
    archivePath: string,
    r2Key: string,
    expectedSize: number,
    backupId: string,
    dir: string,
    backupSession: string
  ): Promise<void> {
    const presignedUrl = await this.generatePresignedGetUrl(r2Key);

    await this.execWithSession('mkdir -p /var/backups', backupSession, {
      origin: 'internal'
    });

    const tmpPath = `${archivePath}.tmp`;
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

    // Verify downloaded file size before committing
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

    // Atomic move from temp to final path
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
   * create-archive → read → upload (or download → write → extract) flow
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
    this.requireBackupBucket();
    return this.enqueueBackupOp(() => this.doCreateBackup(options));
  }

  private async doCreateBackup(
    options: BackupOptions
  ): Promise<DirectoryBackup> {
    const bucket = this.requireBackupBucket();
    this.requirePresignedUrlSupport();
    const DEFAULT_TTL_SECONDS = 259200; // 3 days
    const MAX_NAME_LENGTH = 256;
    const {
      dir,
      name,
      ttl = DEFAULT_TTL_SECONDS,
      gitignore = false,
      excludes = []
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
        if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH) {
          throw new InvalidBackupConfigError({
            message: `BackupOptions.name must be a string of at most ${MAX_NAME_LENGTH} characters`,
            code: ErrorCode.INVALID_BACKUP_CONFIG,
            httpStatus: 400,
            context: {
              reason: `name must be a string of at most ${MAX_NAME_LENGTH} characters`
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

      backupSession = await this.ensureBackupSession();
      backupId = crypto.randomUUID();
      const archivePath = `/var/backups/${backupId}.sqsh`;

      const createResult = await this.client.backup.createArchive(
        dir,
        archivePath,
        backupSession,
        gitignore,
        excludes
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
      const r2Key = `backups/${backupId}/data.sqsh`;
      const metaKey = `backups/${backupId}/meta.json`;

      // Step 2: Upload archive to R2 via presigned URL (isolated backup session)
      await this.uploadBackupPresigned(
        archivePath,
        r2Key,
        createResult.sizeBytes,
        backupId,
        dir,
        backupSession
      );

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
        const archivePath = `/var/backups/${backupId}.sqsh`;
        const r2Key = `backups/${backupId}/data.sqsh`;
        const metaKey = `backups/${backupId}/meta.json`;
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
   * Restore a backup from R2 into a directory.
   *
   * Flow:
   *   1. DO reads metadata from R2 and checks TTL
   *   2. Container downloads the archive directly from R2 via presigned URL
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
      const metaKey = `backups/${id}/meta.json`;
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
      const r2Key = `backups/${id}/data.sqsh`;
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
      const archivePath = `/var/backups/${id}.sqsh`;

      // Step 3: Tear down existing FUSE mounts before overwriting the archive.
      // squashfuse holds the .sqsh file open; writing a new archive to the same
      // path while the old mount is active corrupts the backing store.
      // Unmount the overlay on dir, then iterate over all mount bases for this
      // backup (both suffixed UUID_* and legacy unsuffixed UUID) and unmount
      // their squashfuse lower dirs.
      const mountGlob = `/var/backups/mounts/${id}`;
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
        // Download archive via presigned URL (container curls directly from R2)
        await this.downloadBackupPresigned(
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
      // Clean up archive file on failure only — squashfuse needs it as
      // backing storage for the lifetime of the mount
      if (id && backupSession) {
        const archivePath = `/var/backups/${id}.sqsh`;
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
        error: caughtError
      });
    }
  }
}
