import * as z from "zod/mini";

import {
  backupError,
  type DirectoryBackupOperation,
  fileErrorFromErrno,
  protocolError,
} from "../shared/errors.js";
import {
  type ContainerExecutor,
  type JsonValue,
  parseJsonPayload,
  SHIM_PATH,
  type ShimControl,
  ShimSession,
} from "../shared/shim.js";

/** The one intercepted host every operation's grant is registered on. */
export const GATEWAY_HOST = "backups.sandbox.internal";

const ACKNOWLEDGEMENT = new Uint8Array([1]);
const messageSchema = z.object({ kind: z.string() });
const errorSchema = z.object({ kind: z.literal("error"), code: z.string(), detail: z.string() });
const lockedSchema = z.strictObject({ kind: z.literal("locked") });

export interface ShimExchange<Done> {
  readonly command: "backup" | "restore";
  readonly request: JsonValue;
  /** The directory, for errors. */
  readonly path: string;
  readonly signal: AbortSignal | undefined;
  readonly done: z.ZodMiniType<Done>;
  /** Registers this operation's grant. Called once the shim holds the lock. */
  grant(): Promise<void>;
  /** Replaces the grant with one that denies everything. */
  deny(): Promise<void>;
}

/**
 * Runs one `directory-backup` shim exchange: wait for the lock, register the grant, acknowledge,
 * wait for the result, then deny and close stdin, in that order on every path. The shim holds
 * the lock until stdin closes, so a later operation's grant can't be overwritten by this
 * operation's deny.
 *
 * An abort closes stdin rather than killing the shim, which then removes whatever it had
 * partly written, and rejects at once with the signal's reason.
 */
export async function runShimExchange<Done>(
  container: ContainerExecutor,
  exchange: ShimExchange<Done>,
): Promise<Done> {
  const { signal } = exchange;
  signal?.throwIfAborted();
  const operation: DirectoryBackupOperation = exchange.command;
  const session = await ShimSession.start(
    container,
    [SHIM_PATH, "directory-backup", exchange.command, JSON.stringify(exchange.request)],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore", signal },
    "stdin",
  );

  let control: ShimControl | undefined;
  let input: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let granting: Promise<void> | undefined;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    if (granting !== undefined) {
      await granting.catch(() => undefined);
      await exchange.deny().catch(() => undefined);
    }
    if (input !== undefined) closeStdin(input);
  };

  try {
    control = session.openStdoutControl();
    input = session.openStdinWriter();
    const locked = await readMessage(control, operation, exchange.path);
    if (!lockedSchema.safeParse(locked).success) {
      throw protocolError("sandbox-shim did not report that it holds the backup lock");
    }
    granting = exchange.grant();
    await session.waitFor(granting);
    await session.waitFor(input.write(ACKNOWLEDGEMENT));
    const result = await readMessage(control, operation, exchange.path);
    const done = exchange.done.safeParse(result);
    if (!done.success) throw protocolError("sandbox-shim returned an invalid backup result");

    await release();
    await control.expectEnd();
    const exitCode = await session.waitFor(session.process.exitCode);
    if (exitCode !== 0) throw protocolError(`sandbox-shim exited with code ${exitCode}`);
    control.releaseLock();
    return done.data;
  } catch (error) {
    await release();
    control?.discard(error);
    throw error;
  } finally {
    session.finish();
  }
}

async function readMessage(
  control: ShimControl,
  operation: DirectoryBackupOperation,
  path: string,
): Promise<JsonValue> {
  const frame = await control.readFrame();
  if (frame.kind === "fileError") {
    throw fileErrorFromErrno(
      { operation: operation === "backup" ? "backup" : "restore", path },
      frame.errno,
      frame.detail,
    );
  }
  if (frame.kind !== "data") throw protocolError("sandbox-shim did not return backup data");
  const value = parseJsonPayload(frame.payload, "sandbox-shim returned invalid backup data");
  if (!messageSchema.safeParse(value).success) {
    throw protocolError("sandbox-shim returned invalid backup data");
  }
  const failure = errorSchema.safeParse(value);
  if (failure.success) throw shimFailure(failure.data.code, failure.data.detail, operation, path);
  return value;
}

function shimFailure(
  code: string,
  detail: string,
  operation: DirectoryBackupOperation,
  path: string,
): Error {
  switch (code) {
    case "integrity":
      return backupError("BACKUP_INTEGRITY", operation, path, detail);
    case "notFound":
      return backupError("BACKUP_NOT_FOUND", operation, path, detail);
    case "transfer":
      return backupError("BACKUP_TRANSFER", operation, path, detail);
    case "protocol":
      return protocolError(detail);
    default:
      return protocolError(`sandbox-shim returned unknown backup error code "${code}"`);
  }
}

function closeStdin(input: WritableStreamDefaultWriter<Uint8Array>): void {
  void input.close().catch(() => undefined);
}
