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
 * (${mountId}.s3-credential-proxy.internal) for backward compatibility.
 */

import type {
  OutboundHandler,
  OutboundHandlerContext
} from '@cloudflare/containers';
import type { BucketProvider } from '@repo/shared';
import { AwsClient } from 'aws4fetch';
import type { S3CredentialProxyParams } from '../types';

const PER_MOUNT_SUFFIX = '.s3-credential-proxy.internal';
export const SELF_TEST_PATH = '/__sandbox_credential_proxy_self_test__';
export const DIAGNOSTICS_PATH = '/__sandbox_credential_proxy_diagnostics__';
const DEFAULT_SLOW_REQUEST_MS = 1000;
const ERROR_RESPONSE_BODY_LIMIT = 2048;
const MAX_DIAGNOSTIC_EVENTS = 500;

export const DUMMY_AUTH_HEADERS = new Set([
  'authorization',
  'x-amz-date',
  'x-amz-content-sha256',
  'x-amz-security-token',
  'x-goog-date',
  'x-goog-content-sha256'
]);

type CredentialProxyDebugConfig = {
  diagnosticsEndpointEnabled: boolean;
  enabled: boolean;
  slowRequestMs: number;
};

type CredentialProxyRequestInfo = {
  authStrategy: S3CredentialProxyParams['mounts'][string]['authStrategy'];
  bucket: string;
  bodyPresent?: boolean;
  contentLength: string | null;
  method: string;
  mountId: string;
  payloadHashMode?: 'signed' | 'unsigned';
  query: string[];
  clientSetupMs?: number;
  upstreamMs?: number;
};

type CredentialProxyDiagnosticEvent = CredentialProxyRequestInfo & {
  containerId: string;
  durationMs: number;
  ok: boolean;
  path: string;
  status: number;
  timestamp: string;
};

type SigV4ClientCacheEntry = {
  client: AwsClient;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  provider: BucketProvider | null;
  region: string;
};

const sigV4ClientCache = new Map<string, SigV4ClientCacheEntry>();
const directoryMarkerCache = new Map<string, [string, string][]>();
const credentialProxyDiagnosticEvents: CredentialProxyDiagnosticEvent[] = [];
let credentialProxyDiagnosticEventCount = 0;

export function evictSigV4ClientCacheEntry(mountId: string): void {
  sigV4ClientCache.delete(mountId);
}

export function evictDirectoryMarkerCacheForMount(mountId: string): void {
  const prefix = `${mountId}:`;
  for (const key of directoryMarkerCache.keys()) {
    if (key.startsWith(prefix)) {
      directoryMarkerCache.delete(key);
    }
  }
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
    // Strip dummy signing headers and the intercepted proxy host; x-amz-content-sha256
    // is stripped here too (it's in DUMMY_AUTH_HEADERS) so it can be re-added below
    // only when the original value is a genuine payload hash (not a dummy signing value).
    if (!DUMMY_AUTH_HEADERS.has(lower) && lower !== 'host') {
      clean.set(k, v);
    }
  }
  const contentSHA256 = original.get('x-amz-content-sha256');
  if (contentSHA256 && isValidContentSHA256(contentSHA256)) {
    clean.set('x-amz-content-sha256', contentSHA256);
  }
  return clean;
}

function isValidContentSHA256(value: string): boolean {
  return value === 'UNSIGNED-PAYLOAD' || /^[a-fA-F0-9]{64}$/.test(value);
}

function getCredentialProxyDebugConfig(
  env: Cloudflare.Env
): CredentialProxyDebugConfig {
  const envRecord = env as unknown as Record<string, unknown>;
  const enabled = envRecord.SANDBOX_CREDENTIAL_PROXY_DEBUG === 'true';
  const diagnosticsEndpointEnabled =
    envRecord.SANDBOX_CREDENTIAL_PROXY_DIAGNOSTICS_ENDPOINT === 'true';
  const configuredSlowRequestMs = Number(
    envRecord.SANDBOX_CREDENTIAL_PROXY_SLOW_REQUEST_MS
  );
  const slowRequestMs =
    Number.isFinite(configuredSlowRequestMs) && configuredSlowRequestMs >= 0
      ? configuredSlowRequestMs
      : DEFAULT_SLOW_REQUEST_MS;
  return { diagnosticsEndpointEnabled, enabled, slowRequestMs };
}

function recordCredentialProxyDiagnosticEvent(
  event: CredentialProxyDiagnosticEvent
): void {
  credentialProxyDiagnosticEvents.push(event);
  credentialProxyDiagnosticEventCount++;
  while (credentialProxyDiagnosticEvents.length > MAX_DIAGNOSTIC_EVENTS) {
    credentialProxyDiagnosticEvents.shift();
  }
}

function getCredentialProxyDiagnosticsResponse(
  url: URL,
  containerId: string
): Response {
  const since = Number(url.searchParams.get('since') ?? '0');
  const bufferStartCount =
    credentialProxyDiagnosticEventCount -
    credentialProxyDiagnosticEvents.length;
  const events = credentialProxyDiagnosticEvents.filter((event, index) => {
    if (event.containerId !== containerId) return false;
    return !Number.isFinite(since) || bufferStartCount + index >= since;
  });
  return Response.json({
    nextCursor: credentialProxyDiagnosticEventCount,
    events
  });
}

async function withCredentialProxyDiagnostics(
  requestInfo: CredentialProxyRequestInfo,
  debugConfig: CredentialProxyDebugConfig,
  containerId: string,
  path: string,
  operation: () => Promise<Response>
): Promise<Response> {
  const started = Date.now();
  try {
    const response = await operation();
    const durationMs = Date.now() - started;
    if (debugConfig.enabled) {
      recordCredentialProxyDiagnosticEvent({
        ...requestInfo,
        containerId,
        durationMs,
        ok: response.ok,
        path,
        status: response.status,
        timestamp: new Date().toISOString()
      });
    }
    if (debugConfig.enabled || durationMs >= debugConfig.slowRequestMs) {
      console.info('sandbox.s3_credential_proxy.request', {
        ...requestInfo,
        durationMs,
        ok: response.ok,
        status: response.status,
        responseContentLength: response.headers.get('content-length')
      });
    }
    if (!response.ok) {
      // Read the error body asynchronously so we don't delay returning the
      // response to s3fs (important for 4xx/throttle responses).
      const responseForLog = response.clone();
      const requestInfoSnapshot = { ...requestInfo };
      responseForLog
        .text()
        .then((body) => {
          console.warn('sandbox.s3_credential_proxy.upstream_error', {
            ...requestInfoSnapshot,
            durationMs,
            status: response.status,
            statusText: response.statusText,
            errorBody: body.slice(0, ERROR_RESPONSE_BODY_LIMIT)
          });
        })
        .catch(() => {});
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

function getSigV4Client(
  mountId: string,
  endpoint: string,
  provider: BucketProvider | null,
  credentials: { accessKeyId: string; secretAccessKey: string },
  region: string
): AwsClient {
  const cached = sigV4ClientCache.get(mountId);
  if (
    cached &&
    cached.accessKeyId === credentials.accessKeyId &&
    cached.secretAccessKey === credentials.secretAccessKey &&
    cached.endpoint === endpoint &&
    cached.provider === provider &&
    cached.region === region
  ) {
    return cached.client;
  }

  const client = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    service: 's3',
    region,
    retries: 0
  });
  sigV4ClientCache.set(mountId, {
    client,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    endpoint,
    provider,
    region
  });
  return client;
}

function encodeCanonicalQueryPart(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getCanonicalURI(url: URL): string {
  return url.pathname
    .split('/')
    .map((segment) =>
      segment
        .split(/(%[0-9A-Fa-f]{2})/g)
        .map((part) =>
          /^%[0-9A-Fa-f]{2}$/.test(part)
            ? part.toUpperCase()
            : encodeCanonicalQueryPart(part)
        )
        .join('')
    )
    .join('/');
}

function getCanonicalQueryString(url: URL): string {
  const query = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  if (!query) return '';
  return query
    .split('&')
    .map((part): [string, string] => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) return [part, ''];
      return [part.slice(0, separatorIndex), part.slice(separatorIndex + 1)];
    })
    .map(([key, value]): [string, string] => [
      encodeCanonicalQueryPart(decodeURIEncodedQueryPart(key)),
      encodeCanonicalQueryPart(decodeURIEncodedQueryPart(value))
    ])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey < rightKey) return -1;
      if (leftKey > rightKey) return 1;
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
      return 0;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function decodeURIEncodedQueryPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getSigV4PayloadHash(headers: Headers): {
  hash: string;
  mode: 'signed' | 'unsigned';
} {
  const existingHash = headers.get('x-amz-content-sha256');
  if (existingHash && existingHash !== 'UNSIGNED-PAYLOAD') {
    return { hash: existingHash, mode: 'signed' };
  }
  return { hash: 'UNSIGNED-PAYLOAD', mode: 'unsigned' };
}

function isZeroLengthDirectoryMarkerPUT(
  request: Request,
  realPath: string
): boolean {
  return (
    request.method.toUpperCase() === 'PUT' &&
    request.headers.get('content-length') === '0' &&
    realPath.endsWith('/')
  );
}

function isDirectoryMarkerHEAD(request: Request): boolean {
  return request.method.toUpperCase() === 'HEAD';
}

function getDirectoryMarkerCacheKey(mountId: string, realPath: string): string {
  return `${mountId}:${realPath.replace(/\/+$/, '')}`;
}

function getDirectoryMarkerResponseHeaders(
  request: Request
): [string, string][] {
  const headers: [string, string][] = [
    ['Accept-Ranges', 'bytes'],
    ['Content-Length', '0'],
    ['ETag', '"d41d8cd98f00b204e9800998ecf8427e"'],
    ['Last-Modified', new Date().toUTCString()]
  ];
  const contentType = request.headers.get('content-type');
  if (contentType) {
    headers.push(['Content-Type', contentType]);
  }
  for (const [name, value] of request.headers as unknown as Iterable<
    [string, string]
  >) {
    if (name.toLowerCase().startsWith('x-amz-meta-')) {
      headers.push([name, value]);
    }
  }
  return headers;
}

function normalizePrefix(prefix: string | undefined): string | undefined {
  if (!prefix) return undefined;
  return prefix.replace(/^\/+/, '').replace(/\/+$/, '');
}

function getObjectKeyForPath(realPath: string, bucket: string): string | null {
  const pathSegments = realPath.split('/').filter(Boolean);
  const requestBucket = pathSegments[0];
  if (requestBucket !== bucket) {
    return null;
  }
  return pathSegments.slice(1).join('/');
}

function isObjectKeyWithinPrefix(
  objectKey: string,
  prefix: string | undefined
): boolean {
  const normalizedPrefix = normalizePrefix(prefix);
  if (!normalizedPrefix) {
    return true;
  }
  return (
    objectKey === normalizedPrefix ||
    objectKey.startsWith(`${normalizedPrefix}/`)
  );
}

function isRequestWithinMountScope(
  realPath: string,
  url: URL,
  bucket: string,
  prefix: string | undefined
): boolean {
  const objectKey = getObjectKeyForPath(realPath, bucket);
  if (objectKey === null) {
    return false;
  }

  const requestedPrefix = url.searchParams.get('prefix');
  if (objectKey !== '' && !isObjectKeyWithinPrefix(objectKey, prefix)) {
    return false;
  }

  if (
    objectKey === '' &&
    normalizePrefix(prefix) !== undefined &&
    url.search !== '' &&
    requestedPrefix === null
  ) {
    return false;
  }

  if (requestedPrefix !== null) {
    return isObjectKeyWithinPrefix(requestedPrefix, prefix);
  }

  return true;
}

function isBucketRootProbe(
  request: Request,
  realPath: string,
  url: URL,
  bucket: string
): boolean {
  const method = request.method.toUpperCase();
  return (
    (method === 'GET' || method === 'HEAD') &&
    url.search === '' &&
    getObjectKeyForPath(realPath, bucket) === ''
  );
}

function deleteDirectoryMarkerCacheEntry(
  mountId: string,
  realPath: string
): void {
  directoryMarkerCache.delete(getDirectoryMarkerCacheKey(mountId, realPath));
}

function getContentLength(request: Request): number | null {
  const contentLength = request.headers.get('content-length');
  if (contentLength === null) {
    return null;
  }
  const parsed = Number(contentLength);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function getSigV4ForwardInit(request: Request): RequestInit {
  const contentLength = getContentLength(request);
  if (contentLength === 0) {
    return { body: new Uint8Array(0) };
  }
  if (contentLength === null || request.body === null) {
    return {};
  }

  const { readable, writable } = new FixedLengthStream(contentLength);
  request.body.pipeTo(writable).catch((error) => {
    writable.abort(error).catch(() => {});
  });
  return { body: readable };
}

function getGCSHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const [k, v] of request.headers as unknown as Iterable<
    [string, string]
  >) {
    const lower = k.toLowerCase();
    if (
      DUMMY_AUTH_HEADERS.has(lower) ||
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'expect'
    ) {
      continue;
    }
    if (lower.startsWith('x-amz-meta-')) {
      headers.set(`x-goog-meta-${lower.slice('x-amz-meta-'.length)}`, v);
      continue;
    }
    if (lower.startsWith('x-amz-')) {
      continue;
    }
    headers.set(k, v);
  }
  return headers;
}

async function signAndForwardSigV4(
  request: Request,
  mountId: string,
  endpoint: string,
  provider: BucketProvider | null,
  credentials: { accessKeyId: string; secretAccessKey: string },
  requestInfo: CredentialProxyRequestInfo
): Promise<Response> {
  const signingStarted = Date.now();
  const region = detectS3Region(provider, endpoint);
  const payload = getSigV4PayloadHash(request.headers);
  const client = getSigV4Client(
    mountId,
    endpoint,
    provider,
    credentials,
    region
  );
  requestInfo.payloadHashMode = payload.mode;
  // clientSetupMs captures region detection + client cache lookup + payload hash;
  // the actual SigV4 signing happens inside client.fetch() and is included in upstreamMs.
  requestInfo.clientSetupMs = Date.now() - signingStarted;

  const upstreamStarted = Date.now();
  const forwardInit = getSigV4ForwardInit(request);
  requestInfo.bodyPresent =
    forwardInit?.body !== undefined || request.body !== null;
  const response = await client.fetch(request, forwardInit);
  requestInfo.upstreamMs = Date.now() - upstreamStarted;
  return response;
}

async function signAndForwardGCS(
  request: Request,
  credentials: { accessKeyId: string; secretAccessKey: string },
  requestInfo: CredentialProxyRequestInfo
): Promise<Response> {
  const url = new URL(request.url);
  const gcsHeaders = getGCSHeaders(request);
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
    ['host', url.host],
    ['x-goog-content-sha256', bodyHash],
    ['x-goog-date', dateStr]
  ];

  for (const [k, v] of gcsHeaders as unknown as Iterable<[string, string]>) {
    headerEntries.push([k.toLowerCase(), v.trim()]);
  }

  headerEntries.sort((a, b) => a[0].localeCompare(b[0]));
  const signedHeaders = headerEntries.map(([k]) => k).join(';');
  const canonicalHeaders = headerEntries
    .map(([k, v]) => `${k}:${v}\n`)
    .join('');

  const canonicalRequest = [
    request.method,
    getCanonicalURI(url),
    getCanonicalQueryString(url),
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

  const newHeaders = new Headers(gcsHeaders);
  newHeaders.set('x-goog-date', dateStr);
  newHeaders.set('x-goog-content-sha256', bodyHash);
  newHeaders.set('Authorization', authorization);

  const contentLength = getContentLength(request);
  const gcsBody = contentLength === 0 ? new Uint8Array(0) : request.body;
  const upstreamStarted = Date.now();
  const response = await fetch(
    new Request(request.url, {
      method: request.method,
      headers: newHeaders,
      body: gcsBody
    })
  );
  requestInfo.upstreamMs = Date.now() - upstreamStarted;
  return response;
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

  const debugConfig = getCredentialProxyDebugConfig(env);

  if (url.pathname === DIAGNOSTICS_PATH) {
    if (!debugConfig.enabled || !debugConfig.diagnosticsEndpointEnabled) {
      return new Response('Not Found', { status: 404 });
    }
    return getCredentialProxyDiagnosticsResponse(url, ctx.containerId);
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
    realPath = mountId ? url.pathname.slice(`/${mountId}`.length) || '/' : '/';
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
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      return new Response('Forbidden: bucket mount is read-only', {
        status: 403
      });
    }
  }

  const realUrl = new URL(realPath + (url.search || ''), mount.endpoint);
  if (isBucketRootProbe(request, realPath, url, mount.bucket)) {
    return new Response(null, { status: 200 });
  }
  if (!isRequestWithinMountScope(realPath, url, mount.bucket, mount.prefix)) {
    return new Response('Forbidden: request is outside mounted bucket scope', {
      status: 403
    });
  }
  const cleanHeaders = buildCleanHeaders(request.headers);
  const cleanRequest = new Request(realUrl.toString(), {
    method: request.method,
    headers: cleanHeaders,
    body: request.body
  });
  const requestInfo: CredentialProxyRequestInfo = {
    authStrategy: mount.authStrategy,
    bucket: mount.bucket,
    contentLength: request.headers.get('content-length'),
    method: request.method,
    mountId,
    query: [...url.searchParams.keys()].sort()
  };

  if (isZeroLengthDirectoryMarkerPUT(cleanRequest, realPath)) {
    const responseHeaders = getDirectoryMarkerResponseHeaders(cleanRequest);
    requestInfo.bodyPresent = request.body !== null;
    if (mount.authStrategy === 's3-sigv4') {
      requestInfo.payloadHashMode = getSigV4PayloadHash(
        cleanRequest.headers
      ).mode;
    }
    return withCredentialProxyDiagnostics(
      requestInfo,
      debugConfig,
      ctx.containerId,
      realPath,
      async () => {
        const response =
          mount.authStrategy === 'gcs'
            ? await signAndForwardGCS(
                cleanRequest,
                mount.credentials,
                requestInfo
              )
            : await signAndForwardSigV4(
                cleanRequest,
                mountId,
                mount.endpoint,
                mount.provider,
                mount.credentials,
                requestInfo
              );

        if (response.ok) {
          directoryMarkerCache.set(
            getDirectoryMarkerCacheKey(mountId, realPath),
            responseHeaders
          );
        }

        return response;
      }
    );
  }

  if (isDirectoryMarkerHEAD(cleanRequest)) {
    const responseHeaders = directoryMarkerCache.get(
      getDirectoryMarkerCacheKey(mountId, realPath)
    );
    if (responseHeaders) {
      requestInfo.bodyPresent = false;
      if (mount.authStrategy === 's3-sigv4') {
        requestInfo.payloadHashMode = getSigV4PayloadHash(
          cleanRequest.headers
        ).mode;
      }
      return withCredentialProxyDiagnostics(
        requestInfo,
        debugConfig,
        ctx.containerId,
        realPath,
        () =>
          Promise.resolve(
            new Response(null, {
              status: 200,
              headers: responseHeaders
            })
          )
      );
    }
  }

  if (cleanRequest.method.toUpperCase() !== 'HEAD') {
    deleteDirectoryMarkerCacheEntry(mountId, realPath);
  }

  if (mount.authStrategy === 'gcs') {
    return withCredentialProxyDiagnostics(
      requestInfo,
      debugConfig,
      ctx.containerId,
      realPath,
      () => signAndForwardGCS(cleanRequest, mount.credentials, requestInfo)
    );
  }

  return withCredentialProxyDiagnostics(
    requestInfo,
    debugConfig,
    ctx.containerId,
    realPath,
    () =>
      signAndForwardSigV4(
        cleanRequest,
        mountId,
        mount.endpoint,
        mount.provider,
        mount.credentials,
        requestInfo
      )
  );
};
