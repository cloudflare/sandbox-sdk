import { type DirectoryBackupGatewayProps, type DirectoryBackupPart } from "./contracts.js";

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
  if (props.mode !== "write" && props.mode !== "read") {
    return text(403, "no directory backup operation holds a grant");
  }
  const url = new URL(request.url);
  const bucket = resolveBucket(props.binding);

  if (props.mode === "write") {
    const part = PART_PATH.exec(url.pathname);
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
      const upload = bucket.resumeMultipartUpload(props.key, props.uploadId);
      const [uploaded] = await Promise.all([
        upload.uploadPart(Number(part[1]), readable),
        request.body.pipeTo(writable),
      ]);
      return Response.json({ etag: uploaded.etag });
    } catch (error) {
      return text(502, error instanceof Error ? error.message : "R2 rejected the part");
    }
  }

  const range = RANGE.exec(request.headers.get("range") ?? "");
  if (request.method !== "GET" || url.pathname !== "/object" || range === null) {
    return text(403, "the grant allows only ranged reads of the backup");
  }
  const offset = Number(range[1]);
  const last = Number(range[2]);
  if (last < offset) return text(416, "invalid range");
  try {
    const object = await bucket.get(props.key, { range: { offset, length: last - offset + 1 } });
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

/** The R2 calls only the Durable Object makes, through RPC with control props. */
export class BackupControl {
  readonly #bucket: BackupBucket;
  readonly #key: string;

  constructor(props: DirectoryBackupGatewayProps, resolveBucket: BucketResolver) {
    if (props.protocolVersion !== 1 || props.mode !== "control") {
      throw new Error("DirectoryBackupGateway control methods require control props");
    }
    this.#bucket = resolveBucket(props.binding);
    this.#key = props.key;
  }

  async createUpload(name: string | undefined): Promise<string> {
    const options: R2MultipartOptions = { httpMetadata: { contentType: "application/zstd" } };
    if (name !== undefined) options.customMetadata = { name };
    const upload = await this.#bucket.createMultipartUpload(this.#key, options);
    return upload.uploadId;
  }

  async completeUpload(uploadId: string, parts: readonly DirectoryBackupPart[]): Promise<number> {
    const upload = this.#bucket.resumeMultipartUpload(this.#key, uploadId);
    const object = await upload.complete(
      parts.map(({ partNumber, etag }) => ({ partNumber, etag })),
    );
    return object.size;
  }

  async abortUpload(uploadId: string): Promise<void> {
    await this.#bucket.resumeMultipartUpload(this.#key, uploadId).abort();
  }

  async deleteObject(): Promise<void> {
    await this.#bucket.delete(this.#key);
  }
}

function text(status: number, detail: string): Response {
  return new Response(detail.slice(0, MAX_DETAIL_LENGTH), { status });
}
