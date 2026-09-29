import { type DirectoryBackupGatewayProps } from "./contracts.js";

/** The R2 calls the gateway makes. An `R2Bucket` binding provides them. */
export interface BackupBucket {
  get(
    key: string,
    options: { range: { offset: number; length: number } },
  ): Promise<{ readonly size: number; readonly body: ReadableStream<Uint8Array> } | null>;
  delete(key: string): Promise<void>;
  createMultipartUpload(key: string, options: R2MultipartOptions): Promise<{ uploadId: string }>;
  resumeMultipartUpload(key: string, uploadId: string): BackupUpload;
}

interface BackupUpload {
  uploadPart(partNumber: number, body: ReadableStream<Uint8Array>): Promise<{ etag: string }>;
  complete(parts: R2UploadedPart[]): Promise<{ readonly size: number }>;
  abort(): Promise<void>;
}

/** Looks up the R2 bucket binding that props name. */
export type BucketResolver = (binding: string) => BackupBucket;

const PART_PATH = /^\/parts\/([1-9][0-9]{0,8})$/;
const RANGE = /^bytes=([0-9]{1,15})-([0-9]{1,15})$/;
const MAX_DETAIL_LENGTH = 1_024;

/**
 * Serves the container's requests for the operation that holds the lock: part uploads for a
 * write grant, byte ranges for a read grant, and nothing else. The key comes from props, never
 * from the request.
 */
export async function handleDirectoryBackupRequest(
  request: Request,
  props: DirectoryBackupGatewayProps,
  resolveBucket: BucketResolver,
): Promise<Response> {
  if (props.protocolVersion !== 1) return text(500, "gateway protocol is incompatible");
  switch (props.mode) {
    case "write":
      return servePart(request, resolveBucket(props.binding), props.key, props.uploadId);
    case "read":
      return serveRange(request, resolveBucket(props.binding), props.key);
    default:
      return text(403, "no directory backup operation holds a grant");
  }
}

/** `PUT /parts/<N>`: uploads one part of the granted multipart upload. */
async function servePart(
  request: Request,
  bucket: BackupBucket,
  key: string,
  uploadId: string,
): Promise<Response> {
  const part = PART_PATH.exec(new URL(request.url).pathname);
  if (request.method !== "PUT" || part === null) {
    return text(403, "the grant allows only part uploads");
  }
  const length = Number(request.headers.get("content-length") ?? Number.NaN);
  if (!Number.isSafeInteger(length) || length <= 0 || request.body === null) {
    return text(411, "a part needs a Content-Length");
  }
  try {
    // uploadPart() needs a stream of known length.
    const { readable, writable } = new FixedLengthStream(length);
    const upload = bucket.resumeMultipartUpload(key, uploadId);
    const [uploaded] = await Promise.all([
      upload.uploadPart(Number(part[1]), readable),
      request.body.pipeTo(writable),
    ]);
    return Response.json({ etag: uploaded.etag });
  } catch (error) {
    return text(502, error instanceof Error ? error.message : "R2 rejected the part");
  }
}

/** `GET /object` with `Range: bytes=a-b`: reads one range of the granted object. */
async function serveRange(request: Request, bucket: BackupBucket, key: string): Promise<Response> {
  const range = RANGE.exec(request.headers.get("range") ?? "");
  if (request.method !== "GET" || new URL(request.url).pathname !== "/object" || range === null) {
    return text(403, "the grant allows only ranged reads of the backup");
  }
  const offset = Number(range[1]);
  const last = Number(range[2]);
  if (last < offset) return text(416, "invalid range");
  try {
    const object = await bucket.get(key, { range: { offset, length: last - offset + 1 } });
    if (object === null) return text(404, "the backup object does not exist");
    const end = Math.min(last, object.size - 1);
    if (end < offset) return text(416, "the range starts past the end of the object");
    return new Response(object.body, {
      status: 206,
      headers: { "content-range": `bytes ${offset}-${end}/${object.size}` },
    });
  } catch (error) {
    return text(502, error instanceof Error ? error.message : "R2 rejected the range");
  }
}

function text(status: number, detail: string): Response {
  return new Response(detail.slice(0, MAX_DETAIL_LENGTH), { status });
}
