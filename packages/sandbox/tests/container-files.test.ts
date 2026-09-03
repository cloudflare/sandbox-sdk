import { describe, expect, it, vi } from "vite-plus/test";

import { ContainerFiles } from "../src/container-files.js";
import { SandboxFileError, SandboxProtocolError } from "../src/errors.js";

const encoder = new TextEncoder();
const SUCCESS_HEADER = new Uint8Array([0x53, 0x42, 0x58, 0x46, 1, 0]);

function successFrame(...content: Uint8Array[]): Uint8Array[] {
  return [SUCCESS_HEADER, ...content];
}

function errorFrame(errnoNumber: number, message: string): Uint8Array[] {
  return errorFrameBytes(errnoNumber, encoder.encode(message));
}

function errorFrameBytes(errnoNumber: number, detail: Uint8Array): Uint8Array[] {
  const errno = new Uint8Array(4);
  new DataView(errno.buffer).setInt32(0, errnoNumber, true);
  return [new Uint8Array([0x53, 0x42, 0x58, 0x46, 1, 1]), errno, detail];
}

function processFromChunks(
  chunks: Uint8Array[],
  exitCode: number | Promise<number> = 0,
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

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = (value) => resolve(value);
  });
  return { promise, resolve: resolvePromise };
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
    expect(process.kill).not.toHaveBeenCalled();
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
    const container = containerWith(processFromChunks(errorFrame(2, "No such file or directory")));

    const promise = new ContainerFiles(container).readFile("/missing");

    await expect(promise).rejects.toBeInstanceOf(SandboxFileError);
    await expect(promise).rejects.toMatchObject({
      name: "SandboxFileError",
      code: "ENOENT",
      operation: "readFile",
      path: "/missing",
      detail: "No such file or directory",
      message: "readFile '/missing': No such file or directory",
    });
  });

  it("maps permission failures", async () => {
    const container = containerWith(processFromChunks(errorFrame(13, "Permission denied")));

    await expect(new ContainerFiles(container).readFile("/private")).rejects.toMatchObject({
      code: "EACCES",
      operation: "readFile",
      path: "/private",
    });
  });

  it("maps recognized Linux errno values", async () => {
    const cases = [
      { errnoNumber: 1, code: "EPERM" },
      { errnoNumber: 5, code: "EIO" },
      { errnoNumber: 20, code: "ENOTDIR" },
      { errnoNumber: 21, code: "EISDIR" },
      { errnoNumber: 22, code: "EINVAL" },
      { errnoNumber: 40, code: "ELOOP" },
    ] as const;

    for (const expected of cases) {
      const container = containerWith(
        processFromChunks(errorFrame(expected.errnoNumber, expected.code)),
      );

      await expect(new ContainerFiles(container).readFile("/file")).rejects.toMatchObject({
        code: expected.code,
        operation: "readFile",
      });
    }
  });

  it("preserves an unknown numeric errno", async () => {
    const container = containerWith(processFromChunks(errorFrame(1234, "Unknown error")));

    const promise = new ContainerFiles(container).readFile("/file");

    await expect(promise).rejects.toMatchObject({
      code: "UNKNOWN",
      operation: "readFile",
      path: "/file",
      detail: "Unknown error",
    });
  });

  it("rejects non-positive wire errno values as protocol errors", async () => {
    for (const errnoNumber of [0, -1]) {
      const container = containerWith(processFromChunks(errorFrame(errnoNumber, "Invalid errno")));

      await expect(new ContainerFiles(container).readFile("/file")).rejects.toMatchObject({
        code: "SANDBOX_PROTOCOL_ERROR",
        reason: "INVALID_ERRNO",
        errnoNumber,
      });
    }
  });

  it("preserves a framed filesystem error regardless of process exit code", async () => {
    const container = containerWith(
      processFromChunks(errorFrame(2, "No such file or directory"), 1),
    );

    await expect(new ContainerFiles(container).readFile("/missing")).rejects.toMatchObject({
      code: "ENOENT",
      operation: "readFile",
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

  it("requires an absolute cwd before launching exec", async () => {
    const container = containerWith(processFromChunks([]));

    await expect(
      new ContainerFiles(container).readFile("relative.txt", { cwd: "workspace" }),
    ).rejects.toThrow("cwd must be an absolute path");
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("rejects empty and NUL-containing paths before launching exec", async () => {
    const container = containerWith(processFromChunks([]));
    const files = new ContainerFiles(container);

    await expect(files.readFile("")).rejects.toThrow("path must not be empty");
    await expect(files.readFile("/bad\0path")).rejects.toThrow(
      "path cannot contain NUL characters",
    );
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("rejects invalid protocol magic", async () => {
    const container = containerWith(
      processFromChunks([new Uint8Array([0x00, 0x42, 0x58, 0x46, 1, 0])]),
    );

    await expect(new ContainerFiles(container).readFile("/file")).rejects.toMatchObject({
      code: "SANDBOX_PROTOCOL_ERROR",
      reason: "INVALID_MAGIC",
    });
  });

  it("rejects incompatible shim protocols", async () => {
    const container = containerWith(
      processFromChunks([new Uint8Array([0x53, 0x42, 0x58, 0x46, 2, 0])]),
    );
    const promise = new ContainerFiles(container).readFile("/file");

    await expect(promise).rejects.toBeInstanceOf(SandboxProtocolError);
    await expect(promise).rejects.toMatchObject({
      name: "SandboxProtocolError",
      code: "SANDBOX_PROTOCOL_ERROR",
      reason: "UNSUPPORTED_VERSION",
      protocolVersion: 2,
    });
  });

  it("rejects unknown protocol statuses", async () => {
    const container = containerWith(
      processFromChunks([new Uint8Array([0x53, 0x42, 0x58, 0x46, 1, 9])]),
    );

    await expect(new ContainerFiles(container).readFile("/file")).rejects.toMatchObject({
      code: "SANDBOX_PROTOCOL_ERROR",
      reason: "UNKNOWN_STATUS",
      status: 9,
    });
  });

  it("rejects non-UTF-8 filesystem error details", async () => {
    const container = containerWith(processFromChunks(errorFrameBytes(5, new Uint8Array([0xff]))));

    const promise = new ContainerFiles(container).readFile("/file");

    await expect(promise).rejects.toMatchObject({
      code: "SANDBOX_PROTOCOL_ERROR",
      reason: "INVALID_ERROR_MESSAGE",
      cause: expect.any(TypeError),
    });
  });

  it("bounds filesystem error details", async () => {
    const detail = new Uint8Array(64 * 1024 + 1);
    const container = containerWith(processFromChunks(errorFrameBytes(5, detail)));

    await expect(new ContainerFiles(container).readFile("/file")).rejects.toMatchObject({
      code: "SANDBOX_PROTOCOL_ERROR",
      reason: "ERROR_MESSAGE_TOO_LARGE",
      limit: 64 * 1024,
    });
  });

  it("reports a late shim failure as a file read error", async () => {
    const process = processFromChunks(successFrame(new Uint8Array([1])), 9);
    const container = containerWith(process);
    const response = await new ContainerFiles(container).readFile("/file");

    await expect(response.arrayBuffer()).rejects.toMatchObject({
      name: "SandboxFileError",
      code: "EIO",
      operation: "readFile",
      path: "/file",
      detail: "sandbox-shim exited with code 9",
      message: "readFile '/file': sandbox-shim exited with code 9",
    });
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it("returns an empty response for an empty file", async () => {
    const container = containerWith(processFromChunks(successFrame()));

    const response = await new ContainerFiles(container).readFile("/empty");

    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("kills the process when the response body is cancelled", async () => {
    const streamCancelled = vi.fn(() => new Promise<void>(() => undefined));
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(SUCCESS_HEADER);
      },
      cancel: streamCancelled,
    });
    const process = processFromChunks([], 0, stdout);
    const container = containerWith(process);
    const response = await new ContainerFiles(container).readFile("/file");

    await response.body?.cancel("not needed");

    expect(streamCancelled).toHaveBeenCalledWith("not needed");
    expect(process.kill).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledWith(9);
  });

  it("kills the process when reading the response body fails", async () => {
    const streamError = new Error("stdout transport failed");
    let pullCount = 0;
    const stdout = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount === 0) {
          pullCount += 1;
          controller.enqueue(SUCCESS_HEADER);
          return;
        }
        throw streamError;
      },
    });
    const process = processFromChunks([], 0, stdout);
    const response = await new ContainerFiles(containerWith(process)).readFile("/file");

    await expect(response.arrayBuffer()).rejects.toBe(streamError);
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it("rejects a blocked frame read with the abort reason", async () => {
    const abort = new AbortController();
    const reason = new Error("caller stopped reading");
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    const stdout = new ReadableStream<Uint8Array>({
      async pull(controller) {
        readStarted.resolve();
        await releaseRead.promise;
        controller.close();
      },
      cancel() {
        releaseRead.resolve();
      },
    });
    const process = processFromChunks([], 0, stdout);
    const promise = new ContainerFiles(containerWith(process)).readFile("/file", {
      signal: abort.signal,
    });

    await readStarted.promise;
    abort.abort(reason);

    await expect(promise).rejects.toBe(reason);
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it("errors a blocked response body with the abort reason", async () => {
    const abort = new AbortController();
    const reason = new Error("caller stopped reading");
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(SUCCESS_HEADER);
      },
      async pull(controller) {
        readStarted.resolve();
        await releaseRead.promise;
        controller.close();
      },
      cancel() {
        releaseRead.resolve();
      },
    });
    const process = processFromChunks([], new Promise<number>(() => undefined), stdout);
    const response = await new ContainerFiles(containerWith(process)).readFile("/file", {
      signal: abort.signal,
    });
    const body = response.arrayBuffer();

    await readStarted.promise;
    abort.abort(reason);

    await expect(body).rejects.toBe(reason);
    expect(process.kill).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledWith(9);
  });

  it("preserves a pre-aborted signal reason", async () => {
    const abort = new AbortController();
    const reason = new Error("caller stopped before reading");
    abort.abort(reason);
    const container = containerWith(processFromChunks(successFrame()));

    const promise = new ContainerFiles(container).readFile("/file", { signal: abort.signal });

    await expect(promise).rejects.toBe(reason);
    expect(container.exec).toHaveBeenCalledOnce();
  });

  it("preserves abort when native process termination settles stdout", async () => {
    const abort = new AbortController();
    const reason = new Error("caller stopped reading");
    const pullStarted = deferred<void>();
    const pullPending = new Promise<void>(() => undefined);
    const exit = deferred<number>();
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
        controller.enqueue(SUCCESS_HEADER);
      },
      pull() {
        pullStarted.resolve();
        return pullPending;
      },
    });
    const process = processFromChunks([], exit.promise, stdout);
    const container = {
      exec: vi.fn((_command: string[], options: ContainerExecOptions) => {
        options.signal?.addEventListener("abort", () => {
          stdoutController?.close();
          exit.resolve(137);
        });
        return Promise.resolve(process);
      }),
    };
    const response = await new ContainerFiles(container).readFile("/file", {
      signal: abort.signal,
    });
    const body = response.arrayBuffer();

    await pullStarted.promise;
    abort.abort(reason);

    await expect(body).rejects.toBe(reason);
    expect(process.kill).toHaveBeenCalledWith(9);
  });

  it("preserves a terminal transport failure that precedes abort", async () => {
    const abort = new AbortController();
    const abortReason = new Error("caller stopped reading");
    const transportError = new Error("stdout transport failed");
    const stdout = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(transportError);
      },
    });
    const process = processFromChunks([], 0, stdout);
    const promise = new ContainerFiles(containerWith(process)).readFile("/file", {
      signal: abort.signal,
    });

    await expect(promise).rejects.toBe(transportError);
    abort.abort(abortReason);
  });

  it("kills the process after a truncated frame", async () => {
    const process = processFromChunks([new Uint8Array([0x53, 0x42])]);
    const container = containerWith(process);

    await expect(new ContainerFiles(container).readFile("/file")).rejects.toMatchObject({
      code: "SANDBOX_PROTOCOL_ERROR",
      reason: "TRUNCATED_FRAME",
    });
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it("rejects a process without piped stdout", async () => {
    const process = processFromChunks([], 0, null);
    const container = containerWith(process);

    await expect(new ContainerFiles(container).readFile("/file")).rejects.toMatchObject({
      code: "SANDBOX_PROTOCOL_ERROR",
      reason: "MISSING_STDOUT",
    });
    expect(process.kill).toHaveBeenCalledOnce();
  });
});
