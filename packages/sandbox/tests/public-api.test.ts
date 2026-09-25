import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import * as sandbox from "../src/index.js";
import type {
  DirectoryBackup,
  DirectoryBackupGatewayBinding,
  DirectoryBackupOperation,
  S3GatewayBinding,
  S3MountOperation,
  S3MountOperationOptions,
  SandboxBackupErrorCode,
  SandboxS3MountErrorCode,
} from "../src/index.js";

describe("public API", () => {
  it("exports the supported filesystem APIs and error recognizers", () => {
    expect(Object.keys(sandbox).sort()).toEqual([
      "DirectoryBackupGateway",
      "DirectoryBackups",
      "Files",
      "S3Gateway",
      "S3Mounts",
      "SandboxBackupError",
      "SandboxFileError",
      "SandboxProtocolError",
      "SandboxS3MountError",
    ]);
  });

  it("exports the directory backup record and error types", () => {
    expectTypeOf<DirectoryBackupGatewayBinding>().toBeFunction();
    expectTypeOf<DirectoryBackup>().toEqualTypeOf<{
      readonly id: string;
      readonly dir: string;
      readonly size: number;
      readonly name?: string;
      readonly sha256: string;
      readonly format: "tar+zstd/1";
    }>();
    expectTypeOf<DirectoryBackupOperation>().toEqualTypeOf<"backup" | "restore" | "delete">();
    expectTypeOf<SandboxBackupErrorCode>().toEqualTypeOf<
      "BACKUP_NOT_FOUND" | "BACKUP_INTEGRITY" | "BACKUP_TRANSFER"
    >();
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
