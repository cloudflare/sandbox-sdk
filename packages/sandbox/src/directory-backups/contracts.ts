/** The only archive format this version writes and reads. */
export const DIRECTORY_BACKUP_FORMAT = "tar+zstd/1";

/**
 * A saved directory. A plain, serializable object: store it wherever the application keeps
 * state. It only works with the same R2 binding and key prefix that created it.
 */
export interface DirectoryBackup {
  /** UUID. The object key is `<prefix><id>.tar.zst`. */
  readonly id: string;
  /** The directory the backup came from, and the default restore target. */
  readonly dir: string;
  /** Stored bytes, as R2 reported when the upload completed. */
  readonly size: number;
  readonly name?: string;
  /** SHA-256 of the stored object, checked on every restore. */
  readonly sha256: string;
  readonly format: typeof DIRECTORY_BACKUP_FORMAT;
}

/** Where backups are stored. */
export interface DirectoryBackupStorage {
  /** Name of an R2 bucket binding in the Worker's `env`. The gateway reads it there. */
  readonly binding: string;
  /** Optional key prefix. A non-empty prefix ends in `/`. */
  readonly prefix?: string;
}

export interface DirectoryBackupOptions {
  /** Absolute path of the directory to back up. Pause writers in it first. */
  dir: string;
  /** A label stored in the record and in the object's custom metadata. */
  name?: string;
  /** gitignore-syntax patterns, relative to `dir`. */
  exclude?: readonly string[];
  /** Also apply `.gitignore` files inside `dir` and `.git/info/exclude`. No `git` binary is needed. */
  gitignore?: boolean;
  /** Cancels the operation without imposing a timeout. */
  signal?: AbortSignal;
}

export interface DirectoryRestoreOptions {
  /** Absolute path to restore into instead of the record's `dir`. */
  dir?: string;
  /** Cancels the operation without imposing a timeout. */
  signal?: AbortSignal;
}

export interface DirectoryBackupDeleteOptions {
  signal?: AbortSignal;
}

export interface DirectoryBackupPart {
  readonly partNumber: number;
  readonly etag: string;
}

/** Props for the Durable Object's control calls. The container never receives these. */
interface ControlGatewayProps {
  readonly protocolVersion: 1;
  readonly mode: "control";
  readonly binding: string;
  readonly key: string;
}

/** The one grant the container holds while its operation runs: write parts of one upload. */
interface WriteGatewayProps {
  readonly protocolVersion: 1;
  readonly mode: "write";
  readonly binding: string;
  readonly key: string;
  readonly uploadId: string;
}

/** The one grant the container holds while its operation runs: read ranges of one object. */
interface ReadGatewayProps {
  readonly protocolVersion: 1;
  readonly mode: "read";
  readonly binding: string;
  readonly key: string;
}

/** Props that deny every container request once an operation ends. */
interface DenyGatewayProps {
  readonly protocolVersion: 1;
  readonly mode: "deny";
}

export type DirectoryBackupGatewayProps =
  | ControlGatewayProps
  | WriteGatewayProps
  | ReadGatewayProps
  | DenyGatewayProps;

/** The control methods `DirectoryBackupGateway` exposes to the Durable Object over RPC. */
export interface DirectoryBackupGatewayControl {
  createUpload(name?: string): Promise<string>;
  completeUpload(uploadId: string, parts: readonly DirectoryBackupPart[]): Promise<number>;
  abortUpload(uploadId: string): Promise<void>;
  deleteObject(): Promise<void>;
}

/** The application's `ctx.exports.DirectoryBackupGateway`. */
export interface DirectoryBackupGatewayBinding {
  (options: {
    readonly props: DirectoryBackupGatewayProps;
  }): Fetcher & DirectoryBackupGatewayControl;
}
