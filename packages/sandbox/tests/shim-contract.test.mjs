import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
