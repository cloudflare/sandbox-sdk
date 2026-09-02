import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vite-plus/test";

import { ContainerFiles } from "../src/container-files.js";

const execFileAsync = promisify(execFile);
const SHIM_PATH = join(process.cwd(), "target/debug/sandbox-shim");

function processFromOutput(output) {
  return {
    stdin: null,
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(output));
        controller.close();
      },
    }),
    stderr: null,
    pid: 1,
    isPty: false,
    exitCode: Promise.resolve(0),
    output: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
  };
}

async function shimOutput(path) {
  const { stdout } = await execFileAsync(SHIM_PATH, ["read", path], { encoding: "buffer" });
  return stdout;
}

describe("sandbox-shim contract", () => {
  it("decodes output produced by the compiled shim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-shim-contract-"));
    try {
      const path = join(directory, "content.bin");
      const content = new Uint8Array([0, 1, 2, 255]);
      await writeFile(path, content);
      const process = processFromOutput(await shimOutput(path));
      const response = await new ContainerFiles({
        exec: vi.fn().mockResolvedValue(process),
      }).readFile(path);

      expect(new Uint8Array(await response.arrayBuffer())).toEqual(content);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("decodes filesystem errors produced by the compiled shim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-shim-contract-"));
    try {
      const path = join(directory, "missing");
      const process = processFromOutput(await shimOutput(path));

      await expect(
        new ContainerFiles({ exec: vi.fn().mockResolvedValue(process) }).readFile(path),
      ).rejects.toMatchObject({
        name: "SandboxFileError",
        code: "FILE_NOT_FOUND",
        errnoNumber: 2,
        errno: "ENOENT",
        path,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
