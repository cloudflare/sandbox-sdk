import { describe, expect, it, vi } from "vite-plus/test";

import { ContainerFiles } from "../src/container-files.js";
import { SandboxFileError, SandboxProtocolError } from "../src/errors.js";
import { commandProcess, containerWith, dataFrame, encoder, errorFrame } from "./helpers.js";

interface EncodedEntry {
  name: string;
  type: number;
}

function directoryPayload(entries: EncodedEntry[]): Uint8Array {
  const names = entries.map((entry) => encoder.encode(entry.name));
  const length = 4 + names.reduce((total, name) => total + 1 + 2 + name.length, 0);
  const payload = new Uint8Array(length);
  const view = new DataView(payload.buffer);
  let offset = 0;
  view.setUint32(offset, entries.length, true);
  offset += 4;
  for (let index = 0; index < entries.length; index += 1) {
    const name = names[index];
    payload[offset] = entries[index].type;
    offset += 1;
    view.setUint16(offset, name.length, true);
    offset += 2;
    payload.set(name, offset);
    offset += name.length;
  }
  return payload;
}

describe("ContainerFiles.readDirectory", () => {
  it("returns typed entries in the shim's native order", async () => {
    const payload = directoryPayload([
      { name: "delta.txt", type: 0 },
      { name: "alpha", type: 1 },
      { name: "current", type: 2 },
    ]);
    const container = containerWith(commandProcess(dataFrame(payload)));
    const signal = new AbortController().signal;

    const entries = await new ContainerFiles(container).readDirectory("workspace", {
      cwd: "/home",
      user: "1000:1000",
      signal,
    });

    expect(entries).toEqual([
      { name: "delta.txt", type: "file" },
      { name: "alpha", type: "directory" },
      { name: "current", type: "symlink" },
    ]);
    expect(container.exec).toHaveBeenCalledWith(
      ["/usr/local/bin/sandbox-shim", "read-directory", "workspace"],
      {
        cwd: "/home",
        user: "1000:1000",
        signal,
        stdout: "pipe",
        stderr: "ignore",
      },
    );
  });

  it("returns an empty array for an empty directory", async () => {
    await expect(
      new ContainerFiles(
        containerWith(commandProcess(dataFrame(directoryPayload([])))),
      ).readDirectory("/dir"),
    ).resolves.toEqual([]);
  });

  it("maps filesystem errors", async () => {
    const promise = new ContainerFiles(
      containerWith(commandProcess(errorFrame(20, "Not a directory"))),
    ).readDirectory("/file");

    await expect(promise).rejects.toBeInstanceOf(SandboxFileError);
    await expect(promise).rejects.toMatchObject({
      code: "ENOTDIR",
      operation: "readDirectory",
      path: "/file",
    });
  });

  it("rejects malformed directory data", async () => {
    const truncated = directoryPayload([{ name: "file", type: 0 }]).subarray(0, 7);
    const trailing = new Uint8Array([...directoryPayload([]), 1]);
    const unknownType = directoryPayload([{ name: "file", type: 9 }]);

    await expect(
      new ContainerFiles(containerWith(commandProcess(dataFrame(truncated)))).readDirectory("/dir"),
    ).rejects.toBeInstanceOf(SandboxProtocolError);
    await expect(
      new ContainerFiles(containerWith(commandProcess(dataFrame(trailing)))).readDirectory("/dir"),
    ).rejects.toThrow("trailing directory data");
    await expect(
      new ContainerFiles(containerWith(commandProcess(dataFrame(unknownType)))).readDirectory(
        "/dir",
      ),
    ).rejects.toThrow("unknown file type");
  });

  it("rejects invalid UTF-8 from the shim", async () => {
    const payload = new Uint8Array([1, 0, 0, 0, 0, 1, 0, 0xff]);

    await expect(
      new ContainerFiles(containerWith(commandProcess(dataFrame(payload)))).readDirectory("/dir"),
    ).rejects.toThrow("invalid UTF-8 in directory entry name");
  });

  it("propagates native exec errors unchanged", async () => {
    const nativeError = new Error("container is not running");
    const container = { exec: vi.fn().mockRejectedValue(nativeError) };

    await expect(new ContainerFiles(container).readDirectory("/dir")).rejects.toBe(nativeError);
  });
});
