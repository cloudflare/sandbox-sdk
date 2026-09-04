import { describe, expect, it, vi } from "vite-plus/test";

import { ContainerFiles } from "../src/container-files.js";
import { SandboxFileError, SandboxProtocolError } from "../src/errors.js";
import {
  containerWith,
  dataFrame,
  deferred,
  errorFrame,
  readableChunks,
  readProcess,
  SUCCESS_HEADER,
  successFrame,
} from "./helpers.js";

describe("ContainerFiles.readFile", () => {
  it("returns raw bytes and forwards native options", async () => {
    const signal = new AbortController().signal;
    const data = new Uint8Array([1, 2, 3]);
    const process = readProcess(successFrame(), 0, readableChunks([data]));
    const container = containerWith(process);

    const response = await new ContainerFiles(container).readFile("data.bin", {
      cwd: "/workspace",
      user: "1000:1000",
      signal,
    });

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(data);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(container.exec).toHaveBeenCalledWith(
      ["/usr/local/bin/sandbox-shim", "read", "data.bin"],
      {
        cwd: "/workspace",
        user: "1000:1000",
        signal,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  });

  it("maps opening filesystem errors with numeric errno", async () => {
    const promise = new ContainerFiles(
      containerWith(readProcess(errorFrame(2, "No such file or directory"))),
    ).readFile("/missing");

    await expect(promise).rejects.toBeInstanceOf(SandboxFileError);
    await expect(promise).rejects.toMatchObject({
      code: "ENOENT",
      errno: 2,
      operation: "readFile",
      path: "/missing",
      detail: "No such file or directory",
    });
  });

  it("preserves unknown numeric errno values", async () => {
    await expect(
      new ContainerFiles(containerWith(readProcess(errorFrame(1234, "Unknown error")))).readFile(
        "/file",
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN", errno: 1234 });
  });

  it("preserves filesystem errors reported after raw bytes", async () => {
    const process = readProcess(
      [SUCCESS_HEADER, ...errorFrame(5, "Input/output error")],
      0,
      readableChunks([new Uint8Array([1, 2, 3])]),
    );
    const response = await new ContainerFiles(containerWith(process)).readFile("/device");

    await expect(response.arrayBuffer()).rejects.toMatchObject({
      code: "EIO",
      errno: 5,
      detail: "Input/output error",
    });
  });

  it("returns an empty response for an empty file", async () => {
    const response = await new ContainerFiles(containerWith(readProcess(successFrame()))).readFile(
      "/empty",
    );

    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("propagates native exec errors unchanged", async () => {
    const nativeError = new Error("container is not running");
    const container = { exec: vi.fn().mockRejectedValue(nativeError) };

    await expect(new ContainerFiles(container).readFile("/file")).rejects.toBe(nativeError);
  });

  it("validates paths before launching exec", async () => {
    const container = containerWith(readProcess([]));
    const files = new ContainerFiles(container);

    await expect(files.readFile("relative.txt")).rejects.toThrow(
      "cwd is required when path is relative",
    );
    await expect(files.readFile("relative.txt", { cwd: "workspace" })).rejects.toThrow(
      "cwd must be an absolute path",
    );
    await expect(files.readFile("")).rejects.toThrow("path must not be empty");
    await expect(files.readFile("/bad\0path")).rejects.toThrow(
      "path cannot contain NUL characters",
    );
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("rejects malformed control output", async () => {
    const malformed = new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);

    await expect(
      new ContainerFiles(containerWith(readProcess([malformed]))).readFile("/file"),
    ).rejects.toBeInstanceOf(SandboxProtocolError);
  });

  it("rejects metadata frames in the file byte protocol", async () => {
    const openingData = readProcess(dataFrame(new Uint8Array([1])));
    const terminalData = readProcess(
      [SUCCESS_HEADER, ...dataFrame(new Uint8Array([1]))],
      0,
      readableChunks([]),
    );

    await expect(
      new ContainerFiles(containerWith(openingData)).readFile("/file"),
    ).rejects.toBeInstanceOf(SandboxProtocolError);
    const response = await new ContainerFiles(containerWith(terminalData)).readFile("/file");
    await expect(response.arrayBuffer()).rejects.toBeInstanceOf(SandboxProtocolError);
  });

  it("kills the process when the response body is cancelled", async () => {
    const cancelled = vi.fn();
    const stdout = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const process = readProcess(
      [SUCCESS_HEADER],
      0,
      stdout,
      readableChunks([SUCCESS_HEADER], false),
    );
    const response = await new ContainerFiles(containerWith(process)).readFile("/file");

    await response.body?.cancel("not needed");

    expect(cancelled).toHaveBeenCalledWith("not needed");
    expect(process.kill).toHaveBeenCalledWith(9);
  });

  it("preserves stdout transport failures", async () => {
    const transportError = new Error("stdout transport failed");
    const stdout = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(transportError);
      },
    });
    const process = readProcess(
      [SUCCESS_HEADER],
      0,
      stdout,
      readableChunks([SUCCESS_HEADER], false),
    );
    const response = await new ContainerFiles(containerWith(process)).readFile("/file");

    await expect(response.arrayBuffer()).rejects.toBe(transportError);
    expect(process.kill).toHaveBeenCalledWith(9);
  });

  it("preserves abort reasons while the body is blocked", async () => {
    const abort = new AbortController();
    const reason = new Error("caller stopped reading");
    const pullStarted = deferred<void>();
    const stdout = new ReadableStream<Uint8Array>({
      pull() {
        pullStarted.resolve();
        return new Promise<void>(() => undefined);
      },
    });
    const process = readProcess(
      [SUCCESS_HEADER],
      new Promise<number>(() => undefined),
      stdout,
      readableChunks([SUCCESS_HEADER], false),
    );
    const response = await new ContainerFiles(containerWith(process)).readFile("/file", {
      signal: abort.signal,
    });
    const body = response.arrayBuffer();

    await pullStarted.promise;
    abort.abort(reason);

    await expect(body).rejects.toBe(reason);
    expect(process.kill).toHaveBeenCalledWith(9);
  });

  it("rejects missing native process streams", async () => {
    const missingStdout = readProcess(successFrame(), 0, null);
    const missingStderr = readProcess([], 0, readableChunks([]), null);

    await expect(
      new ContainerFiles(containerWith(missingStdout)).readFile("/file"),
    ).rejects.toBeInstanceOf(SandboxProtocolError);
    await expect(
      new ContainerFiles(containerWith(missingStderr)).readFile("/file"),
    ).rejects.toBeInstanceOf(SandboxProtocolError);
  });
});
