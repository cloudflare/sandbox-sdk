import { describe, expect, it } from "vite-plus/test";

import { Files } from "../src/files.js";
import { commandProcess, containerWith, dataFrame, errorFrame, SUCCESS_HEADER } from "./helpers.js";

describe("Files.mkdir", () => {
  it("creates one directory and forwards native options", async () => {
    const container = containerWith(commandProcess([SUCCESS_HEADER]));
    const signal = new AbortController().signal;

    await new Files(container).mkdir("created", {
      cwd: "/workspace",
      user: "1000:1000",
      signal,
    });

    expect(container.exec).toHaveBeenCalledWith(
      ["/usr/local/bin/sandbox-shim", "mkdir", "created"],
      {
        cwd: "/workspace",
        user: "1000:1000",
        signal,
        stdout: "pipe",
        stderr: "ignore",
      },
    );
  });

  it("requests recursive creation explicitly", async () => {
    const container = containerWith(commandProcess([SUCCESS_HEADER]));

    await new Files(container).mkdir("parent/child", {
      cwd: "/workspace",
      recursive: true,
    });

    expect(container.exec).toHaveBeenCalledWith(
      ["/usr/local/bin/sandbox-shim", "mkdir", "parent/child", "--recursive"],
      {
        cwd: "/workspace",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
  });

  it("maps native filesystem errors", async () => {
    const promise = new Files(containerWith(commandProcess(errorFrame(17, "File exists")))).mkdir(
      "/workspace/existing",
    );

    await expect(promise).rejects.toMatchObject({
      code: "EEXIST",
      operation: "mkdir",
      path: "/workspace/existing",
    });
  });

  it("rejects unexpected mutation data", async () => {
    await expect(
      new Files(containerWith(commandProcess(dataFrame(new Uint8Array([1]))))).mkdir(
        "/workspace/created",
      ),
    ).rejects.toThrow("sandbox-shim did not confirm command completion");
  });
});
