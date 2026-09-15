import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { handleS3GatewayRequest } from "../src/s3-mounts/gateway.js";
import { type ActiveS3GatewayProps } from "../src/s3-mounts/contracts.js";
import { S3Gateway } from "../src/s3-mounts/s3-gateway.js";
import { TestExecutionContext } from "./worker-test-doubles.js";

type S3GatewayProps = ActiveS3GatewayProps;

const staticProps: ActiveS3GatewayProps = {
  protocolVersion: 1,
  mode: "active",
  routeId: "route-123",
  source: {
    type: "s3",
    endpoint: "https://storage.example.test",
    region: "us-east-1",
    bucket: "models",
    credentials: {
      type: "static",
      accessKeyId: "real-access-key",
      secretAccessKey: "real-secret-key",
      sessionToken: "real-session-token",
    },
  },
  keyPrefix: "current/",
  access: "read-write",
};

afterEach(() => {
  vi.restoreAllMocks();
});

function gatewayRequest(
  path: string,
  init: RequestInit = {},
  props: ActiveS3GatewayProps = staticProps,
): Request {
  return new Request(`http://s3-${props.routeId}.sandbox.internal${path}`, init);
}

function inspectionRequest(props: ActiveS3GatewayProps = staticProps): Request {
  const prefix =
    props.keyPrefix === undefined ? "" : `&prefix=${encodeURIComponent(props.keyPrefix)}`;
  return gatewayRequest(
    `/models?list-type=2&max-keys=1${prefix}`,
    { headers: { "user-agent": "sandbox-shim/1" } },
    props,
  );
}

function inspectionResult(response: Response): string | null {
  return response.headers.get("x-sandbox-s3-inspection-result");
}

describe("S3 gateway", () => {
  it("uses route-scoped loopback props in the Worker entrypoint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    const context = new TestExecutionContext(staticProps);
    const gateway = new S3Gateway(context, {});

    const response = await gateway.fetch(inspectionRequest());

    expect(inspectionResult(response)).toBe("usable");
  });

  it("re-signs the inspection request with Worker-held static credentials", async () => {
    let upstreamRequest: Request | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      upstreamRequest = input instanceof Request ? input : new Request(input);
      return new Response("<ListBucketResult/>");
    });

    const response = await handleS3GatewayRequest(
      new Request(inspectionRequest(), {
        headers: {
          authorization: "AWS4-HMAC-SHA256 Credential=sandbox-access-key/dummy",
          "x-amz-date": "20200101T000000Z",
          "x-amz-security-token": "guest-token",
          "user-agent": "sandbox-shim/1",
        },
      }),
      staticProps,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-sandbox-s3-gateway-version")).toBe("1");
    expect(inspectionResult(response)).toBe("usable");
    expect(upstreamRequest?.url).toBe(
      "https://storage.example.test/models?list-type=2&max-keys=1&prefix=current%2F",
    );
    expect(upstreamRequest?.headers.get("authorization")).toContain("Credential=real-access-key/");
    expect(upstreamRequest?.headers.get("authorization")).not.toContain("sandbox-access-key");
    expect(upstreamRequest?.headers.get("x-amz-security-token")).toBe("real-session-token");
    expect(upstreamRequest?.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
  });

  it("streams ordinary responses through without adding inspection metadata", async () => {
    const upstream = new Response("file contents", {
      headers: { "content-type": "application/octet-stream" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);

    const response = await handleS3GatewayRequest(
      gatewayRequest("/models/current/file.txt"),
      staticProps,
    );

    expect(response).toBe(upstream);
    expect(response.headers.has("x-sandbox-s3-inspection-result")).toBe(false);
    await expect(response.text()).resolves.toBe("file contents");
  });

  it("rejects S3 headers that could expand the mount capability", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const headers = [
      ["x-amz-acl", "public-read"],
      ["x-amz-server-side-encryption-customer-algorithm", "AES256"],
      ["x-amz-object-lock-mode", "COMPLIANCE"],
      ["x-amz-tagging", "retained=true"],
      ["x-amz-storage-class", "GLACIER"],
      ["x-amz-website-redirect-location", "https://example.test"],
    ] as const;

    for (const [name, value] of headers) {
      const response = await handleS3GatewayRequest(
        gatewayRequest("/models/current/file.txt", { method: "PUT", headers: { [name]: value } }),
        staticProps,
      );
      expect(response.status).toBe(403);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards only headers required by supported s3fs operations", async () => {
    let upstreamRequest: Request | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      upstreamRequest = input instanceof Request ? input : new Request(input);
      return new Response(null);
    });

    await handleS3GatewayRequest(
      gatewayRequest("/models/current/destination", {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-amz-copy-source": "/models/current/source",
          "x-amz-metadata-directive": "REPLACE",
          "x-amz-meta-mode": "33188",
          "x-forwarded-for": "198.51.100.1",
        },
      }),
      staticProps,
    );

    expect(upstreamRequest?.headers.get("content-type")).toBe("application/octet-stream");
    expect(upstreamRequest?.headers.get("x-amz-copy-source")).toBe("/models/current/source");
    expect(upstreamRequest?.headers.get("x-amz-metadata-directive")).toBe("REPLACE");
    expect(upstreamRequest?.headers.get("x-amz-meta-mode")).toBe("33188");
    expect(upstreamRequest?.headers.has("x-forwarded-for")).toBe(false);
  });

  it("preserves encoded keys and repeated path separators", async () => {
    let upstreamUrl: string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      upstreamUrl = input instanceof Request ? input.url : String(input);
      return new Response(null, { status: 204 });
    });

    await handleS3GatewayRequest(
      gatewayRequest("/models/current/%CE%94%20data//literal%252F.txt"),
      staticProps,
    );

    expect(upstreamUrl).toBe(
      "https://storage.example.test/models/current/%CE%94%20data//literal%252F.txt",
    );
  });

  it("denies every request after a mount route is revoked", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await handleS3GatewayRequest(gatewayRequest("/models/current/file.txt"), {
      protocolVersion: 1,
      mode: "deny",
      routeId: staticProps.routeId,
    });

    expect(response.status).toBe(403);
    expect(inspectionResult(response)).toBe("rejected-access");
    expect(decodeURIComponent(response.headers.get("x-sandbox-s3-inspection-detail") ?? "")).toBe(
      "mount route has been revoked",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enforces the mounted prefix on paths, listings, and copy sources", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const requests = [
      gatewayRequest("/models/other/file.txt"),
      gatewayRequest("/models?list-type=2&prefix=current-evil%2F"),
      gatewayRequest("/models/current/destination", {
        method: "PUT",
        headers: { "x-amz-copy-source": "/models/other/source" },
      }),
      gatewayRequest("/models/current/destination", {
        method: "PUT",
        headers: { "x-amz-copy-source": "/models/current/source?versionId=one" },
      }),
      gatewayRequest("/models/current/destination", {
        method: "PUT",
        headers: { "x-amz-copy-source-range": "bytes=0-4" },
      }),
    ];

    for (const request of requests) {
      const response = await handleS3GatewayRequest(request, staticProps);
      expect(response.status).toBe(403);
      expect(inspectionResult(response)).toBe("rejected-access");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects DeleteObjects, including mixed prefix queries", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const unscopedProps = { ...staticProps, keyPrefix: undefined };
    const requests = [
      {
        request: gatewayRequest("/models?delete", {
          method: "POST",
          body: "<Delete><Object><Key>current/file.txt</Key></Object></Delete>",
        }),
        props: staticProps,
      },
      {
        request: gatewayRequest("/models?delete&prefix=current%2F", {
          method: "POST",
          body: "<Delete><Object><Key>outside.txt</Key></Object></Delete>",
        }),
        props: staticProps,
      },
      {
        request: gatewayRequest(
          "/models?delete",
          {
            method: "POST",
            body: "<Delete><Object><Key>file.txt</Key></Object></Delete>",
          },
          unscopedProps,
        ),
        props: unscopedProps,
      },
    ];

    for (const { props, request } of requests) {
      const response = await handleS3GatewayRequest(request, props);
      expect(response.status).toBe(403);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows bucket metadata and correctly scoped list operations", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));

    await handleS3GatewayRequest(gatewayRequest("/models", { method: "HEAD" }), staticProps);
    await handleS3GatewayRequest(gatewayRequest("/models?location"), staticProps);
    await handleS3GatewayRequest(
      gatewayRequest("/models?list-type=2&prefix=current%2Fnested%2F"),
      staticProps,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("fails closed for bucket administration and mixed subresources", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const rootProps = { ...staticProps, keyPrefix: undefined };
    const requests = [
      gatewayRequest("/models", { method: "DELETE" }, rootProps),
      gatewayRequest("/models?acl", { method: "PUT" }, rootProps),
      gatewayRequest("/models?policy", {}, rootProps),
      gatewayRequest("/models?acl&prefix=current%2F"),
      gatewayRequest("/models/current/file.txt?acl"),
      gatewayRequest("/models", { method: "OPTIONS" }, rootProps),
      gatewayRequest("/models/current/file.txt", { method: "OPTIONS" }, rootProps),
      gatewayRequest("/models?location=us-east-1", {}, rootProps),
    ];

    for (const request of requests) {
      const response = await handleS3GatewayRequest(request, rootProps);
      expect(response.status).toBe(403);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires directory-scoped list prefixes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const requests = [
      gatewayRequest("/models?prefix=current"),
      gatewayRequest("/models?list-type=2&prefix=current"),
      gatewayRequest("/models?prefix=current%2F&prefix=current%2Fnested%2F"),
    ];

    for (const request of requests) {
      const response = await handleS3GatewayRequest(request, staticProps);
      expect(response.status).toBe(403);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects duplicate and incomplete multipart parameters", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const requests = [
      gatewayRequest("/models/current/file?uploadId=one&uploadId=two", { method: "POST" }),
      gatewayRequest("/models/current/file?partNumber=1&partNumber=2&uploadId=one", {
        method: "PUT",
      }),
      gatewayRequest("/models/current/file?partNumber=1", { method: "PUT" }),
      gatewayRequest("/models/current/file?uploadId=", { method: "DELETE" }),
      gatewayRequest("/models/current/file?uploads=value", { method: "POST" }),
      gatewayRequest("/models/current/file?partNumber=10001&uploadId=one", { method: "PUT" }),
    ];

    for (const request of requests) {
      const response = await handleS3GatewayRequest(request, staticProps);
      expect(response.status).toBe(403);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows only read operation families for read-only mounts", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    const props = { ...staticProps, access: "read-only" as const };
    const allowed = [
      gatewayRequest("/models/current/file", {}, props),
      gatewayRequest("/models/current/file", { method: "HEAD" }, props),
      gatewayRequest("/models?prefix=current%2F", {}, props),
      gatewayRequest("/models?list-type=2&prefix=current%2F", {}, props),
    ];
    const rejected = [
      gatewayRequest("/models/current/file", { method: "PUT", body: "data" }, props),
      gatewayRequest("/models/current/file", { method: "DELETE" }, props),
      gatewayRequest("/models/current/file?uploads", { method: "POST" }, props),
      gatewayRequest(
        "/models/current/file?partNumber=1&uploadId=one",
        {
          method: "PUT",
          body: "data",
        },
        props,
      ),
      gatewayRequest("/models/current/file?uploadId=one", { method: "POST", body: "data" }, props),
      gatewayRequest("/models/current/file?uploadId=one", { method: "DELETE" }, props),
    ];

    for (const request of allowed) {
      await expect(handleS3GatewayRequest(request, props)).resolves.toHaveProperty("status", 200);
    }
    for (const request of rejected) {
      await expect(handleS3GatewayRequest(request, props)).resolves.toHaveProperty("status", 403);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(allowed.length);
  });

  it("rejects aws-chunked payloads instead of forwarding altered framing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const requests = [
      gatewayRequest("/models/current/file", {
        method: "PUT",
        headers: { "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD" },
        body: "framed",
      }),
      gatewayRequest("/models/current/file", {
        method: "PUT",
        headers: { "content-encoding": "gzip, aws-chunked" },
        body: "framed",
      }),
    ];

    for (const request of requests) {
      const response = await handleS3GatewayRequest(request, staticProps);
      expect(response.status).toBe(403);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps inspection failures to the guest diagnostic protocol", async () => {
    const cases = [
      {
        status: 403,
        body: "<Error><Code>SignatureDoesNotMatch</Code></Error>",
        result: "rejected-credentials",
      },
      { status: 403, body: "<Error><Code>AccessDenied</Code></Error>", result: "rejected-access" },
      { status: 404, result: "rejected-not-found" },
      { status: 409, result: "rejected-other" },
      { status: 503, result: "unavailable" },
    ];

    for (const testCase of cases) {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(testCase.body ?? null, { status: testCase.status }),
      );
      const response = await handleS3GatewayRequest(inspectionRequest(), staticProps);
      expect(response.status).toBe(testCase.status);
      expect(inspectionResult(response)).toBe(testCase.result);
    }
  });

  it("classifies inspection transport failures but preserves ordinary ones", async () => {
    const inspectionFailure = new Error("upstream unavailable");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(inspectionFailure);

    const inspection = await handleS3GatewayRequest(inspectionRequest(), staticProps);
    expect(inspection.status).toBe(503);
    expect(inspectionResult(inspection)).toBe("unavailable");

    const ordinaryFailure = new Error("connection reset");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(ordinaryFailure);
    await expect(
      handleS3GatewayRequest(gatewayRequest("/models/current/file.txt"), staticProps),
    ).rejects.toBe(ordinaryFailure);
  });

  it("resolves renewable credentials without exposing them to the guest", async () => {
    const provider = vi.fn().mockResolvedValue(
      Response.json({
        accessKeyId: "renewed-access-key",
        secretAccessKey: "renewed-secret-key",
        sessionToken: "renewed-session-token",
        expiresAt: Date.UTC(2100, 0, 1),
      }),
    );
    const props: S3GatewayProps = {
      ...staticProps,
      source: {
        type: "s3",
        endpoint: "https://storage.example.test/api",
        region: "us-east-1",
        bucket: "models",
        credentials: { type: "provider", fetcher: { fetch: provider } },
      },
    };
    let upstreamRequest: Request | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      upstreamRequest = input instanceof Request ? input : new Request(input);
      return new Response(null);
    });

    const response = await handleS3GatewayRequest(inspectionRequest(props), props);

    expect(inspectionResult(response)).toBe("usable");
    expect(provider).toHaveBeenCalledWith(
      "https://credentials.sandbox.internal/",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(upstreamRequest?.headers.get("authorization")).toContain(
      "Credential=renewed-access-key/",
    );
    expect(upstreamRequest?.headers.get("x-amz-security-token")).toBe("renewed-session-token");
  });

  it("classifies invalid, expired, and failed credential provider responses", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");
    const responses = [
      Response.json({
        accessKeyId: "access",
        secretAccessKey: "secret",
        expiresAt: 0,
      }),
      new Response("not JSON"),
      new Response(null, { status: 503 }),
    ];

    for (const providerResponse of responses) {
      const props: S3GatewayProps = {
        ...staticProps,
        source: {
          type: "s3",
          endpoint: "https://storage.example.test/api",
          region: "us-east-1",
          bucket: "models",
          credentials: {
            type: "provider",
            fetcher: {
              fetch: vi.fn().mockResolvedValue(providerResponse),
            },
          },
        },
      };

      const response = await handleS3GatewayRequest(inspectionRequest(props), props);
      expect(response.status).toBe(503);
      expect(inspectionResult(response)).toBe("gateway-credential-provider");
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("preserves abort reasons while resolving renewable credentials", async () => {
    const provider = vi.fn();
    const props: S3GatewayProps = {
      ...staticProps,
      source: {
        type: "s3",
        endpoint: "https://storage.example.test/api",
        region: "us-east-1",
        bucket: "models",
        credentials: { type: "provider", fetcher: { fetch: provider } },
      },
    };
    const controller = new AbortController();
    const reason = new Error("stop credential resolution");
    controller.abort(reason);

    await expect(
      handleS3GatewayRequest(
        new Request(inspectionRequest(props), { signal: controller.signal }),
        props,
      ),
    ).rejects.toBe(reason);
    expect(provider).not.toHaveBeenCalled();
  });
});
