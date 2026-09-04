import { describe, expect, it, vi } from "vite-plus/test";

import { ContainerFiles } from "../src/container-files.js";
import { SandboxFileError, SandboxProtocolError } from "../src/errors.js";
import {
  containerWith,
  contiguousErrorFrame as errorFrame,
  dataFrame,
  deferred,
  encoder,
  readableChunks,
  SUCCESS_HEADER,
  writeProcess,
} from "./helpers.js";

describe("ContainerFiles.writeFile", () => {
  it("streams bytes and forwards native options", async () => {
    const written: Uint8Array[] = [];
    const stdin = new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(new Uint8Array(chunk));
      },
    });
    const process = writeProcess({ stdin });
    const container = containerWith(process);
    const signal = new AbortController().signal;

    await new ContainerFiles(container).writeFile("data.bin", "hello", {
      cwd: "/workspace",
      user: "1000:1000",
      signal,
    });

    expect(written).toEqual([encoder.encode("hello")]);
    expect(process.kill).not.toHaveBeenCalled();
    expect(container.exec).toHaveBeenCalledWith(
      ["/usr/local/bin/sandbox-shim", "write", "data.bin"],
      {
        cwd: "/workspace",
        user: "1000:1000",
        signal,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
  });

  it("accepts binary buffers, views, blobs, and streams", async () => {
    const inputs = [
      new Uint8Array([1, 2]).buffer,
      new Uint8Array([0, 1, 2, 3]).subarray(1, 3),
      new Blob([new Uint8Array([1, 2])]),
      readableChunks([new Uint8Array([1]), new Uint8Array([2])]),
    ];

    for (const input of inputs) {
      const written: number[] = [];
      const process = writeProcess({
        stdin: new WritableStream<Uint8Array>({
          write(chunk) {
            written.push(...chunk);
          },
        }),
      });

      await new ContainerFiles(containerWith(process)).writeFile("/file", input);

      expect(written).toEqual([1, 2]);
    }
  });

  it("does not pull the source before the opening success frame", async () => {
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    });
    let pulled = false;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const promise = new ContainerFiles(containerWith(writeProcess({ control: stdout }))).writeFile(
      "/file",
      source,
    );

    await Promise.resolve();
    expect(pulled).toBe(false);

    stdoutController?.enqueue(SUCCESS_HEADER);
    await vi.waitFor(() => expect(pulled).toBe(true));
    stdoutController?.enqueue(SUCCESS_HEADER);
    stdoutController?.close();
    await promise;
  });

  it("maps opening filesystem errors without pulling the source", async () => {
    const cancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      cancel: cancelled,
    });
    const getReader = vi.spyOn(source, "getReader");
    const process = writeProcess({ control: readableChunks([errorFrame(21, "Is a directory")]) });

    const promise = new ContainerFiles(containerWith(process)).writeFile("/directory", source);

    await expect(promise).rejects.toMatchObject({
      name: "SandboxFileError",
      code: "EISDIR",
      operation: "writeFile",
      path: "/directory",
      detail: "Is a directory",
    });
    expect(getReader).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledWith(expect.any(SandboxFileError));
    expect(process.kill).toHaveBeenCalledWith(9);
  });

  it("maps terminal filesystem errors", async () => {
    const process = writeProcess({
      control: readableChunks([SUCCESS_HEADER, errorFrame(28, "No space left on device")]),
    });

    await expect(
      new ContainerFiles(containerWith(process)).writeFile("/file", new Uint8Array([1])),
    ).rejects.toMatchObject({
      code: "ENOSPC",
      operation: "writeFile",
      path: "/file",
    });
    expect(process.kill).toHaveBeenCalledWith(9);
  });

  it("does not wait for more source data after a terminal filesystem error", async () => {
    const cancelled = vi.fn();
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new Uint8Array([1]));
        else return new Promise<void>(() => undefined);
      },
      cancel: cancelled,
    });
    const process = writeProcess({
      control: readableChunks([SUCCESS_HEADER, errorFrame(28, "No space left on device")]),
    });

    await expect(
      new ContainerFiles(containerWith(process)).writeFile("/file", source),
    ).rejects.toMatchObject({ code: "ENOSPC", operation: "writeFile" });
    expect(cancelled).toHaveBeenCalledWith(expect.objectContaining({ code: "ENOSPC" }));
    expect(process.kill).toHaveBeenCalledWith(9);
  });

  it("prefers a terminal filesystem error over the resulting stdin failure", async () => {
    const pipeError = new Error("stdin closed");
    const process = writeProcess({
      stdin: new WritableStream<Uint8Array>({
        write() {
          throw pipeError;
        },
      }),
      control: readableChunks([SUCCESS_HEADER, errorFrame(28, "No space left on device")]),
    });

    await expect(
      new ContainerFiles(containerWith(process)).writeFile("/file", new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "ENOSPC", operation: "writeFile" });
  });

  it("preserves a source failure that races a terminal filesystem error", async () => {
    const sourceError = new Error("source failed");
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(sourceError);
      },
    });
    const process = writeProcess({
      control: readableChunks([SUCCESS_HEADER, errorFrame(28, "No space left on device")]),
    });

    await expect(
      new ContainerFiles(containerWith(process)).writeFile("/file", source),
    ).rejects.toBe(sourceError);
  });

  it("reports a missing terminal frame as a protocol failure", async () => {
    const process = writeProcess({ control: readableChunks([SUCCESS_HEADER]), exitCode: 9 });

    await expect(
      new ContainerFiles(containerWith(process)).writeFile("/file", new Uint8Array()),
    ).rejects.toMatchObject({
      code: "SANDBOX_PROTOCOL_ERROR",
    });
  });

  it("rejects metadata frames in the file write protocol", async () => {
    const process = writeProcess({ control: readableChunks(dataFrame(new Uint8Array([1]))) });

    await expect(
      new ContainerFiles(containerWith(process)).writeFile("/file", new Uint8Array()),
    ).rejects.toBeInstanceOf(SandboxProtocolError);
  });

  it("preserves source failures and terminates the process", async () => {
    const sourceError = new Error("source failed");
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(sourceError);
      },
    });
    const process = writeProcess({ control: readableChunks([SUCCESS_HEADER]), exitCode: 1 });

    const promise = new ContainerFiles(containerWith(process)).writeFile("/file", source);

    await expect(promise).rejects.toBe(sourceError);
    expect(process.kill).toHaveBeenCalledWith(9);
  });

  it("does not pull another source chunk while stdin is backpressured", async () => {
    const releaseWrite = deferred<void>();
    const writeStarted = deferred<void>();
    let writes = 0;
    const stdin = new WritableStream<Uint8Array>({
      write() {
        writes += 1;
        if (writes === 1) {
          writeStarted.resolve();
          return releaseWrite.promise;
        }
      },
    });
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls <= 2) controller.enqueue(new Uint8Array([pulls]));
          else controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const promise = new ContainerFiles(containerWith(writeProcess({ stdin }))).writeFile(
      "/file",
      source,
    );

    await writeStarted.promise;
    expect(pulls).toBe(1);

    releaseWrite.resolve();
    await promise;
    expect(pulls).toBe(3);
  });

  it("preserves abort reasons while writing", async () => {
    const abort = new AbortController();
    const reason = new Error("caller stopped writing");
    const writeStarted = deferred<void>();
    const stdin = new WritableStream<Uint8Array>({
      write() {
        writeStarted.resolve();
        return new Promise<void>(() => undefined);
      },
    });
    const source = readableChunks([new Uint8Array([1])]);
    const process = writeProcess({
      stdin,
      control: readableChunks([SUCCESS_HEADER], false),
      exitCode: new Promise<number>(() => undefined),
    });
    const promise = new ContainerFiles(containerWith(process)).writeFile("/file", source, {
      signal: abort.signal,
    });

    await writeStarted.promise;
    abort.abort(reason);

    await expect(promise).rejects.toBe(reason);
    expect(process.kill).toHaveBeenCalledWith(9);
  });

  it("rejects missing native process streams", async () => {
    const missingStdout = writeProcess({ control: null });
    const missingStdin = writeProcess({ stdin: null });

    await expect(
      new ContainerFiles(containerWith(missingStdout)).writeFile("/file", "content"),
    ).rejects.toMatchObject({ code: "SANDBOX_PROTOCOL_ERROR" });
    await expect(
      new ContainerFiles(containerWith(missingStdin)).writeFile("/file", "content"),
    ).rejects.toMatchObject({ code: "SANDBOX_PROTOCOL_ERROR" });
    expect(missingStdout.kill).toHaveBeenCalledWith(9);
    expect(missingStdin.kill).toHaveBeenCalledWith(9);
  });

  it("cleans up when a native stream lock cannot be acquired", async () => {
    const stdin = new WritableStream<Uint8Array>();
    const existingWriter = stdin.getWriter();
    const process = writeProcess({ stdin });
    const cancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel: cancelled });

    await expect(
      new ContainerFiles(containerWith(process)).writeFile("/file", source),
    ).rejects.toBeInstanceOf(TypeError);
    expect(process.kill).toHaveBeenCalledWith(9);
    expect(cancelled).toHaveBeenCalledOnce();

    existingWriter.releaseLock();
  });

  it("validates paths before launching or cancelling a source", async () => {
    const cancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const container = containerWith(writeProcess());

    await expect(new ContainerFiles(container).writeFile("relative", source)).rejects.toThrow(
      "cwd is required when path is relative",
    );
    expect(container.exec).not.toHaveBeenCalled();
    expect(cancelled).not.toHaveBeenCalled();
  });
});
