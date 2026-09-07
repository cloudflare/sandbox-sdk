import { describe, expect, it } from "vite-plus/test";

import { Files } from "../src/files.js";
import { commandProcess, containerWith, errorFrame, SUCCESS_HEADER } from "./helpers.js";

describe("Files.remove", () => {
  it("removes one path and forwards native options", async () => {
    const container = containerWith(commandProcess([SUCCESS_HEADER]));
    const signal = new AbortController().signal;

    await new Files(container).remove("file.txt", {
      cwd: "/workspace",
      user: "1000:1000",
      signal,
    });

    expect(container.exec).toHaveBeenCalledWith(
      ["/usr/local/bin/sandbox-shim", "remove", "file.txt"],
      {
        cwd: "/workspace",
        user: "1000:1000",
        signal,
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
      ["/usr/local/bin/sandbox-shim", "remove", "directory", "--recursive", "--force"],
      {
        cwd: "/workspace",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
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
