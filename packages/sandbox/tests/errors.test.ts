import { describe, expect, it } from "vite-plus/test";

import {
  fileErrorFromErrno,
  protocolError,
  SandboxFileError,
  SandboxProtocolError,
} from "../src/errors.js";

describe("Sandbox errors", () => {
  it("exposes recognizers without public constructors", () => {
    expect(Object.keys(SandboxFileError)).toEqual(["is"]);
    expect(Object.keys(SandboxProtocolError)).toEqual(["is"]);
  });

  it("recognizes structured errors after prototype identity is lost", () => {
    const fileError = Object.assign(new Error("missing"), {
      name: "SandboxFileError",
      code: "ENOENT",
      operation: "readFile",
      path: "/missing",
      detail: "No such file or directory",
    });
    const protocolError = Object.assign(new Error("invalid control"), {
      name: "SandboxProtocolError",
      code: "SANDBOX_PROTOCOL_ERROR",
      detail: "sandbox-shim returned invalid control data",
    });

    expect(SandboxFileError.is(fileError)).toBe(true);
    expect(SandboxProtocolError.is(protocolError)).toBe(true);
  });

  it("requires the stable fields used by consumers", () => {
    const missingCode = Object.assign(new Error("missing"), {
      name: "SandboxFileError",
      operation: "readFile",
      path: "/missing",
      detail: "No such file or directory",
    });
    const missingDetail = Object.assign(new Error("invalid control"), {
      name: "SandboxProtocolError",
      code: "SANDBOX_PROTOCOL_ERROR",
    });
    const invalidCode = Object.assign(new Error("invalid code"), missingCode, {
      code: "not-an-errno",
    });
    const invalidOperation = Object.assign(new Error("invalid operation"), missingCode, {
      code: "ENOENT",
      operation: "copyFile",
    });

    expect(SandboxFileError.is(missingCode)).toBe(false);
    expect(SandboxFileError.is(invalidCode)).toBe(false);
    expect(SandboxFileError.is(invalidOperation)).toBe(false);
    expect(SandboxProtocolError.is(missingDetail)).toBe(false);
  });

  it("keeps contract fields as own properties", () => {
    const fileError = fileErrorFromErrno(
      { operation: "readFile", path: "/missing" },
      2,
      "No such file or directory",
    );
    const createdProtocolError = protocolError("invalid control");

    for (const field of ["name", "code", "operation", "path", "detail"]) {
      expect(Object.hasOwn(fileError, field)).toBe(true);
    }
    expect(Object.hasOwn(fileError, "errno")).toBe(false);
    expect(SandboxFileError.is(fileError)).toBe(true);
    expect(Object.hasOwn(createdProtocolError, "detail")).toBe(true);
  });

  it("includes rename destinations in the stable error contract", () => {
    const error = fileErrorFromErrno(
      { operation: "rename", path: "/source", destination: "/destination" },
      2,
      "No such file or directory",
    );

    expect(error.message).toBe("rename '/source' to '/destination': No such file or directory");
    expect(Object.hasOwn(error, "destination")).toBe(true);
    expect(SandboxFileError.is(error)).toBe(true);
  });
});
