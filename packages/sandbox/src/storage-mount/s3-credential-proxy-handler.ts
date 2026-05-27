/**
 * Outbound handler that signs and forwards S3-compatible requests from s3fs
 * to the configured endpoint using real credentials held in the Durable Object.
 *
 * s3fs inside the container sends requests to the stable internal proxy host
 * `s3-credential-proxy.internal`. The mount ID is encoded as the first path
 * segment so the handler can resolve the correct mount config without per-mount
 * subdomain registration.
 *
 * Request path layout: /${mountId}/${bucket}/${objectKey}
 * Real upstream URL:    ${endpoint}/${bucket}/${objectKey}
 *
 * The handler also accepts the legacy per-mount-host shape
 * (${mountId}.s3-credential-proxy.internal) for forward compatibility.
 */

import type {
  OutboundHandler,
  OutboundHandlerContext
} from '@cloudflare/containers';
import type { BucketProvider } from '@repo/shared';
import { AwsClient } from 'aws4fetch';
import type { S3CredentialProxyParams } from './types';

const PER_MOUNT_SUFFIX = '.s3-credential-proxy.internal';
export const SELF_TEST_PATH = '/__sandbox_credential_proxy_self_test__';
const DEFAULT_SLOW_REQUEST_MS = 1000;

export const DUMMY_AUTH_HEADERS = new Set([
  'authorization',
  'x-amz-date',
  'x-amz-content-sha256',
  'x-amz-security-token',
  'x-goog-date',
  'x-goog-content-sha256'
]);

type SigV4ClientCacheEntry = {
  client: AwsClient;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  provider: BucketProvider | null;
  region: string;
};

type CredentialProxyDebugConfig = {
  enabled: boolean;
  slowRequestMs: number;
};

type CredentialProxyRequestInfo = {
  authStrategy: S3CredentialProxyParams['mounts'][string]['authStrategy'];
  bucket: string;
  contentLength: string | null;
  method: string;
  mountId: string;
  query: string[];
};

const sigV4ClientCache = new Map<string, SigV4ClientCacheEntry>();

export function evictSigV4ClientCacheEntry(mountId: string): void {
  sigV4ClientCache.delete(mountId);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  );
}

async function hmacSHA256(
  key: BufferSource,
  data: string
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

function detectS3Region(
  provider: BucketProvider | null,
  endpoint: string
): string {
  if (provider === 'r2') return 'auto';
  try {
    const host = new URL(endpoint).hostname;
    const m = host.match(/s3[.-]([a-z0-9-]+)\.amazonaws\.com/);
    if (m && m[1] !== 'amazonaws') return m[1];
    if (host === 's3.amazonaws.com') return 'us-east-1';
  } catch {
    // ignore
  }
  return 'auto';
}

function buildCleanHeaders(original: Headers): Headers {
  const clean = new Headers();
  for (const [k, v] of original as unknown as Iterable<[string, string]>) {
    const lower = k.toLowerCase();
    if (!DUMMY_AUTH_HEADERS.has(lower) && lower !== 'host') {
      clean.set(k, v);
    }
  }
  return clean;
}

function getCredentialProxyDebugConfig(
  env: Cloudflare.Env
): CredentialProxyDebugConfig {
  const envRecord = env as Record<string, unknown>;
  const enabled = envRecord.SANDBOX_CREDENTIAL_PROXY_DEBUG === 'true';
  const configuredSlowRequestMs = Number(
    envRecord.SANDBOX_CREDENTIAL_PROXY_SLOW_REQUEST_MS
  );
  const slowRequestMs =
    Number.isFinite(configuredSlowRequestMs) && configuredSlowRequestMs >= 0
      ? configuredSlowRequestMs
      : DEFAULT_SLOW_REQUEST_MS;
  return { enabled, slowRequestMs };
}

async function withCredentialProxyDiagnostics(
  requestInfo: CredentialProxyRequestInfo,
  debugConfig: CredentialProxyDebugConfig,
  operation: () => Promise<Response>
): Promise<Response> {
  const started = Date.now();
  try {
    const response = await operation();
    const durationMs = Date.now() - started;
    if (debugConfig.enabled || durationMs >= debugConfig.slowRequestMs) {
      console.info('sandbox.s3_credential_proxy.request', {
        ...requestInfo,
        durationMs,
        ok: response.ok,
        status: response.status,
        responseContentLength: response.headers.get('content-length')
      });
    }
    return response;
  } catch (error) {
    const durationMs = Date.now() - started;
    console.warn('sandbox.s3_credential_proxy.request_error', {
      ...requestInfo,
      durationMs,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function signAndForwardSigV4(
  request: Request,
  mountId: string,
  endpoint: string,
  provider: BucketProvider | null,
  credentials: { accessKeyId: string; secretAccessKey: string }
): Promise<Response> {
  const cacheKey = mountId;
  const cached = sigV4ClientCache.get(cacheKey);
  if (
    cached &&
    cached.accessKeyId === credentials.accessKeyId &&
    cached.secretAccessKey === credentials.secretAccessKey &&
    cached.endpoint === endpoint &&
    cached.provider === provider
  ) {
    return cached.client.fetch(request);
  }

  const region = detectS3Region(provider, endpoint);
  const client = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    service: 's3',
    region,
    retries: 0
  });
  sigV4ClientCache.set(cacheKey, {
    client,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    endpoint,
    provider,
    region
  });
  return client.fetch(request);
}

async function signAndForwardGCS(
  request: Request,
  credentials: { accessKeyId: string; secretAccessKey: string }
): Promise<Response> {
  const url = new URL(request.url);
  const now = new Date();
  const dateStr = `${now
    .toISOString()
    .replace(/[:-]/g, '')
    .replace(/\.\d+Z$/, '')}Z`;
  const dateOnly = dateStr.slice(0, 8);
  const location = 'auto';
  const service = 'storage';
  const credentialScope = `${dateOnly}/${location}/${service}/goog4_request`;

  const bodyHash = 'UNSIGNED-PAYLOAD';

  const headerEntries: [string, string][] = [
    ['host', url.hostname],
    ['x-goog-content-sha256', bodyHash],
    ['x-goog-date', dateStr]
  ];

  for (const [k, v] of request.headers as unknown as Iterable<
    [string, string]
  >) {
    const lower = k.toLowerCase();
    if (
      !DUMMY_AUTH_HEADERS.has(lower) &&
      lower !== 'host' &&
      lower !== 'x-goog-content-sha256' &&
      lower !== 'x-goog-date'
    ) {
      headerEntries.push([lower, v.trim()]);
    }
  }

  headerEntries.sort((a, b) => a[0].localeCompare(b[0]));
  const signedHeaders = headerEntries.map(([k]) => k).join(';');
  const canonicalHeaders = headerEntries
    .map(([k, v]) => `${k}:${v}\n`)
    .join('');

  const sortedParams = [...url.searchParams.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  const canonicalQueryString = sortedParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const canonicalUri = url.pathname
    .split('/')
    .map((s) => encodeURIComponent(decodeURIComponent(s)))
    .join('/');

  const canonicalRequest = [
    request.method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    bodyHash
  ].join('\n');

  const canonicalRequestHash = await sha256Hex(canonicalRequest);

  const stringToSign = [
    'GOOG4-HMAC-SHA256',
    dateStr,
    credentialScope,
    canonicalRequestHash
  ].join('\n');

  const enc = new TextEncoder();
  const kDate = await hmacSHA256(
    enc.encode(`GOOG4${credentials.secretAccessKey}`) as unknown as ArrayBuffer,
    dateOnly
  );
  const kRegion = await hmacSHA256(kDate, location);
  const kService = await hmacSHA256(kRegion, service);
  const kSigning = await hmacSHA256(kService, 'goog4_request');
  const sigBytes = await hmacSHA256(kSigning, stringToSign);
  const signature = toHex(sigBytes);

  const authorization = `GOOG4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const newHeaders = new Headers(request.headers);
  for (const h of DUMMY_AUTH_HEADERS) {
    newHeaders.delete(h);
  }
  newHeaders.set('x-goog-date', dateStr);
  newHeaders.set('x-goog-content-sha256', bodyHash);
  newHeaders.set('Authorization', authorization);

  return fetch(
    new Request(request.url, {
      method: request.method,
      headers: newHeaders,
      body: request.body
    })
  );
}

export const s3CredentialProxyHandler: OutboundHandler<
  Cloudflare.Env,
  S3CredentialProxyParams
> = async (
  request: Request,
  env: Cloudflare.Env,
  ctx: OutboundHandlerContext<S3CredentialProxyParams>
): Promise<Response> => {
  const url = new URL(request.url);

  if (url.pathname === SELF_TEST_PATH) {
    return new Response('OK', { status: 200 });
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const hostname = url.hostname;

  let mountId: string | null;
  let realPath: string;

  if (hostname.endsWith(PER_MOUNT_SUFFIX)) {
    // Legacy per-mount-host shape: mountId is the subdomain
    mountId = hostname.slice(0, -PER_MOUNT_SUFFIX.length);
    realPath = url.pathname;
  } else {
    // Primary path-based shape: /${mountId}/${bucket}/${objectKey}
    mountId = segments[0] ?? null;
    realPath = '/' + segments.slice(1).join('/');
  }

  if (!mountId) {
    return new Response('Bad Request: missing mount ID', { status: 400 });
  }

  const mount = ctx.params?.mounts[mountId];
  if (!mount) {
    return new Response(`Forbidden: unknown mount ID "${mountId}"`, {
      status: 403
    });
  }

  if (mount.readOnly) {
    const { method } = request;
    if (
      method === 'PUT' ||
      method === 'DELETE' ||
      (method === 'POST' &&
        (url.searchParams.has('uploads') || url.searchParams.has('uploadId')))
    ) {
      return new Response('Forbidden: bucket mount is read-only', {
        status: 403
      });
    }
  }

  const realUrl = new URL(realPath + (url.search || ''), mount.endpoint);
  const cleanHeaders = buildCleanHeaders(request.headers);
  const cleanRequest = new Request(realUrl.toString(), {
    method: request.method,
    headers: cleanHeaders,
    body: request.body
  });
  const debugConfig = getCredentialProxyDebugConfig(env);
  const requestInfo: CredentialProxyRequestInfo = {
    authStrategy: mount.authStrategy,
    bucket: mount.bucket,
    contentLength: request.headers.get('content-length'),
    method: request.method,
    mountId,
    query: [...url.searchParams.keys()].sort()
  };

  if (mount.authStrategy === 'gcs') {
    return withCredentialProxyDiagnostics(requestInfo, debugConfig, () =>
      signAndForwardGCS(cleanRequest, mount.credentials)
    );
  }

  return withCredentialProxyDiagnostics(requestInfo, debugConfig, () =>
    signAndForwardSigV4(
      cleanRequest,
      mountId,
      mount.endpoint,
      mount.provider,
      mount.credentials
    )
  );
};
