import { describe, expect, it } from "vite-plus/test";

import { SandboxFileError, SandboxProtocolError } from "../src/errors.js";

describe("Sandbox errors", () => {
  it("recognizes structured errors after prototype identity is lost", () => {
    const fileError = Object.assign(new Error("missing"), {
      name: "SandboxFileError",
      code: "ENOENT",
      errno: 2,
      operation: "readFile",
      path: "/missing",
      detail: "No such file or directory",
    });
    const protocolError = Object.assign(new Error("invalid control"), {
      name: "SandboxProtocolError",
      code: "SANDBOX_PROTOCOL_ERROR",
      reason: "INCOMPATIBLE_SHIM",
      detail: "sandbox-shim returned invalid control data",
    });

    expect(fileError).not.toBeInstanceOf(SandboxFileError);
    expect(protocolError).not.toBeInstanceOf(SandboxProtocolError);
    expect(SandboxFileError.is(fileError)).toBe(true);
    expect(SandboxProtocolError.is(protocolError)).toBe(true);
  });

  it("requires the stable fields used by consumers", () => {
    const missingErrno = Object.assign(new Error("missing"), {
      name: "SandboxFileError",
      code: "ENOENT",
      operation: "readFile",
      path: "/missing",
      detail: "No such file or directory",
    });
    const missingDetail = Object.assign(new Error("invalid control"), {
      name: "SandboxProtocolError",
      code: "SANDBOX_PROTOCOL_ERROR",
      reason: "INCOMPATIBLE_SHIM",
    });

    expect(SandboxFileError.is(missingErrno)).toBe(false);
    expect(SandboxProtocolError.is(missingDetail)).toBe(false);
  });

  it("keeps contract fields as own properties", () => {
    const fileError = new SandboxFileError({
      code: "ENOENT",
      errno: 2,
      operation: "readFile",
      path: "/missing",
      detail: "No such file or directory",
    });
    const renameError = new SandboxFileError({
      code: "EXDEV",
      errno: 18,
      operation: "rename",
      path: "/source",
      destination: "/destination",
      detail: "Cross-device link",
    });
    const protocolError = new SandboxProtocolError({ detail: "invalid control" });

    for (const field of ["name", "code", "errno", "operation", "path", "detail"]) {
      expect(Object.hasOwn(fileError, field)).toBe(true);
    }
    expect(Object.hasOwn(fileError, "destination")).toBe(false);
    expect(Object.hasOwn(renameError, "destination")).toBe(true);
    expect(Object.hasOwn(protocolError, "reason")).toBe(true);
    expect(Object.hasOwn(protocolError, "detail")).toBe(true);
  });
});
