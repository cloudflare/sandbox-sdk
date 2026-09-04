import { describe, expect, it, vi } from "vite-plus/test";

import { ContainerFiles } from "../src/container-files.js";
import { SandboxFileError, SandboxProtocolError } from "../src/errors.js";
import {
  commandProcess,
  containerWith,
  dataFrame,
  errorFrame,
  readProcess,
  readableChunks,
  SUCCESS_HEADER,
} from "./helpers.js";

interface EncodedStat {
  type?: number;
  size?: bigint;
  mode?: number;
  uid?: number;
  gid?: number;
  accessedAt?: bigint;
  modifiedAt?: bigint;
  changedAt?: bigint;
}

function statPayload(stat: EncodedStat = {}): Uint8Array {
  const payload = new Uint8Array(45);
  const view = new DataView(payload.buffer);
  payload[0] = stat.type ?? 0;
  view.setBigUint64(1, stat.size ?? 12n, true);
  view.setUint32(9, stat.mode ?? 0o100640, true);
  view.setUint32(13, stat.uid ?? 1000, true);
  view.setUint32(17, stat.gid ?? 1001, true);
  view.setBigInt64(21, stat.accessedAt ?? 1_788_000_000_111n, true);
  view.setBigInt64(29, stat.modifiedAt ?? 1_788_000_000_222n, true);
  view.setBigInt64(37, stat.changedAt ?? 1_788_000_000_333n, true);
  return payload;
}

describe("ContainerFiles stat operations", () => {
  it("returns complete metadata and follows the final symlink with stat", async () => {
    const signal = new AbortController().signal;
    const process = commandProcess(dataFrame(statPayload()));
    const container = containerWith(process);

    const result = await new ContainerFiles(container).stat("data.txt", {
      cwd: "/workspace",
      user: "1000:1000",
      signal,
    });

    expect(result).toEqual({
      type: "file",
      size: 12n,
      mode: 0o100640,
      uid: 1000,
      gid: 1001,
      accessedAt: new Date(1_788_000_000_111),
      modifiedAt: new Date(1_788_000_000_222),
      changedAt: new Date(1_788_000_000_333),
    });
    expect(container.exec).toHaveBeenCalledWith(
      ["/usr/local/bin/sandbox-shim", "stat", "data.txt"],
      {
        cwd: "/workspace",
        user: "1000:1000",
        signal,
        stdout: "pipe",
        stderr: "ignore",
      },
    );
  });

  it("uses a distinct lstat command to describe the final symlink", async () => {
    const container = containerWith(commandProcess(dataFrame(statPayload({ type: 2 }))));

    await expect(new ContainerFiles(container).lstat("/link")).resolves.toMatchObject({
      type: "symlink",
    });
    expect(container.exec).toHaveBeenCalledWith(
      ["/usr/local/bin/sandbox-shim", "lstat", "/link"],
      expect.objectContaining({ stdout: "pipe" }),
    );
  });

  it("decodes every Linux file type", async () => {
    const types = [
      "file",
      "directory",
      "symlink",
      "blockDevice",
      "characterDevice",
      "fifo",
      "socket",
    ];

    for (const [type, expected] of types.entries()) {
      const files = new ContainerFiles(
        containerWith(commandProcess(dataFrame(statPayload({ type })))),
      );
      await expect(files.stat("/entry")).resolves.toMatchObject({ type: expected });
    }
  });

  it("maps stat and lstat filesystem errors", async () => {
    const statPromise = new ContainerFiles(
      containerWith(commandProcess(errorFrame(2, "No such file or directory"))),
    ).stat("/missing");
    await expect(statPromise).rejects.toBeInstanceOf(SandboxFileError);
    await expect(statPromise).rejects.toMatchObject({
      code: "ENOENT",
      operation: "stat",
      path: "/missing",
    });

    const lstat = new ContainerFiles(
      containerWith(commandProcess(errorFrame(2, "No such file or directory"))),
    );
    await expect(lstat.lstat("/missing")).rejects.toMatchObject({
      code: "ENOENT",
      operation: "lstat",
      path: "/missing",
    });
  });

  it("rejects malformed metadata", async () => {
    const wrongLength = commandProcess(dataFrame(new Uint8Array(44)));
    const unknownType = commandProcess(dataFrame(statPayload({ type: 9 })));

    await expect(
      new ContainerFiles(containerWith(wrongLength)).stat("/file"),
    ).rejects.toBeInstanceOf(SandboxProtocolError);
    await expect(new ContainerFiles(containerWith(unknownType)).stat("/file")).rejects.toThrow(
      "unknown file type",
    );
  });

  it("rejects timestamps outside the JavaScript Date range", async () => {
    const payload = statPayload({ accessedAt: BigInt(Number.MAX_SAFE_INTEGER) + 1n });

    await expect(
      new ContainerFiles(containerWith(commandProcess(dataFrame(payload)))).stat("/file"),
    ).rejects.toThrow("out-of-range timestamp");
  });

  it("requires one data frame and a successful shim exit", async () => {
    const successFrame = commandProcess([SUCCESS_HEADER]);
    const failedExit = commandProcess(dataFrame(statPayload()), 9);

    await expect(new ContainerFiles(containerWith(successFrame)).stat("/file")).rejects.toThrow(
      "did not return command data",
    );
    await expect(new ContainerFiles(containerWith(failedExit)).stat("/file")).rejects.toThrow(
      "exited with code 9",
    );
  });

  it("preserves abort reasons while waiting for metadata", async () => {
    const abort = new AbortController();
    const reason = new Error("metadata no longer needed");
    const process = readProcess(
      [],
      new Promise<number>(() => undefined),
      readableChunks([], false),
    );
    const promise = new ContainerFiles(containerWith(process)).stat("/file", {
      signal: abort.signal,
    });

    abort.abort(reason);

    await expect(promise).rejects.toBe(reason);
    expect(process.kill).toHaveBeenCalledWith(9);
  });

  it("terminates a shim that omits stdout", async () => {
    const process = readProcess([], 0, null);

    await expect(new ContainerFiles(containerWith(process)).stat("/file")).rejects.toBeInstanceOf(
      SandboxProtocolError,
    );
    expect(process.kill).toHaveBeenCalledWith(9);
  });

  it("propagates native exec errors unchanged", async () => {
    const nativeError = new Error("container is not running");
    const container = { exec: vi.fn().mockRejectedValue(nativeError) };

    await expect(new ContainerFiles(container).stat("/file")).rejects.toBe(nativeError);
  });
});
