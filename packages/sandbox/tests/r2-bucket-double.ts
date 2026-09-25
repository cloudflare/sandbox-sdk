import type { BackupBucket } from "../src/directory-backups/gateway.js";

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly options: R2MultipartOptions;
}

interface Upload {
  readonly key: string;
  readonly options: R2MultipartOptions;
  readonly parts: Map<number, Uint8Array>;
}

/** An in-memory R2 bucket with the multipart and ranged-read calls the gateway uses. */
export class R2BucketDouble implements BackupBucket {
  readonly objects = new Map<string, StoredObject>();
  readonly uploads = new Map<string, Upload>();
  readonly aborted: string[] = [];
  #nextUpload = 0;

  async get(
    key: string,
    options: { range: { offset: number; length: number } },
  ): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null> {
    const object = this.objects.get(key);
    if (object === undefined) return null;
    const { offset, length } = options.range;
    if (offset >= object.bytes.length) throw new Error("InvalidRange");
    const slice = object.bytes.slice(offset, offset + length);
    return { size: object.bytes.length, body: new Response(slice).body ?? new ReadableStream() };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async createMultipartUpload(
    key: string,
    options: R2MultipartOptions,
  ): Promise<{ uploadId: string }> {
    this.#nextUpload += 1;
    const uploadId = `upload-${this.#nextUpload}`;
    this.uploads.set(uploadId, { key, options, parts: new Map() });
    return { uploadId };
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    const upload = this.uploads.get(uploadId);
    return {
      uploadPart: async (partNumber: number, body: ReadableStream<Uint8Array>) => {
        if (upload?.key !== key) throw new Error("NoSuchUpload");
        upload.parts.set(partNumber, new Uint8Array(await new Response(body).arrayBuffer()));
        return { etag: `etag-${partNumber}` };
      },
      complete: async (parts: R2UploadedPart[]) => {
        if (upload?.key !== key) throw new Error("NoSuchUpload");
        const chunks = parts.map(({ partNumber, etag }) => {
          const part = upload.parts.get(partNumber);
          if (part === undefined || etag !== `etag-${partNumber}`) throw new Error("InvalidPart");
          return part;
        });
        const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        this.objects.set(key, { bytes, options: upload.options });
        this.uploads.delete(uploadId);
        return { size: bytes.length };
      },
      abort: async () => {
        this.aborted.push(uploadId);
        this.uploads.delete(uploadId);
      },
    };
  }
}

/** Node has no `FixedLengthStream`; this one checks the length the gateway declares. */
export class FixedLengthStreamDouble extends TransformStream<Uint8Array, Uint8Array> {
  constructor(expected: number) {
    let seen = 0;
    super({
      transform(chunk, controller) {
        seen += chunk.length;
        controller.enqueue(chunk);
      },
      flush() {
        if (seen !== expected) throw new Error(`expected ${expected} bytes, got ${seen}`);
      },
    });
  }
}
