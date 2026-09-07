import { describe, expect, it } from "vite-plus/test";

import * as sandbox from "../src/index.js";

describe("public API", () => {
  it("exports only file operations and error recognizers", () => {
    expect(Object.keys(sandbox).sort()).toEqual([
      "Files",
      "SandboxFileError",
      "SandboxProtocolError",
    ]);
  });
});
