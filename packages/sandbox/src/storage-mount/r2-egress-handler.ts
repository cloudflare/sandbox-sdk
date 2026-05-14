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
// Per-mount bucket params
//
// Passed through setOutboundByHost params so they are serialized into
// ContainerProxy props and transmitted with every intercepted request.
// This avoids relying on module-level state which is not shared across
// Cloudflare Worker isolates.
// ---------------------------------------------------------------------------

export type R2EgressParams = {
  buckets: Record<string, { prefix?: string; readOnly?: boolean }>;
};

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

function normalizeObjectKey(value: string): string {
  return value.replace(/^\/+/, '');
}

function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}

function parsePath(pathname: string): ParsedPath | null {
  const stripped = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  if (!stripped) return null;
  const slash = stripped.indexOf('/');
  if (slash === -1) return { bucket: stripped, key: '' };
  return {
    bucket: stripped.slice(0, slash),
    key: normalizeObjectKey(stripped.slice(slash + 1))
  };
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

interface ListDisplayObject {
  key: string;
  uploaded: Date;
  httpEtag: string;
  size: number;
}

interface ListDisplayResult {
  objects: ListDisplayObject[];
  delimitedPrefixes: string[];
  truncated: boolean;
  cursor?: string;
}

function buildListObjectsV2Xml(
  bucketName: string,
  prefix: string,
  delimiter: string,
  maxKeys: number,
  result: ListDisplayResult
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

function extractXmlTagContent(segment: string, tagName: string): string | null {
  const openTag = `<${tagName}>`;
  const closeTag = `</${tagName}>`;
  const start = segment.indexOf(openTag);
  if (start === -1) return null;
  const contentStart = start + openTag.length;
  const end = segment.indexOf(closeTag, contentStart);
  if (end === -1) return null;
  return segment.slice(contentStart, end);
}

function parseCompleteMultipartUploadBody(body: string): UploadedPart[] {
  const parts: UploadedPart[] = [];
  let pos = 0;
  while (pos < body.length) {
    const start = body.indexOf('<Part>', pos);
    if (start === -1) break;
    const end = body.indexOf('</Part>', start + 6);
    if (end === -1) break;
    const segment = body.slice(start, end + 7);
    pos = end + 7;
    const partNumberText = extractXmlTagContent(segment, 'PartNumber');
    const etagText = extractXmlTagContent(segment, 'ETag');
    const partNumber = partNumberText ? parseInt(partNumberText, 10) : NaN;
    if (Number.isFinite(partNumber) && etagText) {
      parts.push({
        partNumber,
        etag: etagText.replace(/^"|"$/g, '')
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

function getRangeContentLength(range: R2Range, totalSize: number): number {
  if ('suffix' in range) {
    return Math.min(range.suffix, totalSize);
  }
  const start = range.offset ?? 0;
  if (start >= totalSize) {
    return 0;
  }
  const requestedLength =
    range.length !== undefined ? range.length : totalSize - start;
  return Math.min(requestedLength, totalSize - start);
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
  const parsed = parsePath(decoded.startsWith('/') ? decoded : `/${decoded}`);
  return parsed
    ? {
        bucket: parsed.bucket,
        key: normalizeObjectKey(parsed.key)
      }
    : null;
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
  url: URL,
  mountPrefix?: string
): Promise<Response> {
  const queryPrefix = normalizeObjectKey(url.searchParams.get('prefix') ?? '');
  const delimiter = url.searchParams.get('delimiter') ?? '';
  const maxKeys = Math.min(
    parseInt(url.searchParams.get('max-keys') ?? '1000', 10) || 1000,
    1000
  );
  const continuationToken =
    url.searchParams.get('continuation-token') ?? undefined;

  const r2Prefix = mountPrefix ? `${mountPrefix}/${queryPrefix}` : queryPrefix;

  const listOpts: R2ListOptions = {
    prefix: r2Prefix || undefined,
    delimiter: delimiter || undefined,
    limit: maxKeys,
    cursor: continuationToken
  };

  const result = await r2.list(listOpts);

  const stripKey = mountPrefix
    ? (k: string): string =>
        k.startsWith(`${mountPrefix}/`) ? k.slice(mountPrefix.length + 1) : k
    : (k: string): string => k;

  const displayResult: ListDisplayResult = {
    objects: result.objects.map((obj) => ({
      key: stripKey(obj.key),
      uploaded: obj.uploaded,
      httpEtag: obj.httpEtag,
      size: obj.size
    })),
    delimitedPrefixes: result.delimitedPrefixes.map(stripKey),
    truncated: result.truncated,
    cursor: result.truncated ? result.cursor : undefined
  };

  return xmlResponse(
    buildListObjectsV2Xml(
      bucketName,
      queryPrefix,
      delimiter,
      maxKeys,
      displayResult
    )
  );
}

async function handleHeadObject(r2: R2Bucket, key: string): Promise<Response> {
  const obj = await r2.head(key);
  if (!obj) {
    return new Response(null, { status: 404 });
  }
  // NOTE: The outbound proxy rewrites Content-Length to 0 for bodiless
  // responses. s3fs stat cache must be pre-populated from LIST (readdir)
  // so that getattr never falls through to HEAD for file size information.
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
    const body = await obj.arrayBuffer();
    return new Response(body, {
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

  const rangeBody = await rangeObj.arrayBuffer();
  const headers = buildResponseHeaders(rangeObj);
  headers.set('Content-Range', buildContentRange(range, headObj.size));
  headers.set(
    'Content-Length',
    String(getRangeContentLength(range, headObj.size))
  );

  return new Response(rangeBody, { status: 206, headers });
}

async function handlePutObject(
  r2: R2Bucket,
  bucketName: string,
  key: string,
  request: Request,
  env: Cloudflare.Env,
  permitted: Set<string>,
  mountPrefix?: string
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

    const sourceKey =
      mountPrefix && copySource.bucket === bucketName
        ? `${mountPrefix}/${copySource.key}`
        : copySource.key;
    const sourceObject = await sourceBucket.get(sourceKey);
    if (!sourceObject) {
      return new Response(null, { status: 404 });
    }

    const metadataDirective = request.headers.get('x-amz-metadata-directive');
    const httpMetadata =
      metadataDirective?.toUpperCase() === 'REPLACE'
        ? extractHttpMetadata(request)
        : sourceObject.httpMetadata;
    const sourceBody = await sourceObject.arrayBuffer();
    const result = await r2.put(key, sourceBody, {
      httpMetadata,
      customMetadata: sourceObject.customMetadata,
      storageClass: normalizeStorageClass(sourceObject.storageClass)
    });
    return xmlResponse(buildCopyObjectXml(result.httpEtag, result.uploaded));
  }

  const httpMetadata = extractHttpMetadata(request);
  const body = await request.arrayBuffer();
  const result = await r2.put(key, body, { httpMetadata });
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
  const body = await request.arrayBuffer();
  const part = await upload.uploadPart(partNumber, body);
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

export const r2EgressHandler: OutboundHandler<
  Cloudflare.Env,
  R2EgressParams
> = async (
  request: Request,
  env: Cloudflare.Env,
  ctx: OutboundHandlerContext<R2EgressParams>
): Promise<Response> => {
  const url = new URL(request.url);
  const parsed = parsePath(url.pathname);

  if (!parsed) {
    return new Response('Bad Request: empty path', { status: 400 });
  }

  const { bucket: bucketName, key } = parsed;

  if (!ctx.params?.buckets || !(bucketName in ctx.params.buckets)) {
    return new Response(
      `Access to R2 bucket "${bucketName}" is not permitted. ` +
        'Call mountBucket() with this bucket before accessing it.',
      { status: 403 }
    );
  }

  const bucketParams = ctx.params.buckets[bucketName];
  const rawPrefix = bucketParams.prefix;
  const mountPrefix = rawPrefix
    ? trimTrailingSlashes(normalizeObjectKey(rawPrefix))
    : undefined;
  const readOnly = bucketParams.readOnly ?? false;

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
      return handleListObjects(r2, bucketName, url, mountPrefix);
    }
    // Legacy ListObjects (v1) — s3fs may use this for some operations
    if (method === 'GET') {
      return handleListObjects(r2, bucketName, url, mountPrefix);
    }
    return new Response('Method Not Allowed', { status: 405 });
  }

  const fullKey = mountPrefix ? `${mountPrefix}/${key}` : key;
  const permitted = new Set(Object.keys(ctx.params.buckets));

  if (
    readOnly &&
    (method === 'PUT' ||
      method === 'DELETE' ||
      (method === 'POST' &&
        (url.searchParams.has('uploads') || url.searchParams.has('uploadId'))))
  ) {
    return new Response('Forbidden: bucket mount is read-only', {
      status: 403
    });
  }

  // Multipart upload: POST /bucket/key?uploads — initiate
  if (method === 'POST' && url.searchParams.has('uploads')) {
    return handleCreateMultipartUpload(r2, bucketName, fullKey, request);
  }

  // Multipart upload: POST /bucket/key?uploadId=X — complete
  if (method === 'POST' && url.searchParams.has('uploadId')) {
    return handleCompleteMultipartUpload(r2, bucketName, fullKey, url, request);
  }

  // Multipart upload: PUT /bucket/key?partNumber=N&uploadId=X — upload part
  if (
    method === 'PUT' &&
    url.searchParams.has('partNumber') &&
    url.searchParams.has('uploadId')
  ) {
    return handleUploadPart(r2, fullKey, url, request);
  }

  // Multipart upload: DELETE /bucket/key?uploadId=X — abort
  if (method === 'DELETE' && url.searchParams.has('uploadId')) {
    return handleAbortMultipartUpload(r2, fullKey, url);
  }

  // Standard object operations
  switch (method) {
    case 'HEAD':
      return handleHeadObject(r2, fullKey);
    case 'GET':
      return handleGetObject(r2, fullKey, request);
    case 'PUT':
      return handlePutObject(
        r2,
        bucketName,
        fullKey,
        request,
        env,
        permitted,
        mountPrefix
      );
    case 'DELETE':
      return handleDeleteObject(r2, fullKey);
    default:
      return new Response('Method Not Allowed', { status: 405 });
  }
};
