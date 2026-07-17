import type {
  ISandbox,
  MountBucketOptions,
  R2BindingMountBucketOptions,
  RemoteMountBucketOptions,
  TunnelInfo,
  TunnelOptions
} from '@repo/shared';
import type { Sandbox } from '../../sandbox';
import { getSandbox as getSandboxFromSDK } from '../../sandbox';
import { SandboxSecurityError, validateTunnelName } from '../../security';
import { errorJson } from '../helpers';
import type {
  BridgeEnv,
  MountBucketRequest,
  MountBucketRequestOptions,
  TunnelRequest
} from '../types';

export type BridgeApp = import('hono').Hono<{
  Bindings: BridgeEnv;
  Variables: { containerUUID: string };
}>;

export type BridgeSandbox = ISandbox & {
  /** Internal non-waking lifecycle query used only by the bridge. */
  isRuntimeActive(): Promise<boolean>;
  createWorkspaceArchive(options: {
    root: string;
    excludes?: readonly string[];
  }): Promise<string>;
  extractWorkspaceArchive(options: {
    root: string;
    archivePath: string;
  }): Promise<void>;
  cleanupWorkspaceArchive(archivePath: string): Promise<void>;
  cleanupMountDirectory(mountPath: string): Promise<void>;
  destroy(): Promise<void>;
  tunnels: {
    get(port: number, options?: TunnelOptions): Promise<TunnelInfo>;
    destroy(port: number): Promise<void>;
  };
};

export interface WarmPoolStub {
  configure(options: {
    warmTarget: number;
    refreshInterval: number;
  }): Promise<void>;
  getContainer(sandboxId: string): Promise<string>;
  lookupContainer(sandboxId: string): Promise<string | null>;
  getStats(): Promise<unknown>;
  shutdownPrewarmed(): Promise<void>;
  reportStopped(containerUUID: string): Promise<void>;
}

export function getSandbox<T extends Sandbox<unknown>>(
  ns: DurableObjectNamespace<T>,
  containerUUID: string
): BridgeSandbox {
  return getSandboxFromSDK(ns, containerUUID) as unknown as BridgeSandbox;
}

export function getSandboxNs(
  env: BridgeEnv,
  sandboxBinding: string
): DurableObjectNamespace<Sandbox<unknown>> {
  return env[sandboxBinding] as DurableObjectNamespace<Sandbox<unknown>>;
}

export function getWarmPoolNs(
  env: BridgeEnv,
  warmPoolBinding: string
): DurableObjectNamespace {
  return env[warmPoolBinding] as DurableObjectNamespace;
}

export function getWarmPoolStub(
  env: BridgeEnv,
  warmPoolBinding: string
): WarmPoolStub {
  const poolNs = getWarmPoolNs(env, warmPoolBinding);
  const poolId = poolNs.idFromName('global-pool');
  return poolNs.get(poolId) as unknown as WarmPoolStub;
}

function hasEndpoint(
  options: MountBucketRequestOptions
): options is MountBucketRequestOptions & { endpoint: string } {
  return 'endpoint' in options && typeof options.endpoint === 'string';
}

function hasEndpointProperty(options: MountBucketRequestOptions): boolean {
  return 'endpoint' in options && options.endpoint !== undefined;
}

function hasCredentials(
  options: MountBucketRequestOptions
): options is MountBucketRequestOptions & {
  credentials: { accessKeyId: string; secretAccessKey: string };
} {
  return 'credentials' in options && options.credentials !== undefined;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

export function parseTunnelOptions(
  rawBody: string
): TunnelOptions | Response | undefined {
  if (!rawBody.trim()) return undefined;

  let body: TunnelRequest;
  try {
    body = JSON.parse(rawBody) as TunnelRequest;
  } catch {
    return errorJson('Invalid JSON body', 'invalid_request', 400);
  }

  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    body.name === undefined
  ) {
    return undefined;
  }

  if (typeof body.name !== 'string') {
    return errorJson(
      'name must be a string when provided',
      'invalid_request',
      400
    );
  }

  try {
    validateTunnelName(body.name);
  } catch (err) {
    if (err instanceof SandboxSecurityError) {
      return errorJson(err.message, 'invalid_request', 400);
    }
    throw err;
  }

  return { name: body.name };
}

export function validateMountOptions(
  options: MountBucketRequestOptions,
  binding?: string
): Response | null {
  if ('endpoint' in options && !hasEndpoint(options)) {
    return errorJson(
      'options.endpoint must be a string when provided',
      'invalid_request',
      400
    );
  }
  if (binding !== undefined && typeof binding !== 'string') {
    return errorJson(
      'binding must be a string when provided',
      'invalid_request',
      400
    );
  }
  if (binding === '') {
    return errorJson(
      'binding must be a non-empty string when provided',
      'invalid_request',
      400
    );
  }
  if (binding !== undefined && hasEndpointProperty(options)) {
    return errorJson(
      'Provide either binding or options.endpoint, not both',
      'invalid_request',
      400
    );
  }
  if (
    options.s3fsOptions !== undefined &&
    !isStringArray(options.s3fsOptions)
  ) {
    return errorJson(
      'options.s3fsOptions must be an array of strings when provided',
      'invalid_request',
      400
    );
  }
  if (options.readOnly !== undefined && typeof options.readOnly !== 'boolean') {
    return errorJson(
      'options.readOnly must be a boolean when provided',
      'invalid_request',
      400
    );
  }
  if (options.prefix !== undefined && typeof options.prefix !== 'string') {
    return errorJson(
      'options.prefix must be a string when provided',
      'invalid_request',
      400
    );
  }
  if (
    'credentialProxy' in options &&
    options.credentialProxy !== undefined &&
    typeof options.credentialProxy !== 'boolean'
  ) {
    return errorJson(
      'options.credentialProxy must be a boolean when provided',
      'invalid_request',
      400
    );
  }
  if (
    'credentials' in options &&
    options.credentials !== undefined &&
    (typeof options.credentials !== 'object' ||
      options.credentials === null ||
      typeof options.credentials.accessKeyId !== 'string' ||
      typeof options.credentials.secretAccessKey !== 'string')
  ) {
    return errorJson(
      'options.credentials must include string accessKeyId and secretAccessKey',
      'invalid_request',
      400
    );
  }
  return null;
}

export function resolveMountBucketName(
  body: MountBucketRequest
): string | Response {
  if (hasEndpoint(body.options)) {
    if (body.bucket && typeof body.bucket === 'string') return body.bucket;
    return errorJson(
      'bucket must be a non-empty string for remote mounts',
      'invalid_request',
      400
    );
  }
  if (body.binding !== undefined) return body.binding;
  return errorJson(
    'binding must be a non-empty string for R2 binding mounts',
    'invalid_request',
    400
  );
}

export function toSDKMountOptions(
  options: MountBucketRequestOptions
): MountBucketOptions {
  if (hasEndpoint(options)) {
    const remoteOptions: RemoteMountBucketOptions = {
      endpoint: options.endpoint
    };
    if (options.readOnly !== undefined)
      remoteOptions.readOnly = options.readOnly;
    if (options.prefix !== undefined) remoteOptions.prefix = options.prefix;
    if (hasCredentials(options)) {
      remoteOptions.credentials = {
        accessKeyId: options.credentials.accessKeyId,
        secretAccessKey: options.credentials.secretAccessKey
      };
    }
    if (options.s3fsOptions !== undefined)
      remoteOptions.s3fsOptions = options.s3fsOptions;
    if (
      'credentialProxy' in options &&
      typeof options.credentialProxy === 'boolean'
    ) {
      remoteOptions.credentialProxy = options.credentialProxy;
    }
    return remoteOptions;
  }

  const r2BindingOptions: R2BindingMountBucketOptions = {};
  if (options.readOnly !== undefined)
    r2BindingOptions.readOnly = options.readOnly;
  if (options.prefix !== undefined) r2BindingOptions.prefix = options.prefix;
  if (options.s3fsOptions !== undefined)
    r2BindingOptions.s3fsOptions = options.s3fsOptions;
  return r2BindingOptions;
}
