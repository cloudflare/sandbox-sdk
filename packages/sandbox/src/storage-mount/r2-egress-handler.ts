/**
 * Egress handler that translates S3 API requests from s3fs into R2 binding calls.
 *
 * When s3fs inside the container makes requests to http://r2.internal/<bucket>/...,
 * the Cloudflare egress interception layer routes them here. The bucket name is read
 * from the first path segment, resolved to a Worker R2 binding, and the request is
 * executed via the R2 binding API — no S3 credentials ever touch the container.
 *
 * S3 path-style layout: /bucketName/objectKey
 * Query params drive operation selection (list-type=2, uploads, uploadId, location).
 */

import type {
  OutboundHandler,
  OutboundHandlerContext
} from '@cloudflare/containers';
import { isR2Bucket } from './validation';

// ---------------------------------------------------------------------------
// Per-instance bucket allowlist
//
// Maps containerId → Set of bucket binding names that this sandbox instance
// is explicitly permitted to access. Populated by mountBucketR2Egress() and
// cleaned up on unmount/destroy. Requests for buckets not in this set are
// rejected with 403 to prevent a sandbox from reaching R2 bindings it was
// never told to mount.
// ---------------------------------------------------------------------------

const allowedBuckets = new Map<string, Set<string>>();

export function registerBucketAccess(
  containerId: string,
  bucketName: string
): void {
  const existing = allowedBuckets.get(containerId);
  if (existing) {
    existing.add(bucketName);
  } else {
    allowedBuckets.set(containerId, new Set([bucketName]));
  }
}

export function revokeBucketAccess(
  containerId: string,
  bucketName: string
): void {
  const buckets = allowedBuckets.get(containerId);
  if (!buckets) return;
  buckets.delete(bucketName);
  if (buckets.size === 0) allowedBuckets.delete(containerId);
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

const XML_NS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmlResponse(body: string, status = 200): Response {
  return new Response(XML_DECL + body, {
    status,
    headers: { 'Content-Type': 'application/xml' }
  });
}

// ---------------------------------------------------------------------------
// Path / query parsing
// ---------------------------------------------------------------------------

interface ParsedPath {
  bucket: string;
  key: string;
}

function parsePath(pathname: string): ParsedPath | null {
  const stripped = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  if (!stripped) return null;
  const slash = stripped.indexOf('/');
  if (slash === -1) return { bucket: stripped, key: '' };
  return { bucket: stripped.slice(0, slash), key: stripped.slice(slash + 1) };
}

// ---------------------------------------------------------------------------
// R2 binding resolution
// ---------------------------------------------------------------------------

function resolveR2Bucket(env: unknown, name: string): R2Bucket | null {
  if (typeof env !== 'object' || env === null) return null;
  const val = (env as Record<string, unknown>)[name];
  return isR2Bucket(val) ? val : null;
}

// ---------------------------------------------------------------------------
// Range header parsing
// ---------------------------------------------------------------------------

function parseRange(header: string | null): R2Range | undefined {
  if (!header) return undefined;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return undefined;
  const start = m[1] ? parseInt(m[1], 10) : undefined;
  const end = m[2] ? parseInt(m[2], 10) : undefined;

  if (start === undefined && end !== undefined) {
    return { suffix: end };
  }
  if (start !== undefined && end !== undefined) {
    return { offset: start, length: end - start + 1 };
  }
  if (start !== undefined) {
    return { offset: start };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// S3 XML response builders
// ---------------------------------------------------------------------------

function buildListObjectsV2Xml(
  bucketName: string,
  prefix: string,
  delimiter: string,
  maxKeys: number,
  result: R2Objects
): string {
  const contents = result.objects
    .map(
      (obj) =>
        `<Contents>` +
        `<Key>${escapeXml(obj.key)}</Key>` +
        `<LastModified>${obj.uploaded.toISOString()}</LastModified>` +
        `<ETag>${escapeXml(obj.httpEtag)}</ETag>` +
        `<Size>${obj.size}</Size>` +
        `<StorageClass>STANDARD</StorageClass>` +
        `</Contents>`
    )
    .join('');

  const commonPrefixes = result.delimitedPrefixes
    .map(
      (p) => `<CommonPrefixes><Prefix>${escapeXml(p)}</Prefix></CommonPrefixes>`
    )
    .join('');

  const nextToken =
    result.truncated && result.cursor
      ? `<NextContinuationToken>${escapeXml(result.cursor)}</NextContinuationToken>`
      : '';

  const keyCount = result.objects.length + result.delimitedPrefixes.length;

  return (
    `<ListBucketResult ${XML_NS}>` +
    `<Name>${escapeXml(bucketName)}</Name>` +
    `<Prefix>${escapeXml(prefix)}</Prefix>` +
    `<KeyCount>${keyCount}</KeyCount>` +
    `<MaxKeys>${maxKeys}</MaxKeys>` +
    (delimiter ? `<Delimiter>${escapeXml(delimiter)}</Delimiter>` : '') +
    `<IsTruncated>${result.truncated}</IsTruncated>` +
    nextToken +
    contents +
    commonPrefixes +
    `</ListBucketResult>`
  );
}

function buildLocationXml(): string {
  return `<LocationConstraint ${XML_NS}/>`;
}

function buildInitiateMultipartUploadXml(
  bucketName: string,
  key: string,
  uploadId: string
): string {
  return (
    `<InitiateMultipartUploadResult ${XML_NS}>` +
    `<Bucket>${escapeXml(bucketName)}</Bucket>` +
    `<Key>${escapeXml(key)}</Key>` +
    `<UploadId>${escapeXml(uploadId)}</UploadId>` +
    `</InitiateMultipartUploadResult>`
  );
}

function buildCompleteMultipartUploadXml(
  bucketName: string,
  key: string,
  etag: string
): string {
  return (
    `<CompleteMultipartUploadResult ${XML_NS}>` +
    `<Location>http://r2.internal/${escapeXml(bucketName)}/${escapeXml(key)}</Location>` +
    `<Bucket>${escapeXml(bucketName)}</Bucket>` +
    `<Key>${escapeXml(key)}</Key>` +
    `<ETag>${escapeXml(etag)}</ETag>` +
    `</CompleteMultipartUploadResult>`
  );
}

function buildCopyObjectXml(etag: string, uploaded: Date): string {
  return (
    `<CopyObjectResult ${XML_NS}>` +
    `<LastModified>${uploaded.toISOString()}</LastModified>` +
    `<ETag>${escapeXml(etag)}</ETag>` +
    `</CopyObjectResult>`
  );
}

// ---------------------------------------------------------------------------
// CompleteMultipartUpload XML body parser
// ---------------------------------------------------------------------------

interface UploadedPart {
  partNumber: number;
  etag: string;
}

function parseCompleteMultipartUploadBody(body: string): UploadedPart[] {
  const parts: UploadedPart[] = [];
  const partSegments = body.match(/<Part>[\s\S]*?<\/Part>/g) ?? [];
  for (const segment of partSegments) {
    const numMatch = /<PartNumber>(\d+)<\/PartNumber>/.exec(segment);
    const etagMatch = /<ETag>("?[^<]+"?)<\/ETag>/.exec(segment);
    if (numMatch && etagMatch) {
      parts.push({
        partNumber: parseInt(numMatch[1], 10),
        etag: etagMatch[1].replace(/^"|"$/g, '')
      });
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// HTTP metadata helpers
// ---------------------------------------------------------------------------

function buildResponseHeaders(obj: R2Object): Headers {
  const headers = new Headers();
  headers.set('ETag', obj.httpEtag);
  headers.set('Content-Length', String(obj.size));
  headers.set('Last-Modified', obj.uploaded.toUTCString());
  headers.set('Accept-Ranges', 'bytes');
  if (obj.httpMetadata?.contentType) {
    headers.set('Content-Type', obj.httpMetadata.contentType);
  }
  if (obj.httpMetadata?.contentDisposition) {
    headers.set('Content-Disposition', obj.httpMetadata.contentDisposition);
  }
  if (obj.httpMetadata?.contentEncoding) {
    headers.set('Content-Encoding', obj.httpMetadata.contentEncoding);
  }
  if (obj.httpMetadata?.contentLanguage) {
    headers.set('Content-Language', obj.httpMetadata.contentLanguage);
  }
  if (obj.httpMetadata?.cacheControl) {
    headers.set('Cache-Control', obj.httpMetadata.cacheControl);
  }
  return headers;
}

function buildContentRange(range: R2Range, totalSize: number): string {
  if ('suffix' in range) {
    const start = Math.max(0, totalSize - range.suffix);
    return `bytes ${start}-${totalSize - 1}/${totalSize}`;
  }
  const start = range.offset ?? 0;
  const end =
    range.length !== undefined ? start + range.length - 1 : totalSize - 1;
  return `bytes ${start}-${end}/${totalSize}`;
}

function extractHttpMetadata(request: Request): R2HTTPMetadata {
  const meta: R2HTTPMetadata = {};
  const ct = request.headers.get('Content-Type');
  if (ct) meta.contentType = ct;
  const cd = request.headers.get('Content-Disposition');
  if (cd) meta.contentDisposition = cd;
  const ce = request.headers.get('Content-Encoding');
  if (ce) meta.contentEncoding = ce;
  const cl = request.headers.get('Content-Language');
  if (cl) meta.contentLanguage = cl;
  const cc = request.headers.get('Cache-Control');
  if (cc) meta.cacheControl = cc;
  return meta;
}

function parseCopySource(header: string): ParsedPath | null {
  const sourcePath = header.split('?')[0] ?? '';
  if (!sourcePath) return null;
  const decoded = decodeURIComponent(sourcePath);
  return parsePath(decoded.startsWith('/') ? decoded : `/${decoded}`);
}

function normalizeStorageClass(
  storageClass: string | undefined
): 'Standard' | 'InfrequentAccess' | undefined {
  if (storageClass === 'Standard' || storageClass === 'InfrequentAccess') {
    return storageClass;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Operation handlers
// ---------------------------------------------------------------------------

async function handleListObjects(
  r2: R2Bucket,
  bucketName: string,
  url: URL
): Promise<Response> {
  const prefix = url.searchParams.get('prefix') ?? '';
  const delimiter = url.searchParams.get('delimiter') ?? '';
  const maxKeys = Math.min(
    parseInt(url.searchParams.get('max-keys') ?? '1000', 10),
    1000
  );
  const continuationToken =
    url.searchParams.get('continuation-token') ?? undefined;

  const listOpts: R2ListOptions = {
    prefix: prefix || undefined,
    delimiter: delimiter || undefined,
    limit: maxKeys,
    cursor: continuationToken
  };

  const result = await r2.list(listOpts);
  return xmlResponse(
    buildListObjectsV2Xml(bucketName, prefix, delimiter, maxKeys, result)
  );
}

async function handleHeadObject(r2: R2Bucket, key: string): Promise<Response> {
  const obj = await r2.head(key);
  if (!obj) {
    return new Response(null, { status: 404 });
  }
  return new Response(null, {
    status: 200,
    headers: buildResponseHeaders(obj)
  });
}

async function handleGetObject(
  r2: R2Bucket,
  key: string,
  request: Request
): Promise<Response> {
  const range = parseRange(request.headers.get('Range'));

  if (!range) {
    const obj = await r2.get(key);
    if (!obj) {
      return new Response(null, { status: 404 });
    }
    return new Response(obj.body, {
      status: 200,
      headers: buildResponseHeaders(obj)
    });
  }

  const [headObj, rangeObj] = await Promise.all([
    r2.head(key),
    r2.get(key, { range })
  ]);
  if (!headObj || !rangeObj) {
    return new Response(null, { status: 404 });
  }

  const headers = buildResponseHeaders(rangeObj);
  headers.set('Content-Range', buildContentRange(range, headObj.size));
  headers.set('Content-Length', String(rangeObj.size));

  return new Response(rangeObj.body, { status: 206, headers });
}

async function handlePutObject(
  r2: R2Bucket,
  bucketName: string,
  key: string,
  request: Request,
  env: Cloudflare.Env,
  permitted: Set<string>
): Promise<Response> {
  const copySourceHeader = request.headers.get('x-amz-copy-source');
  if (copySourceHeader) {
    const copySource = parseCopySource(copySourceHeader);
    if (!copySource || !copySource.key) {
      return new Response('Bad Request: invalid x-amz-copy-source', {
        status: 400
      });
    }

    if (!permitted.has(copySource.bucket)) {
      return new Response(
        `Access to R2 bucket "${copySource.bucket}" is not permitted. ` +
          'Call mountBucket() with this bucket before accessing it.',
        { status: 403 }
      );
    }

    const sourceBucket =
      copySource.bucket === bucketName
        ? r2
        : resolveR2Bucket(env, copySource.bucket);
    if (!sourceBucket) {
      return new Response(
        `R2 binding "${copySource.bucket}" not found in Worker env. ` +
          'Ensure the binding name matches the bucket name passed to mountBucket().',
        { status: 500 }
      );
    }

    const sourceObject = await sourceBucket.get(copySource.key);
    if (!sourceObject) {
      return new Response(null, { status: 404 });
    }

    const metadataDirective = request.headers.get('x-amz-metadata-directive');
    const httpMetadata =
      metadataDirective?.toUpperCase() === 'REPLACE'
        ? extractHttpMetadata(request)
        : sourceObject.httpMetadata;
    const result = await r2.put(key, sourceObject.body, {
      httpMetadata,
      customMetadata: sourceObject.customMetadata,
      storageClass: normalizeStorageClass(sourceObject.storageClass)
    });
    return xmlResponse(buildCopyObjectXml(result.httpEtag, result.uploaded));
  }

  const httpMetadata = extractHttpMetadata(request);
  const result = await r2.put(key, request.body, { httpMetadata });
  const headers = new Headers();
  headers.set('ETag', result.httpEtag);
  return new Response(null, { status: 200, headers });
}

async function handleDeleteObject(
  r2: R2Bucket,
  key: string
): Promise<Response> {
  await r2.delete(key);
  return new Response(null, { status: 204 });
}

async function handleCreateMultipartUpload(
  r2: R2Bucket,
  bucketName: string,
  key: string,
  request: Request
): Promise<Response> {
  const httpMetadata = extractHttpMetadata(request);
  const upload = await r2.createMultipartUpload(key, { httpMetadata });
  return xmlResponse(
    buildInitiateMultipartUploadXml(bucketName, key, upload.uploadId)
  );
}

async function handleUploadPart(
  r2: R2Bucket,
  key: string,
  url: URL,
  request: Request
): Promise<Response> {
  const uploadId = url.searchParams.get('uploadId') ?? '';
  const partNumber = parseInt(url.searchParams.get('partNumber') ?? '0', 10);
  if (!uploadId || !partNumber) {
    return new Response('Bad Request: missing uploadId or partNumber', {
      status: 400
    });
  }
  const upload = r2.resumeMultipartUpload(key, uploadId);
  const part = await upload.uploadPart(
    partNumber,
    request.body as ReadableStream
  );
  const headers = new Headers();
  headers.set('ETag', `"${part.etag}"`);
  return new Response(null, { status: 200, headers });
}

async function handleCompleteMultipartUpload(
  r2: R2Bucket,
  bucketName: string,
  key: string,
  url: URL,
  request: Request
): Promise<Response> {
  const uploadId = url.searchParams.get('uploadId') ?? '';
  if (!uploadId) {
    return new Response('Bad Request: missing uploadId', { status: 400 });
  }
  const bodyText = await request.text();
  const parsedParts = parseCompleteMultipartUploadBody(bodyText);
  const r2Parts: R2UploadedPart[] = parsedParts.map((p) => ({
    partNumber: p.partNumber,
    etag: p.etag
  }));
  const upload = r2.resumeMultipartUpload(key, uploadId);
  const result = await upload.complete(r2Parts);
  return xmlResponse(
    buildCompleteMultipartUploadXml(bucketName, key, result.httpEtag)
  );
}

async function handleAbortMultipartUpload(
  r2: R2Bucket,
  key: string,
  url: URL
): Promise<Response> {
  const uploadId = url.searchParams.get('uploadId') ?? '';
  if (!uploadId) {
    return new Response('Bad Request: missing uploadId', { status: 400 });
  }
  const upload = r2.resumeMultipartUpload(key, uploadId);
  await upload.abort();
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export const r2EgressHandler: OutboundHandler = async (
  request: Request,
  env: Cloudflare.Env,
  ctx: OutboundHandlerContext
): Promise<Response> => {
  const url = new URL(request.url);
  const parsed = parsePath(url.pathname);

  if (!parsed) {
    return new Response('Bad Request: empty path', { status: 400 });
  }

  const { bucket: bucketName, key } = parsed;

  const permitted = allowedBuckets.get(ctx.containerId);
  if (!permitted?.has(bucketName)) {
    return new Response(
      `Access to R2 bucket "${bucketName}" is not permitted. ` +
        'Call mountBucket() with this bucket before accessing it.',
      { status: 403 }
    );
  }

  const r2 = resolveR2Bucket(env, bucketName);
  if (!r2) {
    return new Response(
      `R2 binding "${bucketName}" not found in Worker env. ` +
        'Ensure the binding name matches the bucket name passed to mountBucket().',
      { status: 500 }
    );
  }

  const { method } = request;

  // Bucket-level operations (no key)
  if (!key) {
    if (method === 'GET' && url.searchParams.has('location')) {
      return xmlResponse(buildLocationXml());
    }
    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      return handleListObjects(r2, bucketName, url);
    }
    // Legacy ListObjects (v1) — s3fs may use this for some operations
    if (method === 'GET') {
      return handleListObjects(r2, bucketName, url);
    }
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Multipart upload: POST /bucket/key?uploads — initiate
  if (method === 'POST' && url.searchParams.has('uploads')) {
    return handleCreateMultipartUpload(r2, bucketName, key, request);
  }

  // Multipart upload: POST /bucket/key?uploadId=X — complete
  if (method === 'POST' && url.searchParams.has('uploadId')) {
    return handleCompleteMultipartUpload(r2, bucketName, key, url, request);
  }

  // Multipart upload: PUT /bucket/key?partNumber=N&uploadId=X — upload part
  if (
    method === 'PUT' &&
    url.searchParams.has('partNumber') &&
    url.searchParams.has('uploadId')
  ) {
    return handleUploadPart(r2, key, url, request);
  }

  // Multipart upload: DELETE /bucket/key?uploadId=X — abort
  if (method === 'DELETE' && url.searchParams.has('uploadId')) {
    return handleAbortMultipartUpload(r2, key, url);
  }

  // Standard object operations
  switch (method) {
    case 'HEAD':
      return handleHeadObject(r2, key);
    case 'GET':
      return handleGetObject(r2, key, request);
    case 'PUT':
      return handlePutObject(r2, bucketName, key, request, env, permitted);
    case 'DELETE':
      return handleDeleteObject(r2, key);
    default:
      return new Response('Method Not Allowed', { status: 405 });
  }
};
