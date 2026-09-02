import { describe, expect, it, vi } from "vite-plus/test";

import { ContainerFiles } from "../src/container-files.js";

const encoder = new TextEncoder();

function processFromChunks(
  chunks: Uint8Array[],
  exitCode = 0,
  stdout: ReadableStream<Uint8Array> | null = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }),
) {
  return {
    stdin: null,
    stdout,
    stderr: null,
    pid: 1,
    isPty: false,
    exitCode: Promise.resolve(exitCode),
    output: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
  };
}

function containerWith(process: ExecProcess) {
  return { exec: vi.fn().mockResolvedValue(process) };
}

describe("ContainerFiles.readFile", () => {
  it("returns a streaming octet response and forwards native options", async () => {
    const signal = new AbortController().signal;
    const process = processFromChunks([
      new Uint8Array([0x53, 0x42]),
      new Uint8Array([0x58, 0x46, 1, 0, 1, 2]),
      new Uint8Array([3]),
    ]);
    const container = containerWith(process);

    const response = await new ContainerFiles(container).readFile("data.bin", {
      cwd: "/workspace",
      user: "1000:1000",
      signal,
    });

    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(container.exec).toHaveBeenCalledWith(
      ["/usr/local/bin/sandbox-shim", "read", "data.bin"],
      {
        cwd: "/workspace",
        user: "1000:1000",
        signal,
        stdout: "pipe",
        stderr: "ignore",
      },
    );
  });

  it("maps framed filesystem errors to ordinary errors with properties", async () => {
    const errno = new Uint8Array(4);
    new DataView(errno.buffer).setInt32(0, 2, true);
    const container = containerWith(
      processFromChunks([
        new Uint8Array([0x53, 0x42, 0x58, 0x46, 1, 1]),
        errno,
        encoder.encode("No such file or directory"),
      ]),
    );

    const promise = new ContainerFiles(container).readFile("/missing");

    await expect(promise).rejects.toMatchObject({
      name: "Error",
      code: "FILE_NOT_FOUND",
      errno: "ENOENT",
      path: "/missing",
      message: "Cannot read '/missing': No such file or directory",
    });
  });

  it("maps permission failures", async () => {
    const errno = new Uint8Array(4);
    new DataView(errno.buffer).setInt32(0, 13, true);
    const container = containerWith(
      processFromChunks([
        new Uint8Array([0x53, 0x42, 0x58, 0x46, 1, 1]),
        errno,
        encoder.encode("Permission denied"),
      ]),
    );

    await expect(new ContainerFiles(container).readFile("/private")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      errno: "EACCES",
      path: "/private",
    });
  });

  it("preserves a framed filesystem error regardless of process exit code", async () => {
    const errno = new Uint8Array(4);
    new DataView(errno.buffer).setInt32(0, 2, true);
    const container = containerWith(
      processFromChunks(
        [
          new Uint8Array([0x53, 0x42, 0x58, 0x46, 1, 1]),
          errno,
          encoder.encode("No such file or directory"),
        ],
        1,
      ),
    );

    await expect(new ContainerFiles(container).readFile("/missing")).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
      errno: "ENOENT",
    });
  });

  it("propagates native exec errors unchanged", async () => {
    const nativeError = new Error("container is not running");
    const container = { exec: vi.fn().mockRejectedValue(nativeError) };

    const promise = new ContainerFiles(container).readFile("/file");

    await expect(promise).rejects.toBe(nativeError);
  });

  it("requires cwd for relative paths before launching exec", async () => {
    const container = containerWith(processFromChunks([]));

    await expect(new ContainerFiles(container).readFile("relative.txt")).rejects.toThrow(TypeError);
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("rejects incompatible shim protocols", async () => {
    const container = containerWith(
      processFromChunks([new Uint8Array([0x53, 0x42, 0x58, 0x46, 2, 0])]),
    );

    await expect(new ContainerFiles(container).readFile("/file")).rejects.toMatchObject({
      code: "SANDBOX_PROTOCOL_ERROR",
    });
  });

  it("errors the response stream when the shim exits unsuccessfully", async () => {
    const container = containerWith(
      processFromChunks([new Uint8Array([0x53, 0x42, 0x58, 0x46, 1, 0, 1])], 9),
    );
    const response = await new ContainerFiles(container).readFile("/file");

    await expect(response.arrayBuffer()).rejects.toMatchObject({
      code: "SANDBOX_PROTOCOL_ERROR",
      message: "sandbox-shim exited with code 9",
    });
  });

  it("returns an empty response for an empty file", async () => {
    const container = containerWith(
      processFromChunks([new Uint8Array([0x53, 0x42, 0x58, 0x46, 1, 0])]),
    );

    const response = await new ContainerFiles(container).readFile("/empty");

    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("kills the process when the response body is cancelled", async () => {
    const streamCancelled = vi.fn();
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x53, 0x42, 0x58, 0x46, 1, 0]));
      },
      cancel: streamCancelled,
    });
    const process = processFromChunks([], 0, stdout);
    const container = containerWith(process);
    const response = await new ContainerFiles(container).readFile("/file");

    await response.body?.cancel("not needed");

    expect(streamCancelled).toHaveBeenCalledWith("not needed");
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it("kills the process after a truncated frame", async () => {
    const process = processFromChunks([new Uint8Array([0x53, 0x42])]);
    const container = containerWith(process);

    await expect(new ContainerFiles(container).readFile("/file")).rejects.toMatchObject({
      code: "SANDBOX_PROTOCOL_ERROR",
    });
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it("rejects a process without piped stdout", async () => {
    const process = processFromChunks([], 0, null);
    const container = containerWith(process);

    await expect(new ContainerFiles(container).readFile("/file")).rejects.toMatchObject({
      code: "SANDBOX_PROTOCOL_ERROR",
    });
    expect(process.kill).toHaveBeenCalledOnce();
  });
});
