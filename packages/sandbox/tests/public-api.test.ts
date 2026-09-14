import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import * as sandbox from "../src/index.js";
import type {
  S3GatewayBinding,
  S3MountOperation,
  S3MountOperationOptions,
  SandboxS3MountErrorCode,
} from "../src/index.js";

describe("public API", () => {
  it("exports the supported filesystem APIs and error recognizers", () => {
    expect(Object.keys(sandbox).sort()).toEqual([
      "Files",
      "S3Gateway",
      "S3Mounts",
      "SandboxFileError",
      "SandboxProtocolError",
      "SandboxS3MountError",
    ]);
  });

  it("exports types needed to wrap mount lifecycle operations", () => {
    expectTypeOf<S3GatewayBinding>().toBeFunction();
    expectTypeOf<S3MountOperationOptions>().toMatchTypeOf<{ signal?: AbortSignal }>();
    expectTypeOf<S3MountOperation>().toEqualTypeOf<"mount" | "inspect" | "unmount">();
    expectTypeOf<SandboxS3MountErrorCode>().toEqualTypeOf<
      "S3_MOUNT_CONFLICT" | "S3_MOUNT_BUSY" | "S3_MOUNT_FAILED" | "S3_MOUNT_INCOMPATIBLE"
    >();
  });
});
