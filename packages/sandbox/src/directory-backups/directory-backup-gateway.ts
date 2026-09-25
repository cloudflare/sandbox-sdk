import { WorkerEntrypoint } from "cloudflare:workers";
import * as z from "zod/mini";

import { type DirectoryBackupGatewayProps, type DirectoryBackupPart } from "./contracts.js";
import { BackupControl, handleDirectoryBackupRequest } from "./gateway.js";

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
    return new BackupControl(this.ctx.props, this.#bucket).createUpload(name);
  }

  async completeUpload(uploadId: string, parts: readonly DirectoryBackupPart[]): Promise<number> {
    return new BackupControl(this.ctx.props, this.#bucket).completeUpload(uploadId, parts);
  }

  async abortUpload(uploadId: string): Promise<void> {
    return new BackupControl(this.ctx.props, this.#bucket).abortUpload(uploadId);
  }

  async deleteObject(): Promise<void> {
    return new BackupControl(this.ctx.props, this.#bucket).deleteObject();
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
