import * as z from "zod/mini";

import { backupError } from "../shared/errors.js";
import { type OptionRules, validateOptions } from "../shared/options.js";
import {
  DIRECTORY_BACKUP_FORMAT,
  type DirectoryBackup,
  type DirectoryBackupDeleteOptions,
  type DirectoryBackupGatewayBinding,
  type DirectoryBackupGatewayControl,
  type DirectoryBackupGatewayProps,
  type DirectoryBackupOptions,
  type DirectoryBackupStorage,
  type DirectoryRestoreOptions,
} from "./contracts.js";
import { GATEWAY_HOST, runShimExchange } from "./protocol.js";

type DirectoryBackupContainer = Pick<Container, "exec" | "interceptOutboundHttp">;

const absolutePath = z.string().check(
  z.startsWith("/"),
  z.refine((value) => !value.includes("\0")),
);
const SIGNAL = { schema: z.instanceof(AbortSignal), requirement: "must be an AbortSignal" };
const DIR = { schema: absolutePath, requirement: "must be an absolute path without NUL" };
const BACKUP_OPTIONS = {
  dir: DIR,
  name: { schema: z.string(), requirement: "must be a string" },
  exclude: { schema: z.array(z.string()), requirement: "must be an array of strings" },
  gitignore: { schema: z.boolean(), requirement: "must be a boolean" },
  signal: SIGNAL,
} satisfies OptionRules<DirectoryBackupOptions>;
const RESTORE_OPTIONS = { dir: DIR, signal: SIGNAL } satisfies OptionRules<DirectoryRestoreOptions>;
const DELETE_OPTIONS = { signal: SIGNAL } satisfies OptionRules<DirectoryBackupDeleteOptions>;

const sha256Schema = z.string().check(z.regex(/^[0-9a-f]{64}$/));
const recordSchema = z.object({
  id: z.string().check(z.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)),
  dir: absolutePath,
  size: z.number().check(z.refine((value) => Number.isSafeInteger(value) && value > 0)),
  name: z.optional(z.string()),
  sha256: sha256Schema,
  format: z.literal(DIRECTORY_BACKUP_FORMAT),
});
const backupDoneSchema = z.strictObject({
  kind: z.literal("done"),
  size: z.number().check(z.refine((value) => Number.isSafeInteger(value) && value > 0)),
  sha256: sha256Schema,
  parts: z
    .array(
      z.strictObject({
        partNumber: z.number().check(z.int(), z.positive()),
        etag: z.string(),
      }),
    )
    .check(z.minLength(1)),
});
const restoreDoneSchema = z.strictObject({ kind: z.literal("done") });

/**
 * Saves one directory from the running Container to an R2 bucket, and restores it as
 * ordinary files into a Container, which may run a different image.
 *
 * One backup or restore runs at a time per Container; others wait their turn, so
 * `Promise.all()` over several directories works. Start the Container first: this class never
 * starts, retries, or times out anything. The application stores the returned records and
 * decides when to delete them.
 */
export class DirectoryBackups {
  readonly #container: DirectoryBackupContainer;
  readonly #gateway: DirectoryBackupGatewayBinding;
  readonly #binding: string;
  readonly #prefix: string;

  constructor(
    container: DirectoryBackupContainer,
    gateway: DirectoryBackupGatewayBinding,
    storage: DirectoryBackupStorage,
  ) {
    if (!z.string().check(z.minLength(1)).safeParse(storage.binding).success) {
      throw new TypeError("storage.binding must name an R2 bucket binding");
    }
    const prefix = storage.prefix ?? "";
    if (!z.string().safeParse(prefix).success || (prefix !== "" && !prefix.endsWith("/"))) {
      throw new TypeError('storage.prefix must be a string that ends in "/"');
    }
    this.#container = container;
    this.#gateway = gateway;
    this.#binding = storage.binding;
    this.#prefix = prefix;
  }

  /**
   * Backs up `dir` and returns its record. Pause writers in `dir` first: files that change
   * while it's read are captured as they are at that moment.
   *
   * @throws {SandboxFileError} `dir` is missing or not a directory, a file can't be read, or an
   *   exclude pattern is invalid (`EINVAL`).
   * @throws {SandboxBackupError} `BACKUP_TRANSFER` when a part upload fails, or
   *   `BACKUP_INTEGRITY` when R2 stored a different size than was uploaded.
   */
  async backup(options: DirectoryBackupOptions): Promise<DirectoryBackup> {
    validateOptions(options, BACKUP_OPTIONS);
    if (options.dir === undefined) throw new TypeError("dir must be an absolute path without NUL");
    const { dir, name, signal } = options;
    const id = crypto.randomUUID();
    const control = this.#control(this.#key(id));
    const { uploadId, done } = await this.#upload(control, this.#key(id), options);

    let size: number;
    try {
      signal?.throwIfAborted();
      size = await control.completeUpload(uploadId, done.parts);
    } catch (error) {
      await control.abortUpload(uploadId).catch(() => undefined);
      throw error;
    }
    if (size !== done.size) {
      await control.deleteObject().catch(() => undefined);
      throw backupError(
        "BACKUP_INTEGRITY",
        "backup",
        dir,
        `R2 stored ${size} bytes, but the container uploaded ${done.size}`,
      );
    }
    const record = {
      id,
      dir,
      size,
      sha256: done.sha256,
      format: DIRECTORY_BACKUP_FORMAT,
    } satisfies DirectoryBackup;
    return name === undefined ? record : { ...record, name };
  }

  /**
   * Replaces `options.dir`, or the record's `dir`, with the backup's contents. The directory is
   * extracted beside the target and swapped in only after the download is verified, so a failed
   * or aborted restore leaves the target as it was. The target's parent must exist; the target
   * need not.
   *
   * @throws {SandboxFileError} The target's parent is missing (`ENOENT`), the target isn't a
   *   directory (`ENOTDIR`) or is a mount point (`EBUSY`), the swap fails (for example `EXDEV`),
   *   or the disk fills (`ENOSPC`).
   * @throws {SandboxBackupError} `BACKUP_NOT_FOUND`, `BACKUP_INTEGRITY`, or `BACKUP_TRANSFER`.
   */
  async restore(backup: DirectoryBackup, options: DirectoryRestoreOptions = {}): Promise<void> {
    validateOptions(options, RESTORE_OPTIONS);
    const record = parseRecord(backup);
    const dir = options.dir ?? record.dir;
    const key = this.#key(record.id);
    await runShimExchange(this.#container, {
      command: "restore",
      request: { gateway: GATEWAY_HOST, dir, size: record.size, sha256: record.sha256 },
      path: dir,
      signal: options.signal,
      done: restoreDoneSchema,
      grant: () =>
        this.#register({ protocolVersion: 1, mode: "read", binding: this.#binding, key }),
      deny: () => this.#deny(),
    });
  }

  /**
   * Deletes the backup's object. Needs no running Container. Deleting an object that is already
   * gone succeeds. A restore reading it at the same time fails, and nothing is swapped.
   */
  async delete(backup: DirectoryBackup, options: DirectoryBackupDeleteOptions = {}): Promise<void> {
    validateOptions(options, DELETE_OPTIONS);
    const record = parseRecord(backup);
    options.signal?.throwIfAborted();
    await this.#control(this.#key(record.id)).deleteObject();
  }

  /**
   * Runs the shim's backup into a new multipart upload, which its grant creates once the shim
   * holds the lock. Aborts the upload if the backup fails.
   */
  async #upload(
    control: DirectoryBackupGatewayControl,
    key: string,
    options: DirectoryBackupOptions,
  ): Promise<{ uploadId: string; done: z.infer<typeof backupDoneSchema> }> {
    const { dir } = options;
    let uploadId: string | undefined;
    try {
      const done = await runShimExchange(this.#container, {
        command: "backup",
        request: {
          gateway: GATEWAY_HOST,
          dir,
          exclude: [...(options.exclude ?? [])],
          gitignore: options.gitignore ?? false,
        },
        path: dir,
        signal: options.signal,
        done: backupDoneSchema,
        grant: async () => {
          uploadId = await control.createUpload(options.name);
          await this.#register({
            protocolVersion: 1,
            mode: "write",
            binding: this.#binding,
            key,
            uploadId,
          });
        },
        deny: () => this.#deny(),
      });
      // The shim reports done only after the grant, which created the upload.
      if (uploadId === undefined) throw new Error("the backup finished without an upload");
      return { uploadId, done };
    } catch (error) {
      if (uploadId !== undefined) await control.abortUpload(uploadId).catch(() => undefined);
      throw error;
    }
  }

  #key(id: string): string {
    return `${this.#prefix}${id}.tar.zst`;
  }

  #control(key: string): DirectoryBackupGatewayControl {
    return this.#gateway({
      props: { protocolVersion: 1, mode: "control", binding: this.#binding, key },
    });
  }

  #register(props: DirectoryBackupGatewayProps): Promise<void> {
    return this.#container.interceptOutboundHttp(GATEWAY_HOST, this.#gateway({ props }));
  }

  #deny(): Promise<void> {
    return this.#register({ protocolVersion: 1, mode: "deny" });
  }
}

function parseRecord(backup: DirectoryBackup): DirectoryBackup {
  const parsed = recordSchema.safeParse(backup);
  if (!parsed.success) {
    throw new TypeError(
      `backup must be a directory backup record in format "${DIRECTORY_BACKUP_FORMAT}"`,
    );
  }
  return parsed.data;
}
