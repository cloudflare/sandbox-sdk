import { describe, expect, it, vi } from "vite-plus/test";

import {
  type DirectoryBackup,
  type DirectoryBackupGatewayBinding,
  DirectoryBackups,
  SandboxBackupError,
  SandboxFileError,
  SandboxProtocolError,
} from "../src/index.js";
import type { DirectoryBackupGatewayProps } from "../src/directory-backups/contracts.js";
import { dataFrame, deferred, encoder, errorFrame } from "./helpers.js";
import { TestFetcher } from "./worker-test-doubles.js";

const SHA256 = "a".repeat(64);
const HOST = "backups.sandbox.internal";
const LOCKED = message(JSON.stringify({ kind: "locked" }));

function message(json: string): Uint8Array[] {
  return dataFrame(encoder.encode(json));
}

/**
 * A `directory-backup` shim: sends `first`, sends `afterAcknowledgement` once the package writes
 * to stdin, and exits when stdin closes, as the real shim holds its lock until then.
 */
class ShimDouble {
  readonly process: ExecProcess;
  readonly kill = vi.fn();
  #stdout: ReadableStreamDefaultController<Uint8Array> | undefined;

  constructor(log: string[], afterAcknowledgement: Uint8Array[], first: Uint8Array[] = LOCKED) {
    const exit = deferred<number>();
    const stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#stdout = controller;
        for (const frame of first) controller.enqueue(frame);
      },
    });
    const stdin = new WritableStream<Uint8Array>({
      write: (chunk) => {
        log.push(`stdin ${chunk.join(",")}`);
        for (const frame of afterAcknowledgement) this.#stdout?.enqueue(frame);
      },
      close: () => {
        log.push("stdin closed");
        try {
          this.#stdout?.close();
        } catch {
          // The package already cancelled stdout.
        }
        exit.resolve(0);
      },
    });
    this.process = {
      stdin,
      stdout,
      stderr: null,
      pid: 1,
      isPty: false,
      exitCode: exit.promise,
      output: vi.fn(),
      kill: this.kill,
      resize: vi.fn(),
    };
  }
}

function setup(
  options: {
    afterAcknowledgement?: Uint8Array[];
    first?: Uint8Array[];
    /** The size R2 reports for the completed upload, or why completing it fails. */
    stored?: number | Error;
  } = {},
) {
  const log: string[] = [];
  const shim = new ShimDouble(log, options.afterAcknowledgement ?? [], options.first);
  const propsByFetcher = new WeakMap<Fetcher, DirectoryBackupGatewayProps>();
  const controlKeys: string[] = [];
  const gateway: DirectoryBackupGatewayBinding = ({ props }) => {
    if (props.mode === "control") controlKeys.push(props.key);
    const fetcher = Object.assign(new TestFetcher(), {
      async createUpload(name?: string) {
        log.push(`create ${name ?? "-"}`);
        return "upload-1";
      },
      async completeUpload(uploadId: string, parts: readonly { partNumber: number }[]) {
        log.push(`complete ${uploadId} ${parts.map((part) => part.partNumber).join(",")}`);
        if (options.stored instanceof Error) throw options.stored;
        return options.stored ?? 10;
      },
      async abortUpload(uploadId: string) {
        log.push(`abort ${uploadId}`);
      },
      async deleteObject() {
        log.push("delete");
      },
    });
    propsByFetcher.set(fetcher, props);
    return fetcher;
  };
  const container = {
    exec: vi.fn(async (_command: string[], _options?: ContainerExecOptions) => shim.process),
    interceptOutboundHttp: vi.fn(async (host: string, fetcher: Fetcher) => {
      const props = propsByFetcher.get(fetcher);
      const key = props !== undefined && "key" in props ? ` ${props.key}` : "";
      log.push(`register ${host} ${props?.mode ?? "?"}${key}`);
    }),
  };
  const backups = new DirectoryBackups(container, gateway, {
    binding: "BACKUPS",
    prefix: "backups/",
  });
  return { log, shim, container, backups, controlKeys };
}

const record: DirectoryBackup = {
  id: "0b8f6a2e-5c1d-4e7a-9f3b-2d4c6e8a0b1c",
  dir: "/workspace",
  size: 10,
  sha256: SHA256,
  format: "tar+zstd/1",
};
const KEY = `backups/${record.id}.tar.zst`;

function done(parts = [{ partNumber: 1, etag: "etag-1" }], size = 10): Uint8Array[] {
  return message(JSON.stringify({ kind: "done", size, sha256: SHA256, parts }));
}

function shimError(code: string, detail: string): Uint8Array[] {
  return message(JSON.stringify({ kind: "error", code, detail }));
}

describe("DirectoryBackups.backup", () => {
  it("grants after the lock, denies before closing stdin, then completes the upload", async () => {
    const { log, container, backups, controlKeys } = setup({ afterAcknowledgement: done() });

    const backup = await backups.backup({
      dir: "/workspace",
      name: "nightly",
      exclude: ["node_modules/"],
      gitignore: true,
    });

    const key = `backups/${backup.id}.tar.zst`;
    expect(backup).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      dir: "/workspace",
      size: 10,
      name: "nightly",
      sha256: SHA256,
      format: "tar+zstd/1",
    });
    expect(container.exec).toHaveBeenCalledWith(
      [
        "/usr/local/bin/sandbox-shim",
        "directory-backup",
        "backup",
        JSON.stringify({
          gateway: HOST,
          dir: "/workspace",
          exclude: ["node_modules/"],
          gitignore: true,
        }),
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
    );
    expect(log).toEqual([
      "create nightly",
      `register ${HOST} write ${key}`,
      "stdin 1",
      `register ${HOST} deny`,
      "stdin closed",
      "complete upload-1 1",
    ]);
    expect(controlKeys).toEqual([key]);
  });

  it("deletes the object when R2 stored a different size", async () => {
    const { log, backups } = setup({ afterAcknowledgement: done(), stored: 11 });

    const error = await backups.backup({ dir: "/workspace" }).catch((cause: Error) => cause);

    expect(SandboxBackupError.is(error) && error.code).toBe("BACKUP_INTEGRITY");
    expect(log.slice(-2)).toEqual(["complete upload-1 1", "delete"]);
  });

  it("aborts the upload when completing it fails", async () => {
    const { log, backups } = setup({ afterAcknowledgement: done(), stored: new Error("R2 down") });

    await expect(backups.backup({ dir: "/workspace" })).rejects.toThrow("R2 down");

    expect(log.slice(-2)).toEqual(["complete upload-1 1", "abort upload-1"]);
  });

  it("aborts the upload when a part fails, after denying and closing stdin", async () => {
    const { log, backups } = setup({
      afterAcknowledgement: shimError("transfer", "gateway rejected the part upload with HTTP 502"),
    });

    const error = await backups.backup({ dir: "/workspace" }).catch((cause: Error) => cause);

    expect(SandboxBackupError.is(error)).toBe(true);
    expect(error).toMatchObject({
      code: "BACKUP_TRANSFER",
      operation: "backup",
      path: "/workspace",
      detail: "gateway rejected the part upload with HTTP 502",
    });
    expect(log.slice(2)).toEqual([
      "stdin 1",
      `register ${HOST} deny`,
      "stdin closed",
      "abort upload-1",
    ]);
  });

  it("reports a missing directory as a file error without granting anything", async () => {
    const { log, backups, shim } = setup({ first: errorFrame(2, "/missing: No such file") });

    const error = await backups.backup({ dir: "/missing" }).catch((cause: Error) => cause);

    expect(SandboxFileError.is(error)).toBe(true);
    expect(error).toMatchObject({ code: "ENOENT", operation: "backup", path: "/missing" });
    await vi.waitFor(() => expect(log).toEqual(["stdin closed"]));
    expect(shim.kill).not.toHaveBeenCalled();
  });

  it("closes stdin instead of killing the shim when aborted while waiting for the lock", async () => {
    const { log, backups, shim, container } = setup({ first: [] });
    const controller = new AbortController();

    const pending = backups.backup({ dir: "/workspace", signal: controller.signal });
    await vi.waitFor(() => expect(container.exec).toHaveBeenCalled());
    controller.abort(new Error("stop"));

    await expect(pending).rejects.toThrow("stop");
    await vi.waitFor(() => expect(log).toEqual(["stdin closed"]));
    expect(shim.kill).not.toHaveBeenCalled();
    expect(container.interceptOutboundHttp).not.toHaveBeenCalled();
  });

  it("closes the stdin of a shim that starts after the abort", async () => {
    const { log, backups, shim, container } = setup({ first: [] });
    const started = deferred<ExecProcess>();
    container.exec.mockImplementationOnce(() => started.promise);
    const controller = new AbortController();

    const pending = backups.backup({ dir: "/workspace", signal: controller.signal });
    await vi.waitFor(() => expect(container.exec).toHaveBeenCalled());
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
    started.resolve(shim.process);

    await vi.waitFor(() => expect(log).toEqual(["stdin closed"]));
    expect(container.exec.mock.calls[0]?.[1]?.signal).toBeUndefined();
    expect(shim.kill).not.toHaveBeenCalled();
  });

  it("reports a shim that ends without taking the lock as a protocol error", async () => {
    const { backups, shim } = setup({ first: [] });
    void shim.process.stdout?.cancel();

    await expect(backups.backup({ dir: "/workspace" })).rejects.toSatisfy((error) =>
      SandboxProtocolError.is(error),
    );
  });

  it("validates options before starting the shim", async () => {
    const { backups, container } = setup();

    await expect(backups.backup({ dir: "workspace" })).rejects.toThrow(TypeError);
    await expect(
      backups.backup(JSON.parse('{"dir":"/workspace","exclude":"node_modules"}')),
    ).rejects.toThrow("exclude must be an array of strings");
    expect(container.exec).not.toHaveBeenCalled();
  });
});

describe("DirectoryBackups.restore", () => {
  it("grants a read of the record's object and restores into another directory", async () => {
    const { log, container, backups } = setup({
      afterAcknowledgement: message(JSON.stringify({ kind: "done" })),
    });

    await backups.restore(record, { dir: "/elsewhere" });

    expect(container.exec.mock.calls[0]?.[0]).toEqual([
      "/usr/local/bin/sandbox-shim",
      "directory-backup",
      "restore",
      JSON.stringify({ gateway: HOST, dir: "/elsewhere", size: 10, sha256: SHA256 }),
    ]);
    expect(log).toEqual([
      `register ${HOST} read ${KEY}`,
      "stdin 1",
      `register ${HOST} deny`,
      "stdin closed",
    ]);
  });

  it("maps the shim's integrity and not-found results", async () => {
    for (const [code, expected] of [
      ["integrity", "BACKUP_INTEGRITY"],
      ["notFound", "BACKUP_NOT_FOUND"],
    ] as const) {
      const { backups } = setup({ afterAcknowledgement: shimError(code, "detail") });

      const error = await backups.restore(record).catch((cause: Error) => cause);

      expect(error).toMatchObject({ code: expected, operation: "restore", path: "/workspace" });
    }
  });

  it("rejects a value that is not a backup record", async () => {
    const { backups, container } = setup();

    await expect(
      backups.restore(JSON.parse(JSON.stringify({ ...record, format: "squashfs" }))),
    ).rejects.toThrow(TypeError);
    await expect(backups.restore({ ...record, sha256: "short" })).rejects.toThrow(TypeError);
    expect(container.exec).not.toHaveBeenCalled();
  });
});

describe("DirectoryBackups.delete", () => {
  it("deletes the object with a control call and no container", async () => {
    const { log, container, backups, controlKeys } = setup();

    await backups.delete(record);

    expect(log).toEqual(["delete"]);
    expect(controlKeys).toEqual([KEY]);
    expect(container.exec).not.toHaveBeenCalled();
  });
});

describe("DirectoryBackups storage", () => {
  it("requires a binding name and a slash-terminated prefix", () => {
    const { container } = setup();
    const gateway: DirectoryBackupGatewayBinding = vi.fn();

    expect(() => new DirectoryBackups(container, gateway, { binding: "" })).toThrow(TypeError);
    expect(
      () => new DirectoryBackups(container, gateway, { binding: "BACKUPS", prefix: "backups" }),
    ).toThrow('storage.prefix must be a string that ends in "/"');
  });
});
