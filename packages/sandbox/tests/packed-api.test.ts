import { existsSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const entry = new URL("../dist/index.mjs", import.meta.url);

describe.skipIf(!existsSync(entry))("packed public API", () => {
  it("contains the runtime exports required by an S3 mount", async () => {
    const sandbox = await import("../dist/index.mjs");

    expect(Object.keys(sandbox).sort()).toEqual([
      "Files",
      "S3Gateway",
      "S3Mounts",
      "SandboxFileError",
      "SandboxProtocolError",
      "SandboxS3MountError",
    ]);
  });
});
