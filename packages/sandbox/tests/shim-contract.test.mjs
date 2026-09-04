import { spawn } from "node:child_process";
import { mkdir as nativeMkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { describe, expect, it } from "vite-plus/test";

import { ContainerFiles } from "../src/container-files.js";

const SHIM_PATH = process.env.SANDBOX_SHIM_PATH;

function nativeContainer() {
  return {
    exec(command, options) {
      const child = spawn(SHIM_PATH, command.slice(1), {
        cwd: options.cwd,
        stdio: [
          options.stdin === "pipe" ? "pipe" : "ignore",
          options.stdout === "pipe" ? "pipe" : "ignore",
          options.stderr === "pipe" ? "pipe" : "ignore",
        ],
      });
      const exitCode = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve(code ?? 128 + signalNumber(signal)));
      });
      return Promise.resolve({
        stdin: child.stdin === null ? null : Writable.toWeb(child.stdin),
        stdout: child.stdout === null ? null : Readable.toWeb(child.stdout),
        stderr: child.stderr === null ? null : Readable.toWeb(child.stderr),
        pid: child.pid,
        isPty: false,
        exitCode,
        output() {
          throw new Error("output is not used by file operations");
        },
        kill(signal) {
          child.kill(signal);
        },
        resize() {},
      });
    },
  };
}

function signalNumber(signal) {
  return signal === "SIGKILL" ? 9 : 1;
}

describe.skipIf(SHIM_PATH === undefined)("compiled sandbox-shim contract", () => {
  it("streams binary file contents through the SDK", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-shim-contract-"));
    try {
      const path = join(directory, "content.bin");
      const content = new Uint8Array([0, 1, 2, 255]);
      await writeFile(path, content);

      const response = await new ContainerFiles(nativeContainer()).readFile(path);

      expect(new Uint8Array(await response.arrayBuffer())).toEqual(content);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("streams SDK writes into the destination file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-shim-contract-"));
    try {
      const path = join(directory, "content.bin");
      const content = new Uint8Array([255, 2, 1, 0]);

      await new ContainerFiles(nativeContainer()).writeFile(path, content);

      expect(new Uint8Array(await readFile(path))).toEqual(content);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns complete metadata and native directory entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-shim-contract-"));
    try {
      await writeFile(join(directory, "bravo.txt"), "bravo");
      await writeFile(join(directory, "alpha.txt"), "alpha");
      await nativeMkdir(join(directory, "charlie"));
      await symlink("alpha.txt", join(directory, "current"));
      const files = new ContainerFiles(nativeContainer());

      const stat = await files.stat(join(directory, "alpha.txt"));
      expect(stat).toMatchObject({ type: "file", size: 5n });
      expect(stat.mode & 0o170000).toBe(0o100000);
      expect(stat.uid).toBeTypeOf("number");
      expect(stat.gid).toBeTypeOf("number");
      expect(stat.accessedAt).toBeInstanceOf(Date);
      expect(stat.modifiedAt).toBeInstanceOf(Date);
      expect(stat.changedAt).toBeInstanceOf(Date);
      await expect(files.lstat(join(directory, "current"))).resolves.toMatchObject({
        type: "symlink",
      });
      await expect(files.stat("/dev/null")).resolves.toMatchObject({ type: "characterDevice" });

      const entries = await files.readDirectory(directory);
      expect(entries).toHaveLength(4);
      expect(entries).toEqual(
        expect.arrayContaining([
          { name: "alpha.txt", type: "file" },
          { name: "bravo.txt", type: "file" },
          { name: "charlie", type: "directory" },
          { name: "current", type: "symlink" },
        ]),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates single and recursive directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-shim-contract-"));
    try {
      const files = new ContainerFiles(nativeContainer());
      const single = join(directory, "single");
      const nested = join(directory, "parent", "child");

      await files.mkdir(single);
      await files.mkdir(nested, { recursive: true });

      await expect(files.stat(single)).resolves.toMatchObject({ type: "directory" });
      await expect(files.stat(nested)).resolves.toMatchObject({ type: "directory" });
      await expect(files.mkdir(single)).rejects.toMatchObject({ code: "EEXIST" });
      await expect(files.mkdir(single, { recursive: true })).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("renames files and symlinks with native replacement semantics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-shim-contract-"));
    try {
      const files = new ContainerFiles(nativeContainer());
      const source = join(directory, "source.txt");
      const destination = join(directory, "destination.txt");
      const link = join(directory, "source-link");
      const renamedLink = join(directory, "renamed-link");
      await writeFile(source, "source");
      await writeFile(destination, "destination");
      await symlink("destination.txt", link);

      await files.rename(source, destination);
      await files.rename(link, renamedLink);

      await expect(files.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(destination, "utf8")).toBe("source");
      await expect(files.lstat(renamedLink)).resolves.toMatchObject({ type: "symlink" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes files, symlinks, and directory trees", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-shim-contract-"));
    try {
      const files = new ContainerFiles(nativeContainer());
      const file = join(directory, "file.txt");
      const tree = join(directory, "tree");
      const external = join(directory, "external");
      const link = join(directory, "external-link");
      await writeFile(file, "content");
      await nativeMkdir(tree);
      await nativeMkdir(external);
      await writeFile(join(tree, "nested.txt"), "nested");
      await writeFile(join(external, "keep.txt"), "keep");
      await symlink(external, link);
      await symlink(external, join(tree, "nested-link"));

      await files.remove(file);
      await files.remove(link);
      await files.remove(tree, { recursive: true });
      await files.remove(join(directory, "missing"), { force: true });

      await expect(files.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(files.lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(files.stat(tree)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(files.readFile(join(external, "keep.txt"))).resolves.toBeInstanceOf(Response);
      await expect(files.remove(external, { force: true })).rejects.toMatchObject({
        operation: "remove",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves native open and read errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-shim-contract-"));
    try {
      const files = new ContainerFiles(nativeContainer());

      await expect(files.readFile(join(directory, "missing"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const response = await files.readFile(directory);
      await expect(response.arrayBuffer()).rejects.toMatchObject({ code: "EISDIR" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
