import { describe, expect, it } from "vite-plus/test";

import { SandboxFileError, SandboxProtocolError } from "../src/errors.js";

describe("Sandbox errors", () => {
  it("recognizes errors after prototype identity is lost", () => {
    const fileError = Object.assign(new Error("missing"), {
      name: "SandboxFileError",
      code: "ENOENT",
      operation: "readFile",
      path: "/missing",
      detail: "No such file or directory",
    });
    const protocolError = Object.assign(new Error("invalid frame"), {
      name: "SandboxProtocolError",
      code: "SANDBOX_PROTOCOL_ERROR",
      reason: "INVALID_MAGIC",
    });
    const lateFileError = Object.assign(new Error("late failure"), {
      name: "SandboxFileError",
      code: "EIO",
      operation: "readFile",
      path: "/file",
      detail: "sandbox-shim exited with code 9",
    });
    const invalidMessageError = Object.assign(new Error("invalid message"), {
      name: "SandboxProtocolError",
      code: "SANDBOX_PROTOCOL_ERROR",
      reason: "INVALID_ERROR_MESSAGE",
      cause: new TypeError("invalid UTF-8"),
    });

    expect(fileError).not.toBeInstanceOf(SandboxFileError);
    expect(SandboxFileError.is(fileError)).toBe(true);
    expect(SandboxFileError.is(lateFileError)).toBe(true);
    expect(protocolError).not.toBeInstanceOf(SandboxProtocolError);
    expect(SandboxProtocolError.is(protocolError)).toBe(true);
    expect(SandboxProtocolError.is(invalidMessageError)).toBe(true);
  });

  it("rejects malformed crossed errors", () => {
    const invalidFileError = Object.assign(new Error("missing"), {
      name: "SandboxFileError",
      code: "ENOENT",
      operation: "readFile",
      path: 42,
      detail: "No such file or directory",
    });
    const incompleteProtocolError = Object.assign(new Error("unsupported"), {
      name: "SandboxProtocolError",
      code: "SANDBOX_PROTOCOL_ERROR",
      reason: "UNSUPPORTED_VERSION",
    });
    const inconsistentFileError = Object.assign(new Error("denied"), {
      name: "SandboxFileError",
      code: "FILE_NOT_FOUND",
      operation: "readFile",
      path: "/private",
      detail: "Permission denied",
    });
    const inconsistentProtocolError = Object.assign(new Error("invalid frame"), {
      name: "SandboxProtocolError",
      code: "SANDBOX_PROTOCOL_ERROR",
      reason: "INVALID_MAGIC",
      status: 9,
    });

    expect(SandboxFileError.is(invalidFileError)).toBe(false);
    expect(SandboxFileError.is(inconsistentFileError)).toBe(false);
    expect(SandboxProtocolError.is(incompleteProtocolError)).toBe(false);
    expect(SandboxProtocolError.is(inconsistentProtocolError)).toBe(false);
  });

  it("rejects invalid protocol construction metadata", () => {
    const contradictoryProtocolOptions = {
      reason: "INVALID_MAGIC" as const,
      status: 9,
    };

    expect(() => new SandboxProtocolError({ reason: "UNKNOWN_STATUS", status: 256 })).toThrow(
      TypeError,
    );
    expect(() => new SandboxProtocolError(contradictoryProtocolOptions)).toThrow(TypeError);
  });

  it("keeps contract fields as own properties", () => {
    const fileError = new SandboxFileError({
      code: "ENOENT",
      operation: "readFile",
      path: "/missing",
      detail: "No such file or directory",
    });
    const protocolError = new SandboxProtocolError({
      reason: "UNKNOWN_STATUS",
      status: 9,
    });
    const renameError = new SandboxFileError({
      code: "EXDEV",
      operation: "rename",
      path: "/source",
      destination: "/destination",
      detail: "Cross-device link",
    });

    expect(Object.hasOwn(fileError, "name")).toBe(true);
    expect(Object.hasOwn(fileError, "code")).toBe(true);
    expect(Object.hasOwn(fileError, "operation")).toBe(true);
    expect(Object.hasOwn(fileError, "path")).toBe(true);
    expect(Object.hasOwn(fileError, "detail")).toBe(true);
    expect(Object.hasOwn(fileError, "destination")).toBe(false);
    expect(Object.hasOwn(renameError, "destination")).toBe(true);
    expect(SandboxFileError.is(renameError)).toBe(true);
    expect(Object.hasOwn(protocolError, "name")).toBe(true);
    expect(Object.hasOwn(protocolError, "code")).toBe(true);
    expect(Object.hasOwn(protocolError, "reason")).toBe(true);
    expect(Object.hasOwn(protocolError, "status")).toBe(true);
  });
});
