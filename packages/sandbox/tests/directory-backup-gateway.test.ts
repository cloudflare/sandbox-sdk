import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DirectoryBackupGatewayProps } from "../src/directory-backups/contracts.js";
import { DirectoryBackupGateway } from "../src/directory-backups/directory-backup-gateway.js";
import { FixedLengthStreamDouble, R2BucketDouble } from "./r2-bucket-double.js";
import { TestExecutionContext } from "./worker-test-doubles.js";

const KEY = "backups/object.tar.zst";

function gateway(props: DirectoryBackupGatewayProps, bucket: R2BucketDouble) {
  return new DirectoryBackupGateway(new TestExecutionContext(props), { BACKUPS: bucket });
}

function control(bucket: R2BucketDouble) {
  return gateway({ protocolVersion: 1, mode: "control", binding: "BACKUPS", key: KEY }, bucket);
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://backups.sandbox.internal${path}`, init);
}

beforeEach(() => {
  vi.stubGlobal("FixedLengthStream", FixedLengthStreamDouble);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DirectoryBackupGateway", () => {
  it("uploads parts of the granted upload and completes them from control calls", async () => {
    const bucket = new R2BucketDouble();
    const uploadId = await control(bucket).createUpload("nightly");
    const writer = gateway(
      { protocolVersion: 1, mode: "write", binding: "BACKUPS", key: KEY, uploadId },
      bucket,
    );

    const first = await writer.fetch(
      request("/parts/1", { method: "PUT", body: "abc", headers: { "content-length": "3" } }),
    );
    const second = await writer.fetch(
      request("/parts/2", { method: "PUT", body: "de", headers: { "content-length": "2" } }),
    );
    const size = await control(bucket).completeUpload(uploadId, [
      { partNumber: 1, etag: "etag-1" },
      { partNumber: 2, etag: "etag-2" },
    ]);

    expect(await first.json()).toEqual({ etag: "etag-1" });
    expect(second.status).toBe(200);
    expect(size).toBe(5);
    const stored = bucket.objects.get(KEY);
    expect(new TextDecoder().decode(stored?.bytes)).toBe("abcde");
    expect(stored?.options.customMetadata).toEqual({ name: "nightly" });
  });

  it("serves exact byte ranges of the granted object", async () => {
    const bucket = new R2BucketDouble();
    bucket.objects.set(KEY, { bytes: new TextEncoder().encode("0123456789"), options: {} });
    const reader = gateway(
      { protocolVersion: 1, mode: "read", binding: "BACKUPS", key: KEY },
      bucket,
    );

    const middle = await reader.fetch(request("/object", { headers: { range: "bytes=2-5" } }));
    const tail = await reader.fetch(request("/object", { headers: { range: "bytes=8-15" } }));

    expect(middle.status).toBe(206);
    expect(middle.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await middle.text()).toBe("2345");
    expect(tail.headers.get("content-range")).toBe("bytes 8-9/10");
    expect(await tail.text()).toBe("89");
  });

  it("reports a missing object as 404", async () => {
    const reader = gateway(
      { protocolVersion: 1, mode: "read", binding: "BACKUPS", key: KEY },
      new R2BucketDouble(),
    );

    const response = await reader.fetch(request("/object", { headers: { range: "bytes=0-9" } }));

    expect(response.status).toBe(404);
  });

  it("rejects every request its grant does not cover", async () => {
    const bucket = new R2BucketDouble();
    bucket.objects.set(KEY, { bytes: new Uint8Array(4), options: {} });
    const reader = gateway(
      { protocolVersion: 1, mode: "read", binding: "BACKUPS", key: KEY },
      bucket,
    );
    const writer = gateway(
      { protocolVersion: 1, mode: "write", binding: "BACKUPS", key: KEY, uploadId: "upload-9" },
      bucket,
    );
    const denied = gateway({ protocolVersion: 1, mode: "deny" }, bucket);
    const put = () =>
      request("/parts/1", { method: "PUT", body: "x", headers: { "content-length": "1" } });
    const ranged = () => request("/object", { headers: { range: "bytes=0-3" } });

    const statuses = await Promise.all([
      reader.fetch(put()),
      reader.fetch(request("/object")),
      reader.fetch(request("/other-key", { headers: { range: "bytes=0-3" } })),
      writer.fetch(ranged()),
      writer.fetch(request("/parts/0", { method: "PUT", body: "x" })),
      denied.fetch(ranged()),
      control(bucket).fetch(ranged()),
    ]).then((responses) => responses.map((response) => response.status));

    expect(statuses).toEqual([403, 403, 403, 403, 403, 403, 403]);
  });

  it("reports R2 failures on the container route with their message", async () => {
    const writer = gateway(
      { protocolVersion: 1, mode: "write", binding: "BACKUPS", key: KEY, uploadId: "missing" },
      new R2BucketDouble(),
    );

    const response = await writer.fetch(
      request("/parts/1", { method: "PUT", body: "x", headers: { "content-length": "1" } }),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("NoSuchUpload");
  });

  it("refuses control calls without control props, and a binding that is not a bucket", async () => {
    const bucket = new R2BucketDouble();
    const reader = gateway(
      { protocolVersion: 1, mode: "read", binding: "BACKUPS", key: KEY },
      bucket,
    );
    const misbound = new DirectoryBackupGateway(
      new TestExecutionContext<DirectoryBackupGatewayProps>({
        protocolVersion: 1,
        mode: "control",
        binding: "MISSING",
        key: KEY,
      }),
      { BACKUPS: bucket },
    );

    await expect(reader.deleteObject()).rejects.toThrow("require control props");
    await expect(misbound.deleteObject()).rejects.toThrow("env.MISSING is not an R2 bucket");
  });
});
