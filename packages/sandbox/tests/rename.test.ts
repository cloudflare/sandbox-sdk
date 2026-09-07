import { describe, expect, it } from "vite-plus/test";

import { Files } from "../src/files.js";
import { commandProcess, containerWith, dataFrame, errorFrame, SUCCESS_HEADER } from "./helpers.js";

describe("Files.rename", () => {
  it("renames one path and forwards native options", async () => {
    const container = containerWith(commandProcess([SUCCESS_HEADER]));
    const signal = new AbortController().signal;

    await new Files(container).rename("source", "destination", {
      cwd: "/workspace",
      user: "1000:1000",
      signal,
    });

    expect(container.exec).toHaveBeenCalledWith(
      ["/usr/local/bin/sandbox-shim", "rename", "source", "destination"],
      {
        cwd: "/workspace",
        user: "1000:1000",
        signal,
        stdout: "pipe",
        stderr: "ignore",
      },
    );
  });

  it("maps native errors with both paths", async () => {
    const promise = new Files(
      containerWith(commandProcess(errorFrame(2, "No such file or directory"))),
    ).rename("/workspace/missing", "/workspace/destination");

    await expect(promise).rejects.toMatchObject({
      code: "ENOENT",
      operation: "rename",
      path: "/workspace/missing",
      destination: "/workspace/destination",
    });
  });

  it("validates the destination path", async () => {
    const container = containerWith(commandProcess([SUCCESS_HEADER]));

    await expect(new Files(container).rename("/workspace/source", "relative")).rejects.toThrow(
      "cwd is required when path is relative",
    );
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("rejects non-string path representations", async () => {
    const container = containerWith(commandProcess([SUCCESS_HEADER]));
    const files = new Files(container);
    const stringLike = {
      length: 1,
      includes: () => false,
      startsWith: () => true,
    };

    // @ts-expect-error Runtime callers can cross the TypeScript interface.
    await expect(files.rename("/source", stringLike)).rejects.toThrow("path must be a string");
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("rejects unexpected command data", async () => {
    await expect(
      new Files(containerWith(commandProcess(dataFrame(new Uint8Array([1]))))).rename(
        "/workspace/source",
        "/workspace/destination",
      ),
    ).rejects.toThrow("sandbox-shim did not confirm command completion");
  });
});
