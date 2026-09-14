import * as z from "zod/mini";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  SandboxProtocolError,
  SandboxS3MountError,
  S3Mounts,
  type S3MountRequest,
} from "../src/index.js";
import type { S3GatewayBinding, S3MountObservedConfiguration } from "../src/s3-mounts/contracts.js";
import {
  commandProcess,
  dataFrame,
  deferred,
  encoder,
  interactiveCommandProcess,
} from "./helpers.js";
import { TestFetcher } from "./worker-test-doubles.js";

const observedConfigurationSchema = z.object({
  source: z.object({
    type: z.literal("s3"),
    endpoint: z.string(),
    region: z.string(),
    bucket: z.string(),
  }),
  keyPrefix: z.optional(z.string()),
  access: z.union([z.literal("read-only"), z.literal("read-write")]),
  s3fsOptions: z.array(z.object({ name: z.string(), value: z.optional(z.string()) })),
});
const guestRequestSchema = z.object({
  protocolVersion: z.literal(1),
  candidateRouteId: z.string(),
  mountPath: z.string(),
  configuration: observedConfigurationSchema,
});

const configuration: S3MountObservedConfiguration = {
  source: {
    type: "s3",
    endpoint: "http://minio:9000/",
    region: "us-east-1",
    bucket: "models",
  },
  keyPrefix: "current/",
  access: "read-write",
  s3fsOptions: [{ name: "max_stat_cache_size", value: "1000" }, { name: "nomixupload" }],
};

const request: S3MountRequest = {
  mountPath: "/mnt/models",
  source: {
    type: "s3",
    endpoint: "http://minio:9000",
    region: "us-east-1",
    bucket: "models",
    credentials: {
      type: "static",
      accessKeyId: "real-access-key",
      secretAccessKey: "real-secret-key",
    },
  },
  keyPrefix: "current",
  access: "read-write",
  s3fsOptions: {
    max_stat_cache_size: 1_000,
    nomixupload: true,
    no_check_certificate: false,
  },
};

function response<Value>(value: Value): Uint8Array[] {
  return dataFrame(encoder.encode(JSON.stringify({ ok: true, value })));
}

function errorFrames(kind: string, detail: string): Uint8Array[] {
  return dataFrame(encoder.encode(JSON.stringify({ ok: false, error: { kind, detail } })));
}

function errorResponse(kind: string, detail: string): ExecProcess {
  return commandProcess(errorFrames(kind, detail));
}

function routeProcess(routeId: string, write?: (chunk: Uint8Array) => void) {
  return interactiveCommandProcess(
    [...response({ kind: "route", routeId }), ...response(null)],
    write,
  );
}

function inspectionProcess<State, Gateway>(state: State, gateway?: Gateway): ExecProcess {
  return commandProcess(response(gateway === undefined ? { state } : { state, gateway }));
}

function marker<Configuration>(options: { routeId: string; configuration?: Configuration }) {
  return {
    protocolVersion: 1,
    routeId: options.routeId,
    mountPath: "/mnt/models",
    configuration: options.configuration ?? configuration,
  };
}

function managedState(options: {
  routeId: string;
  fuse?: { status: "connected" } | { status: "disconnected" };
}) {
  return {
    kind: "managed",
    fuse: options.fuse ?? { status: "connected" },
    marker: marker(options),
  };
}

function gatewayBinding() {
  const fetcher = new TestFetcher();
  const factory: S3GatewayBinding = vi.fn(() => fetcher);
  return {
    fetcher,
    factory,
  };
}

function containerWithResponses(...processes: ExecProcess[]) {
  return {
    exec: vi
      .fn()
      .mockImplementation(async (_command: string[], _options?: ContainerExecOptions) => {
        const process = processes.shift();
        if (process === undefined) throw new Error("unexpected exec");
        return process;
      }),
    interceptOutboundHttp: vi.fn().mockResolvedValue(undefined),
  };
}

function firstExecCall(container: ReturnType<typeof containerWithResponses>) {
  const call = container.exec.mock.calls[0];
  if (call === undefined) throw new Error("expected container.exec to be called");
  return call;
}

function parseGuestRequest(command: string[]) {
  return guestRequestSchema.parse(JSON.parse(command[3] ?? ""));
}

describe("S3Mounts", () => {
  it("installs the route selected by one interactive shim operation", async () => {
    const writes: Uint8Array[] = [];
    const container = containerWithResponses(
      routeProcess("route-123", (chunk) => writes.push(chunk)),
    );
    const gateway = gatewayBinding();

    await new S3Mounts(container, gateway.factory).mount(request);

    expect(container.exec).toHaveBeenCalledTimes(1);
    const [command, options] = firstExecCall(container);
    expect(command.slice(0, 3)).toEqual(["/usr/local/bin/sandbox-shim", "s3-mount", "mount"]);
    expect(options).toMatchObject({ stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    const guestRequest = parseGuestRequest(command);
    expect(JSON.stringify(guestRequest)).not.toContain("real-access-key");
    expect(JSON.stringify(guestRequest)).not.toContain("real-secret-key");
    expect(guestRequest).toMatchObject({
      protocolVersion: 1,
      mountPath: "/mnt/models",
      configuration,
    });
    expect(guestRequest.candidateRouteId).toBeTypeOf("string");
    expect(container.interceptOutboundHttp).toHaveBeenCalledWith(
      "s3-route-123.sandbox.internal",
      gateway.fetcher,
    );
    expect(gateway.factory).toHaveBeenCalledWith({
      props: expect.objectContaining({
        routeId: "route-123",
        keyPrefix: "current/",
        access: "read-write",
        source: expect.objectContaining({
          credentials: expect.objectContaining({ accessKeyId: "real-access-key" }),
        }),
      }),
    });
    expect(writes).toEqual([new Uint8Array([1])]);
  });

  it("canonicalizes only the trailing key-prefix separator", async () => {
    const container = containerWithResponses(routeProcess("route-123"));

    await new S3Mounts(container, gatewayBinding().factory).mount({
      ...request,
      keyPrefix: "Models//Δ data/%2F",
    });

    const [command] = firstExecCall(container);
    const guestRequest = parseGuestRequest(command);
    expect(guestRequest.configuration.keyPrefix).toBe("Models//Δ data/%2F/");
  });

  it("uses a route chosen from guest state instead of the candidate route", async () => {
    const container = containerWithResponses(routeProcess("existing-route"));

    await new S3Mounts(container, gatewayBinding().factory).mount(request);

    const [command] = firstExecCall(container);
    const guestRequest = parseGuestRequest(command);
    expect(guestRequest.candidateRouteId).not.toBe("existing-route");
    expect(container.interceptOutboundHttp.mock.calls[0]?.[0]).toBe(
      "s3-existing-route.sandbox.internal",
    );
  });

  it("does not install a route when the shim reports a conflict", async () => {
    const container = containerWithResponses(
      errorResponse("conflict", "a different configuration occupies the path"),
    );

    const error = await new S3Mounts(container, gatewayBinding().factory)
      .mount(request)
      .catch((cause: unknown) => cause);

    expect(SandboxS3MountError.is(error)).toBe(true);
    expect(error).toMatchObject({ code: "S3_MOUNT_CONFLICT", operation: "mount" });
    expect(container.interceptOutboundHttp).not.toHaveBeenCalled();
  });

  it("returns managed attachment, FUSE, gateway, and upstream evidence from one process", async () => {
    const container = containerWithResponses(
      inspectionProcess(managedState({ routeId: "route-123" }), {
        kind: "upstreamRejected",
        reason: "credentials",
        detail: "credentials were rejected",
      }),
    );

    await expect(
      new S3Mounts(container, gatewayBinding().factory).inspect("/mnt/models"),
    ).resolves.toEqual({
      mountPath: "/mnt/models",
      attachment: { status: "managed", configuration },
      fuse: { status: "connected" },
      gateway: {
        status: "reachable",
        upstream: {
          status: "rejected",
          reason: "credentials",
          detail: "credentials were rejected",
        },
      },
    });
    expect(container.exec).toHaveBeenCalledTimes(1);
    expect(container.exec.mock.calls[0]?.[0]).toEqual([
      "/usr/local/bin/sandbox-shim",
      "s3-mount",
      "inspect",
      "/mnt/models",
    ]);
  });

  it("omits evidence that does not apply to absent, unmanaged, and incompatible paths", async () => {
    const cases = [
      {
        state: { kind: "absent" },
        expected: { mountPath: "/mnt/models", attachment: { status: "absent" } },
      },
      {
        state: { kind: "unmanaged", filesystemType: "ext4" },
        expected: {
          mountPath: "/mnt/models",
          attachment: { status: "unmanaged", filesystemType: "ext4" },
        },
      },
      {
        state: { kind: "incompatible", protocolVersion: 2 },
        expected: { mountPath: "/mnt/models", attachment: { status: "incompatible" } },
      },
    ];

    for (const testCase of cases) {
      const container = containerWithResponses(inspectionProcess(testCase.state));
      await expect(
        new S3Mounts(container, gatewayBinding().factory).inspect("/mnt/models"),
      ).resolves.toEqual(testCase.expected);
    }
  });

  it("preserves independent FUSE and gateway evidence", async () => {
    const cases = [
      {
        fuse: { status: "disconnected" },
        wire: { kind: "gatewayUnreachable", detail: "host did not resolve" },
        gateway: { status: "unreachable", detail: "host did not resolve" },
      },
      {
        fuse: { status: "indeterminate", detail: "statfs was interrupted" },
        wire: {
          kind: "gatewayError",
          reason: "credential-provider",
          detail: "provider rejected the request",
        },
        gateway: {
          status: "error",
          reason: "credential-provider",
          detail: "provider rejected the request",
        },
      },
      {
        fuse: { status: "connected" },
        wire: { kind: "usable" },
        gateway: { status: "reachable", upstream: { status: "usable" } },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const state = {
        kind: "managed",
        fuse: testCase.fuse,
        marker: marker({ routeId: `route-${index}` }),
      };
      const container = containerWithResponses(inspectionProcess(state, testCase.wire));
      await expect(
        new S3Mounts(container, gatewayBinding().factory).inspect("/mnt/models"),
      ).resolves.toMatchObject({ fuse: testCase.fuse, gateway: testCase.gateway });
    }
  });

  it("reports stale configuration without meaningless FUSE evidence", async () => {
    const alternateConfiguration: S3MountObservedConfiguration = {
      source: {
        type: "s3",
        endpoint: "https://storage.example.test/",
        region: "auto",
        bucket: "models-production",
      },
      access: "read-only",
      s3fsOptions: [{ name: "nomixupload" }],
    };
    const state = {
      kind: "stale",
      marker: marker({ routeId: "stale-route", configuration: alternateConfiguration }),
    };
    const container = containerWithResponses(
      inspectionProcess(state, { kind: "gatewayUnreachable", detail: "host did not resolve" }),
    );

    await expect(
      new S3Mounts(container, gatewayBinding().factory).inspect("/mnt/models"),
    ).resolves.toEqual({
      mountPath: "/mnt/models",
      attachment: { status: "stale", configuration: alternateConfiguration },
      gateway: { status: "unreachable", detail: "host did not resolve" },
    });
  });

  it("treats absent unmount as an idempotent one-process success", async () => {
    const container = containerWithResponses(
      interactiveCommandProcess(response(null)),
      interactiveCommandProcess(response(null)),
    );
    const mounts = new S3Mounts(container, gatewayBinding().factory);

    await mounts.unmount("/mnt/models");
    await mounts.unmount("/mnt/models");

    expect(container.exec).toHaveBeenCalledTimes(2);
    expect(container.interceptOutboundHttp).not.toHaveBeenCalled();
  });

  it("reports a busy normal unmount without forcing it", async () => {
    const gateway = gatewayBinding();
    const process = interactiveCommandProcess([
      ...response({ kind: "route", routeId: "route-123" }),
      ...errorFrames("busy", "normal unmount reported a busy mount"),
    ]);
    const container = containerWithResponses(process);

    const error = await new S3Mounts(container, gateway.factory)
      .unmount("/mnt/models")
      .catch((cause: unknown) => cause);

    expect(SandboxS3MountError.is(error)).toBe(true);
    expect(error).toMatchObject({
      code: "S3_MOUNT_BUSY",
      operation: "unmount",
      path: "/mnt/models",
    });
    expect(container.interceptOutboundHttp).toHaveBeenCalledWith(
      "s3-route-123.sandbox.internal",
      gateway.fetcher,
    );
    expect(gateway.factory).toHaveBeenCalledWith({
      props: {
        protocolVersion: 1,
        mode: "deny",
        routeId: "route-123",
      },
    });
    expect(container.exec).toHaveBeenCalledOnce();
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("denies a shadowed marker route before reporting the conflict", async () => {
    const writes: Uint8Array[] = [];
    const process = interactiveCommandProcess(
      [
        ...response({ kind: "route", routeId: "shadowed-route" }),
        ...errorFrames("conflict", "an unmanaged filesystem occupies the mount path"),
      ],
      (chunk) => writes.push(chunk),
    );
    const container = containerWithResponses(process);
    const gateway = gatewayBinding();

    const error = await new S3Mounts(container, gateway.factory)
      .unmount("/mnt/models")
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "S3_MOUNT_CONFLICT", operation: "unmount" });
    expect(container.interceptOutboundHttp).toHaveBeenCalledWith(
      "s3-shadowed-route.sandbox.internal",
      gateway.fetcher,
    );
    expect(writes).toEqual([new Uint8Array([1])]);
    expect(container.exec).toHaveBeenCalledOnce();
  });

  it("leaves the guest mount untouched when route revocation fails", async () => {
    const failure = new Error("route update failed");
    const process = routeProcess("route-123");
    const container = containerWithResponses(process);
    container.interceptOutboundHttp.mockRejectedValue(failure);

    await expect(
      new S3Mounts(container, gatewayBinding().factory).unmount("/mnt/models"),
    ).rejects.toBe(failure);

    expect(container.exec).toHaveBeenCalledOnce();
    expect(container.interceptOutboundHttp).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledWith(9);
  });

  it("starts concurrent guest mutations and leaves serialization to the shim lock", async () => {
    const first = deferred<ExecProcess>();
    const second = deferred<ExecProcess>();
    const container = {
      exec: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
      interceptOutboundHttp: vi.fn().mockResolvedValue(undefined),
    };
    const mounts = new S3Mounts(container, gatewayBinding().factory);

    const firstUnmount = mounts.unmount("/mnt/models");
    const secondUnmount = mounts.unmount("/mnt/models");
    await Promise.resolve();
    expect(container.exec).toHaveBeenCalledTimes(2);

    first.resolve(interactiveCommandProcess(response(null)));
    second.resolve(interactiveCommandProcess(response(null)));
    await Promise.all([firstUnmount, secondUnmount]);
  });

  it("applies reserved-path policy only when creating a mount", async () => {
    const container = containerWithResponses(
      inspectionProcess({ kind: "absent" }),
      interactiveCommandProcess(response(null)),
    );
    const mounts = new S3Mounts(container, gatewayBinding().factory);

    await expect(mounts.inspect("/run/sandbox")).resolves.toEqual({
      mountPath: "/run/sandbox",
      attachment: { status: "absent" },
    });
    await expect(mounts.unmount("/run/sandbox")).resolves.toBeUndefined();
    await expect(mounts.mount({ ...request, mountPath: "/run/sandbox" })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(container.exec).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid paths and package-owned s3fs options before entering the Container", async () => {
    const container = containerWithResponses();
    const mounts = new S3Mounts(container, gatewayBinding().factory);

    await expect(mounts.inspect("relative/path")).rejects.toBeInstanceOf(TypeError);
    await expect(
      mounts.mount({ ...request, s3fsOptions: { fsname: "other" } }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      mounts.mount({ ...request, s3fsOptions: { custom: "value,url=http://other" } }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(mounts.mount({ ...request, keyPrefix: "/outside" })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      mounts.mount({
        ...request,
        source: { ...request.source, endpoint: "https://storage.example.test/s3" },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("preserves native exec and route-installation failures", async () => {
    const execError = new Error("Container is not running");
    const execContainer = {
      exec: vi.fn().mockRejectedValue(execError),
      interceptOutboundHttp: vi.fn(),
    };
    await expect(new S3Mounts(execContainer, gatewayBinding().factory).mount(request)).rejects.toBe(
      execError,
    );

    const routeError = new Error("cannot install route");
    const process = routeProcess("route-123");
    const routeContainer = {
      exec: vi.fn().mockResolvedValue(process),
      interceptOutboundHttp: vi.fn().mockRejectedValue(routeError),
    };
    await expect(
      new S3Mounts(routeContainer, gatewayBinding().factory).mount(request),
    ).rejects.toBe(routeError);
    expect(process.kill).toHaveBeenCalledWith(9);
  });

  it("best-effort denies an installed route after a later mount failure", async () => {
    const process = interactiveCommandProcess([
      ...response({ kind: "route", routeId: "route-123" }),
      ...response({ unexpected: true }),
    ]);
    const container = containerWithResponses(process);
    const gateway = gatewayBinding();

    const error = await new S3Mounts(container, gateway.factory)
      .mount(request)
      .catch((cause: unknown) => cause);

    expect(SandboxProtocolError.is(error)).toBe(true);
    expect(container.interceptOutboundHttp).toHaveBeenCalledTimes(2);
    expect(gateway.factory).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ props: expect.objectContaining({ mode: "active" }) }),
    );
    expect(gateway.factory).toHaveBeenNthCalledWith(2, {
      props: {
        protocolVersion: 1,
        mode: "deny",
        routeId: "route-123",
      },
    });
  });

  it("preserves caller cancellation while route installation is pending", async () => {
    const installation = deferred<void>();
    const process = routeProcess("route-123");
    const container = {
      exec: vi.fn().mockResolvedValue(process),
      interceptOutboundHttp: vi
        .fn()
        .mockReturnValueOnce(installation.promise)
        .mockResolvedValue(undefined),
    };
    const gateway = gatewayBinding();
    const controller = new AbortController();
    const reason = new Error("cancel route installation");
    const mounting = new S3Mounts(container, gateway.factory).mount(request, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(container.interceptOutboundHttp).toHaveBeenCalledOnce());

    controller.abort(reason);

    await expect(mounting).rejects.toBe(reason);
    expect(process.kill).toHaveBeenCalledWith(9);
    expect(gateway.factory).toHaveBeenNthCalledWith(2, {
      props: { protocolVersion: 1, mode: "deny", routeId: "route-123" },
    });
    installation.resolve();
    await vi.waitFor(() => expect(container.interceptOutboundHttp).toHaveBeenCalledTimes(3));
    expect(gateway.factory).toHaveBeenNthCalledWith(3, {
      props: { protocolVersion: 1, mode: "deny", routeId: "route-123" },
    });
  });

  it("rejects malformed route IDs before installing interception", async () => {
    const process = interactiveCommandProcess([
      ...response({ kind: "route", routeId: "route-" }),
      ...response(null),
    ]);
    const container = containerWithResponses(process);

    const error = await new S3Mounts(container, gatewayBinding().factory)
      .mount(request)
      .catch((cause: unknown) => cause);

    expect(SandboxProtocolError.is(error)).toBe(true);
    expect(container.interceptOutboundHttp).not.toHaveBeenCalled();
  });

  it("throws SandboxProtocolError for undecodable inspection data", async () => {
    const container = containerWithResponses(commandProcess(response({ attachment: 1 })));

    const error = await new S3Mounts(container, gatewayBinding().factory)
      .inspect("/mnt/models")
      .catch((cause: unknown) => cause);

    expect(SandboxProtocolError.is(error)).toBe(true);
  });
});

describe("SandboxS3MountError", () => {
  it("recognizes errors after their own properties cross an RPC boundary", () => {
    const crossed = Object.assign(new Error("busy"), {
      name: "SandboxS3MountError",
      code: "S3_MOUNT_BUSY",
      operation: "unmount",
      path: "/mnt/models",
      detail: "busy",
    });

    expect(SandboxS3MountError.is(crossed)).toBe(true);
    expect(
      SandboxS3MountError.is({
        name: crossed.name,
        code: crossed.code,
        operation: crossed.operation,
        path: crossed.path,
        detail: crossed.detail,
      }),
    ).toBe(false);
  });
});
