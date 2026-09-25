import { WorkerEntrypoint } from "cloudflare:workers";
import * as z from "zod/mini";

import { type DirectoryBackupGatewayProps, type DirectoryBackupPart } from "./contracts.js";
import { handleDirectoryBackupRequest } from "./gateway.js";

/**
 * Moves directory backups between a container and an R2 bucket binding. Export it from the
 * Worker and pass `ctx.exports.DirectoryBackupGateway` to `DirectoryBackups`.
 *
 * The container reaches `fetch()` through the outbound intercept and can only use the grant
 * its current operation holds. The other methods are for the Durable Object alone.
 */
export class DirectoryBackupGateway extends WorkerEntrypoint<object, DirectoryBackupGatewayProps> {
  override fetch(request: Request): Promise<Response> {
    return handleDirectoryBackupRequest(request, this.ctx.props, this.#bucket);
  }

  async createUpload(name?: string): Promise<string> {
    const { bucket, key } = this.#control();
    const options: R2MultipartOptions = { httpMetadata: { contentType: "application/zstd" } };
    if (name !== undefined) options.customMetadata = { name };
    const upload = await bucket.createMultipartUpload(key, options);
    return upload.uploadId;
  }

  async completeUpload(uploadId: string, parts: readonly DirectoryBackupPart[]): Promise<number> {
    const { bucket, key } = this.#control();
    const object = await bucket
      .resumeMultipartUpload(key, uploadId)
      .complete(parts.map(({ partNumber, etag }) => ({ partNumber, etag })));
    return object.size;
  }

  async abortUpload(uploadId: string): Promise<void> {
    const { bucket, key } = this.#control();
    await bucket.resumeMultipartUpload(key, uploadId).abort();
  }

  async deleteObject(): Promise<void> {
    const { bucket, key } = this.#control();
    await bucket.delete(key);
  }

  /** The bucket and key of a control call. Only the Durable Object holds control props. */
  #control() {
    const props = this.ctx.props;
    if (props.protocolVersion !== 1 || props.mode !== "control") {
      throw new Error("DirectoryBackupGateway control methods require control props");
    }
    return { bucket: this.#bucket(props.binding), key: props.key };
  }

  readonly #bucket = (binding: string): R2Bucket => {
    const value: R2Bucket | undefined = Object.getOwnPropertyDescriptor(this.env, binding)?.value;
    if (value === undefined || !bucketSchema.safeParse(value).success) {
      throw new TypeError(`env.${binding} is not an R2 bucket binding`);
    }
    return value;
  };
}

const bucketSchema = z.object({
  get: z.function(),
  delete: z.function(),
  createMultipartUpload: z.function(),
  resumeMultipartUpload: z.function(),
});
