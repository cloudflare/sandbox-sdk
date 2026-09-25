import { describe, expect, it } from "vite-plus/test";

import { Files } from "../src/files/files.js";
import { commandProcess, containerWith, errorFrame, SUCCESS_HEADER } from "./helpers.js";

describe("Files.remove", () => {
  it("removes one path, joins a relative path onto cwd, and forwards native options", async () => {
    const container = containerWith(commandProcess([SUCCESS_HEADER]));
    const signal = new AbortController().signal;

    await new Files(container).remove("file.txt", {
      cwd: "/workspace",
      user: "1000:1000",
      signal,
    });

    expect(container.exec).toHaveBeenCalledWith(
      ["/usr/local/bin/sandbox-shim", "remove", "/workspace/file.txt"],
      {
        user: "1000:1000",
        signal: expect.any(AbortSignal),
        stdout: "pipe",
        stderr: "ignore",
      },
    );
  });

  it("requests recursive and forced removal explicitly", async () => {
    const container = containerWith(commandProcess([SUCCESS_HEADER]));

    await new Files(container).remove("directory", {
      cwd: "/workspace",
      recursive: true,
      force: true,
    });

    expect(container.exec).toHaveBeenCalledWith(
      ["/usr/local/bin/sandbox-shim", "remove", "/workspace/directory", "--recursive", "--force"],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    );
  });

  it("rejects a non-boolean force flag", async () => {
    const container = containerWith(commandProcess([SUCCESS_HEADER]));

    // @ts-expect-error Runtime callers can cross the TypeScript interface.
    await expect(new Files(container).remove("/a", { force: 1 })).rejects.toThrow(
      "force must be a boolean",
    );
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("maps native filesystem errors", async () => {
    const promise = new Files(
      containerWith(commandProcess(errorFrame(21, "Is a directory"))),
    ).remove("/workspace/directory");

    await expect(promise).rejects.toMatchObject({
      code: "EISDIR",
      operation: "remove",
      path: "/workspace/directory",
    });
  });
});
