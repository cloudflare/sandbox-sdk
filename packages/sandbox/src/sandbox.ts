import { Container, getContainer, switchPort } from '@cloudflare/containers';
import type {
  BucketCredentials,
  BucketProvider,
  CodeContext,
  CreateContextOptions,
  ExecEvent,
  ExecOptions,
  ExecResult,
  ExecutionResult,
  ExecutionSession,
  ISandbox,
  LogEvent,
  MountBucketOptions,
  PortWatchEvent,
  Process,
  ProcessOptions,
  ProcessStatus,
  RunCodeOptions,
  SandboxOptions,
  SessionOptions,
  StreamOptions,
  WaitForExitResult,
  WaitForLogResult,
  WaitForPortOptions
} from '@repo/shared';
import {
  createLogger,
  getEnvString,
  isTerminalStatus,
  type SessionDeleteResult,
  shellEscape,
  TraceContext
} from '@repo/shared';
import { type ExecuteResponse, SandboxClient } from './clients';
import type { ErrorResponse } from './errors';
import {
  CustomDomainRequiredError,
  ErrorCode,
  ProcessExitedBeforeReadyError,
  ProcessReadyTimeoutError,
  SessionAlreadyExistsError
} from './errors';
import { CodeInterpreter } from './interpreter';
import { isLocalhostPattern } from './request-handler';
import { SecurityError, sanitizeSandboxId, validatePort } from './security';
import { parseSSEStream } from './sse-parser';
import {
  detectCredentials,
  detectProviderFromUrl,
  resolveS3fsOptions
} from './storage-mount';
import {
  InvalidMountConfigError,
  S3FSMountError
} from './storage-mount/errors';
import type { MountInfo } from './storage-mount/types';
import { SDK_VERSION } from './version';

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

  const stub = getContainer(ns, effectiveId);

  stub.setSandboxName?.(effectiveId, options?.normalizeId);

  if (options?.baseUrl) {
    stub.setBaseUrl(options.baseUrl);
  }

  if (options?.sleepAfter !== undefined) {
    stub.setSleepAfter(options.sleepAfter);
  }

  if (options?.keepAlive !== undefined) {
    stub.setKeepAlive(options.keepAlive);
  }

  if (options?.containerTimeouts) {
    stub.setContainerTimeouts(options.containerTimeouts);
  }

  return Object.assign(stub, {
    wsConnect: connect(stub)
  }) as T;
}

export function connect(stub: {
  fetch: (request: Request) => Promise<Response>;
}) {
  return async (request: Request, port: number) => {
    if (!validatePort(port)) {
      throw new SecurityError(
        `Invalid or restricted port: ${port}. Ports must be in range 1024-65535 and not reserved.`
      );
    }
    const portSwitchedRequest = switchPort(request, port);
    return await stub.fetch(portSwitchedRequest);
  };
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
    // @cloudflare/containers default: 300ms (too aggressive)
    waitIntervalMS: 1000 // 1 second (reduces load)
  };

  /**
   * Active container timeout configuration
   * Can be set via options, env vars, or defaults
   */
  private containerTimeouts = { ...this.DEFAULT_CONTAINER_TIMEOUTS };

  /**
   * Create a SandboxClient with current transport settings
   */
  private createSandboxClient(): SandboxClient {
    return new SandboxClient({
      logger: this.logger,
      port: 3000,
      stub: this,
      ...(this.transport === 'websocket' && {
        transportMode: 'websocket' as const,
        wsUrl: 'ws://localhost:3000/ws'
      })
    });
  }

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);

    const envObj = env as Record<string, unknown>;
    // Set sandbox environment variables from env object
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
  }

  // RPC method to enable keepAlive mode
  async setKeepAlive(keepAlive: boolean): Promise<void> {
    this.keepAliveEnabled = keepAlive;
    if (keepAlive) {
      this.logger.info(
        'KeepAlive mode enabled - container will stay alive until explicitly destroyed'
      );
    } else {
      this.logger.info(
        'KeepAlive mode disabled - container will timeout normally'
      );
    }
  }

  // RPC method to set environment variables
  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    // Update local state for new sessions
    this.envVars = { ...this.envVars, ...envVars };

    // If default session already exists, update it directly
    if (this.defaultSession) {
      // Set environment variables by executing export commands in the existing session
      for (const [key, value] of Object.entries(envVars)) {
        const escapedValue = value.replace(/'/g, "'\\''");
        const exportCommand = `export ${key}='${escapedValue}'`;

        const result = await this.client.commands.execute(
          exportCommand,
          this.defaultSession
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

  /*
   * Mount an S3-compatible bucket as a local directory using S3FS-FUSE
   *
   * Requires explicit endpoint URL. Credentials are auto-detected from environment
   * variables or can be provided explicitly.
   *
   * @param bucket - Bucket name
   * @param mountPath - Absolute path in container to mount at
   * @param options - Configuration options with required endpoint
   * @throws MissingCredentialsError if no credentials found in environment
   * @throws S3FSMountError if S3FS mount command fails
   * @throws InvalidMountConfigError if bucket name, mount path, or endpoint is invalid
   */
  async mountBucket(
    bucket: string,
    mountPath: string,
    options: MountBucketOptions
  ): Promise<void> {
    this.logger.info(`Mounting bucket ${bucket} to ${mountPath}`);

    // Validate options
    this.validateMountOptions(bucket, mountPath, options);

    // Detect provider from explicit option or URL pattern
    const provider: BucketProvider | null =
      options.provider || detectProviderFromUrl(options.endpoint);

    this.logger.debug(`Detected provider: ${provider || 'unknown'}`, {
      explicitProvider: options.provider
    });

    // Detect credentials
    const credentials = detectCredentials(options, this.envVars);

    // Generate unique password file path
    const passwordFilePath = this.generatePasswordFilePath();

    // Reserve mount path before async operations so concurrent mounts see it
    this.activeMounts.set(mountPath, {
      bucket,
      mountPath,
      endpoint: options.endpoint,
      provider,
      passwordFilePath,
      mounted: false
    });

    try {
      // Create password file with credentials
      await this.createPasswordFile(passwordFilePath, bucket, credentials);

      // Create mount directory
      await this.exec(`mkdir -p ${shellEscape(mountPath)}`);

      // Execute S3FS mount with password file
      await this.executeS3FSMount(
        bucket,
        mountPath,
        options,
        provider,
        passwordFilePath
      );

      // Mark as successfully mounted
      this.activeMounts.set(mountPath, {
        bucket,
        mountPath,
        endpoint: options.endpoint,
        provider,
        passwordFilePath,
        mounted: true
      });

      this.logger.info(`Successfully mounted bucket ${bucket} to ${mountPath}`);
    } catch (error) {
      // Clean up password file on failure
      await this.deletePasswordFile(passwordFilePath);

      // Clean up reservation on failure
      this.activeMounts.delete(mountPath);
      throw error;
    }
  }

  /**
   * Manually unmount a bucket filesystem
   *
   * @param mountPath - Absolute path where the bucket is mounted
   * @throws InvalidMountConfigError if mount path doesn't exist or isn't mounted
   */
  async unmountBucket(mountPath: string): Promise<void> {
    this.logger.info(`Unmounting bucket from ${mountPath}`);

    // Look up mount by path
    const mountInfo = this.activeMounts.get(mountPath);

    // Throw error if mount doesn't exist
    if (!mountInfo) {
      throw new InvalidMountConfigError(
        `No active mount found at path: ${mountPath}`
      );
    }

    // Unmount the filesystem
    try {
      await this.exec(`fusermount -u ${shellEscape(mountPath)}`);
      mountInfo.mounted = false;

      // Only remove from tracking if unmount succeeded
      this.activeMounts.delete(mountPath);
    } finally {
      // Always cleanup password file, even if unmount fails
      await this.deletePasswordFile(mountInfo.passwordFilePath);
    }

    this.logger.info(`Successfully unmounted bucket from ${mountPath}`);
  }

  /**
   * Validate mount options
   */
  private validateMountOptions(
    bucket: string,
    mountPath: string,
    options: MountBucketOptions
  ): void {
    // Require endpoint field
    if (!options.endpoint) {
      throw new InvalidMountConfigError(
        'Endpoint is required. Provide the full S3-compatible endpoint URL.'
      );
    }

    // Basic URL validation
    try {
      new URL(options.endpoint);
    } catch (error) {
      throw new InvalidMountConfigError(
        `Invalid endpoint URL: "${options.endpoint}". Must be a valid HTTP(S) URL.`
      );
    }

    // Validate bucket name (S3-compatible naming rules)
    const bucketNameRegex = /^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/;
    if (!bucketNameRegex.test(bucket)) {
      throw new InvalidMountConfigError(
        `Invalid bucket name: "${bucket}". Bucket names must be 3-63 characters, ` +
          `lowercase alphanumeric, dots, or hyphens, and cannot start/end with dots or hyphens.`
      );
    }

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

    await this.exec(`chmod 0600 ${shellEscape(passwordFilePath)}`);

    this.logger.debug(`Created password file: ${passwordFilePath}`);
  }

  /**
   * Delete password file
   */
  private async deletePasswordFile(passwordFilePath: string): Promise<void> {
    try {
      await this.exec(`rm -f ${shellEscape(passwordFilePath)}`);
      this.logger.debug(`Deleted password file: ${passwordFilePath}`);
    } catch (error) {
      this.logger.warn(`Failed to delete password file ${passwordFilePath}`, {
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
    options: MountBucketOptions,
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

    this.logger.debug('Executing s3fs mount', {
      bucket,
      mountPath,
      provider,
      resolvedOptions
    });

    // Execute mount command
    const result = await this.exec(mountCmd);

    if (result.exitCode !== 0) {
      throw new S3FSMountError(
        `S3FS mount failed: ${result.stderr || result.stdout || 'Unknown error'}`
      );
    }

    this.logger.debug('Mount command executed successfully');
  }

  /**
   * Cleanup and destroy the sandbox container
   */
  override async destroy(): Promise<void> {
    this.logger.info('Destroying sandbox container');

    // Disconnect WebSocket transport if active
    this.client.disconnect();

    // Unmount all mounted buckets and cleanup password files
    for (const [mountPath, mountInfo] of this.activeMounts.entries()) {
      if (mountInfo.mounted) {
        try {
          this.logger.info(
            `Unmounting bucket ${mountInfo.bucket} from ${mountPath}`
          );
          await this.exec(`fusermount -u ${shellEscape(mountPath)}`);
          mountInfo.mounted = false;
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Failed to unmount bucket ${mountInfo.bucket} from ${mountPath}: ${errorMsg}`
          );
        }
      }

      // Always cleanup password file
      await this.deletePasswordFile(mountInfo.passwordFilePath);
    }

    await super.destroy();
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
    try {
      // Get the SDK version (imported from version.ts)
      const sdkVersion = SDK_VERSION;

      // Get container version
      const containerVersion = await this.client.utils.getVersion();

      // If container version is unknown, it's likely an old container without the endpoint
      if (containerVersion === 'unknown') {
        this.logger.warn(
          'Container version check: Container version could not be determined. ' +
            'This may indicate an outdated container image. ' +
            'Please update your container to match SDK version ' +
            sdkVersion
        );
        return;
      }

      // Check if versions match
      if (containerVersion !== sdkVersion) {
        const message =
          `Version mismatch detected! SDK version (${sdkVersion}) does not match ` +
          `container version (${containerVersion}). This may cause compatibility issues. ` +
          `Please update your container image to version ${sdkVersion}`;

        // Log warning - we can't reliably detect dev vs prod environment in Durable Objects
        // so we always use warning level as requested by the user
        this.logger.warn(message);
      } else {
        this.logger.debug('Version check passed', {
          sdkVersion,
          containerVersion
        });
      }
    } catch (error) {
      // Don't fail the sandbox initialization if version check fails
      this.logger.debug('Version compatibility check encountered an error', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  override async onStop() {
    this.logger.debug('Sandbox stopped');

    // Clear in-memory state that references the old container
    // This prevents stale references after container restarts
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

    // If container not healthy, start it with production timeouts
    if (state.status !== 'healthy') {
      try {
        this.logger.debug('Starting container with configured timeouts', {
          instanceTimeout: this.containerTimeouts.instanceGetTimeoutMS,
          portTimeout: this.containerTimeouts.portReadyTimeoutMS
        });

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
          return new Response(
            'Container is currently provisioning. This can take several minutes on first deployment. Please retry in a moment.',
            {
              status: 503,
              headers: { 'Retry-After': '10' }
            }
          );
        }

        // 2. Transient startup errors: Container starting, port not ready yet
        if (this.isTransientStartupError(e)) {
          this.logger.debug(
            'Transient container startup error, returning 503',
            {
              error: e instanceof Error ? e.message : String(e)
            }
          );
          return new Response(
            'Container is starting. Please retry in a moment.',
            {
              status: 503,
              headers: { 'Retry-After': '3' }
            }
          );
        }

        // 3. Permanent errors: Configuration issues, missing images, etc.
        this.logger.error(
          'Container startup failed with permanent error',
          e instanceof Error ? e : new Error(String(e))
        );
        return new Response(
          `Failed to start container: ${e instanceof Error ? e.message : String(e)}`,
          { status: 500 }
        );
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

      // Timeouts (various layers)
      'timed out',
      'timeout',
      'the operation was aborted'
    ];

    return transientPatterns.some((pattern) => msg.includes(pattern));
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
        'Activity expired but keepAlive is enabled - renewing activity timeout'
      );
      // Renew the activity timer so the container stays alive
      this.renewActivityTimeout();
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
            options.cwd !== undefined)
            ? {
                timeoutMs: options.timeout,
                env: options.env,
                cwd: options.cwd
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

      // Call completion callback if provided
      if (options?.onComplete) {
        options.onComplete(result);
      }

      return result;
    } catch (error) {
      if (options?.onError && error instanceof Error) {
        options.onError(error);
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
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
          cwd: options.cwd
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
        const DEBOUNCE_MS = 50;
        let lastCheckTime = 0;
        let pendingCheck = false;

        const checkPattern = (): WaitForLogResult | null => {
          // Check both stdout and stderr buffers
          const stdoutResult = this.matchPattern(collectedStdout, pattern);
          if (stdoutResult) return stdoutResult;
          const stderrResult = this.matchPattern(collectedStderr, pattern);
          if (stderrResult) return stderrResult;
          return null;
        };

        for await (const event of parseSSEStream<LogEvent>(stream)) {
          // Handle different event types
          if (event.type === 'stdout' || event.type === 'stderr') {
            const data = event.data || '';

            if (event.type === 'stdout') {
              collectedStdout += data;
            } else {
              collectedStderr += data;
            }
            pendingCheck = true;

            // Debounce pattern matching - check at most every 50ms
            const now = Date.now();
            if (now - lastCheckTime >= DEBOUNCE_MS) {
              lastCheckTime = now;
              pendingCheck = false;
              const result = checkPattern();
              if (result) return result;
            }
          }

          // Process exited - do final check before throwing
          if (event.type === 'exit') {
            if (pendingCheck) {
              const result = checkPattern();
              if (result) return result;
            }
            throw this.createExitedBeforeReadyError(
              processId,
              command,
              conditionStr,
              event.exitCode ?? 1
            );
          }
        }

        // Stream ended - do final check before throwing
        if (pendingCheck) {
          const result = checkPattern();
          if (result) return result;
        }
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
        ...(options?.env !== undefined && { env: options.env }),
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
    options?: { branch?: string; targetDir?: string; sessionId?: string }
  ) {
    const session = options?.sessionId ?? (await this.ensureDefaultSession());
    return this.client.git.checkout(repoUrl, session, {
      branch: options?.branch,
      targetDir: options?.targetDir
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

  async exposePort(port: number, options: { name?: string; hostname: string }) {
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

    const sessionId = await this.ensureDefaultSession();
    await this.client.ports.exposePort(port, sessionId, options?.name);

    // We need the sandbox name to construct preview URLs
    if (!this.sandboxName) {
      throw new Error(
        'Sandbox name not available. Ensure sandbox is accessed through getSandbox()'
      );
    }

    // Generate and store token for this port (storage is protected by input gates)
    const token = this.generatePortToken();
    const tokens =
      (await this.ctx.storage.get<Record<string, string>>('portTokens')) || {};
    tokens[port.toString()] = token;
    await this.ctx.storage.put('portTokens', tokens);

    const url = this.constructPreviewUrl(
      port,
      this.sandboxName,
      options.hostname,
      token
    );

    return {
      url,
      port,
      name: options?.name
    };
  }

  async unexposePort(port: number) {
    if (!validatePort(port)) {
      throw new SecurityError(
        `Invalid port number: ${port}. Must be between 1024-65535 and not reserved.`
      );
    }

    const sessionId = await this.ensureDefaultSession();
    await this.client.ports.unexposePort(port, sessionId);

    // Clean up token for this port (storage is protected by input gates)
    const tokens =
      (await this.ctx.storage.get<Record<string, string>>('portTokens')) || {};
    if (tokens[port.toString()]) {
      delete tokens[port.toString()];
      await this.ctx.storage.put('portTokens', tokens);
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
      // This should not happen - all exposed ports must have tokens
      this.logger.error(
        'Port is exposed but has no token - bug detected',
        undefined,
        { port }
      );
      return false;
    }

    // Constant-time comparison to prevent timing attacks
    return storedToken === token;
  }

  private generatePortToken(): string {
    // Generate cryptographically secure 16-character token using Web Crypto API
    // Available in Cloudflare Workers runtime
    const array = new Uint8Array(12); // 12 bytes = 16 base64url chars (after padding removal)
    crypto.getRandomValues(array);

    // Convert to base64url format (URL-safe, no padding, lowercase)
    const base64 = btoa(String.fromCharCode(...array));
    return base64
      .replace(/\+/g, '-')
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
        `Invalid port number: ${port}. Must be between 1024-65535 and not reserved.`
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
    const envPayload =
      Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined;

    // Create session in container
    await this.client.utils.createSession({
      id: sessionId,
      ...(envPayload && { env: envPayload }),
      ...(options?.cwd && { cwd: options.cwd })
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

  /**
   * Internal helper to create ExecutionSession wrapper for a given sessionId
   * Used by both createSession and getSession
   */
  private getSessionWrapper(sessionId: string): ExecutionSession {
    return {
      id: sessionId,

      // Command execution - delegate to internal session-aware methods
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

      // Environment management - needs special handling
      setEnvVars: async (envVars: Record<string, string>) => {
        try {
          // Set environment variables by executing export commands
          for (const [key, value] of Object.entries(envVars)) {
            const escapedValue = value.replace(/'/g, "'\\''");
            const exportCommand = `export ${key}='${escapedValue}'`;

            const result = await this.client.commands.execute(
              exportCommand,
              sessionId
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
      unmountBucket: (mountPath) => this.unmountBucket(mountPath)
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
}
