import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { promisify } from "node:util";

import { AwsClient } from "aws4fetch";
import * as z from "zod/mini";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { type ActiveS3GatewayProps } from "../src/s3-mounts/contracts.js";
import { handleS3GatewayRequest } from "../src/s3-mounts/gateway.js";

const run = promisify(execFile);
const addressSchema = z.object({ port: z.number().check(z.int(), z.positive()) });
const MINIO_IMAGE =
  "minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const S3FS_IMAGE =
  "ubuntu:24.04@sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254";
const S3FS_VERSION = "1.93-1build3";
const ACCESS_KEY = "sandbox-integration-access";
const SECRET_KEY = "sandbox-integration-secret";

const containers = new Set<string>();
const servers = new Set<Server>();

interface ObservedRequest {
  readonly method: string;
  readonly path: string;
  readonly queryNames: readonly string[];
  readonly copySource: boolean;
  readonly status: number;
}

afterEach(async () => {
  await Promise.all(
    Array.from(containers, (name) => run("docker", ["rm", "--force", name]).catch(() => undefined)),
  );
  containers.clear();
  await Promise.all(
    Array.from(
      servers,
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

describe.skipIf(process.env.SANDBOX_S3_E2E !== "1")("S3 gateway with MinIO and s3fs", () => {
  it("supports file, copy, and multipart operations within one prefix", async () => {
    const minio = await startMinio();
    const upstream = new AwsClient({
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      region: "us-east-1",
      service: "s3",
      retries: 0,
    });
    await expect(
      upstream.fetch(`${minio.endpoint}/models`, { method: "PUT" }),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      upstream.fetch(`${minio.endpoint}/models/current/seed.txt`, {
        method: "PUT",
        body: "seed-data",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      upstream.fetch(`${minio.endpoint}/models/outside.txt`, {
        method: "PUT",
        body: "outside-data",
      }),
    ).resolves.toMatchObject({ ok: true });

    const props: ActiveS3GatewayProps = {
      protocolVersion: 1,
      mode: "active",
      routeId: "integration",
      source: {
        type: "s3",
        endpoint: minio.endpoint,
        region: "us-east-1",
        bucket: "models",
        credentials: {
          type: "static",
          accessKeyId: ACCESS_KEY,
          secretAccessKey: SECRET_KEY,
        },
      },
      keyPrefix: "current/",
      access: "read-write",
    };
    const observed: ObservedRequest[] = [];
    const gatewayPort = await startGateway(props, observed);

    try {
      await runS3fs(gatewayPort);
    } catch (error) {
      const rejected = observed.filter((request) => request.status === 403);
      throw new Error(`s3fs request rejected: ${JSON.stringify(rejected)}`, { cause: error });
    }

    const result = await upstream.fetch(`${minio.endpoint}/models/current/result.txt`);
    expect(result.status).toBe(200);
    await expect(result.text()).resolves.toBe("gateway-data");
    const outside = await upstream.fetch(`${minio.endpoint}/models/outside.txt`);
    await expect(outside.text()).resolves.toBe("outside-data");
    const large = await upstream.fetch(`${minio.endpoint}/models/current/large.bin`);
    expect(large.status).toBe(404);
    expect(
      observed.some(
        (request) => request.method === "GET" && request.path.replace(/\/$/, "") === "/models",
      ),
    ).toBe(true);
    for (const method of ["HEAD", "GET", "PUT", "DELETE"]) {
      expect(
        observed.some(
          (request) =>
            request.method === method &&
            request.path.startsWith("/models/current/") &&
            request.status !== 403,
        ),
      ).toBe(true);
    }
    expect(observed.some((request) => request.copySource && request.status !== 403)).toBe(true);
    expect(
      observed.some(
        (request) =>
          request.method === "POST" &&
          request.queryNames.join(",") === "uploads" &&
          request.status !== 403,
      ),
    ).toBe(true);
    expect(
      observed.some(
        (request) =>
          request.method === "PUT" &&
          request.queryNames.join(",") === "partNumber,uploadId" &&
          request.status !== 403,
      ),
    ).toBe(true);
    expect(
      observed.some(
        (request) =>
          request.method === "POST" &&
          request.queryNames.join(",") === "uploadId" &&
          request.status !== 403,
      ),
    ).toBe(true);
  }, 180_000);
});

async function startMinio(): Promise<{ endpoint: string }> {
  const name = `sandbox-s3-minio-${crypto.randomUUID()}`;
  containers.add(name);
  await run("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--env",
    `MINIO_ROOT_USER=${ACCESS_KEY}`,
    "--env",
    `MINIO_ROOT_PASSWORD=${SECRET_KEY}`,
    "--publish",
    "127.0.0.1::9000",
    MINIO_IMAGE,
    "server",
    "/data",
  ]);
  const { stdout } = await run("docker", ["port", name, "9000/tcp"]);
  const match = /127\.0\.0\.1:(\d+)/.exec(stdout);
  if (match?.[1] === undefined) throw new Error(`cannot determine MinIO port from ${stdout}`);
  const endpoint = `http://127.0.0.1:${match[1]}`;
  await waitUntilReady(`${endpoint}/minio/health/ready`);
  return { endpoint };
}

async function waitUntilReady(url: string): Promise<void> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      lastStatus = response.status;
      if (response.ok) return;
    } catch {
      // The container may not have bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`MinIO did not become ready; last HTTP status was ${lastStatus}`);
}

async function startGateway(
  props: ActiveS3GatewayProps,
  observed: ObservedRequest[],
): Promise<number> {
  const server = createServer((incoming, outgoing) => {
    void forwardToGateway(incoming, outgoing, props, observed).catch((error: Error) => {
      outgoing.destroy(error);
    });
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = addressSchema.safeParse(server.address());
  if (!address.success) throw new Error("gateway server did not bind a TCP port");
  return address.data.port;
}

async function forwardToGateway(
  incoming: IncomingMessage,
  outgoing: ServerResponse<IncomingMessage>,
  props: ActiveS3GatewayProps,
  observed: ObservedRequest[],
): Promise<void> {
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index];
    const value = incoming.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  const method = incoming.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD" ? undefined : Uint8Array.from(await buffer(incoming));
  const request = new Request(`http://s3-${props.routeId}.sandbox.internal${incoming.url ?? "/"}`, {
    method,
    headers,
    body,
  });
  const response = await handleS3GatewayRequest(request, props);
  const url = new URL(request.url);
  observed.push({
    method,
    path: url.pathname,
    queryNames: Array.from(url.searchParams.keys()).sort(),
    copySource: headers.has("x-amz-copy-source"),
    status: response.status,
  });
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

async function runS3fs(gatewayPort: number): Promise<void> {
  const name = `sandbox-s3fs-${crypto.randomUUID()}`;
  containers.add(name);
  const script = `
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq s3fs=${S3FS_VERSION} >/dev/null
printf 'sandbox-access-key:sandbox-secret-key\\n' >/tmp/passwd-s3fs
chmod 600 /tmp/passwd-s3fs
mkdir -p /mnt/s3
trap 'fusermount -u /mnt/s3 || true' EXIT
s3fs models:/current /mnt/s3 \\
  -o passwd_file=/tmp/passwd-s3fs \\
  -o url=http://host.docker.internal:${gatewayPort} \\
  -o use_path_request_style \\
  -o compat_dir \\
  -o multipart_size=5 \\
  -o nomixupload
test "$(cat /mnt/s3/seed.txt)" = seed-data
test ! -e /mnt/s3/outside.txt
printf gateway-data >/mnt/s3/draft.txt
mv /mnt/s3/draft.txt /mnt/s3/result.txt
test "$(cat /mnt/s3/result.txt)" = gateway-data
mkdir /mnt/s3/empty
rmdir /mnt/s3/empty
dd if=/dev/zero of=/mnt/s3/large.bin bs=1M count=12 status=none
sync
test "$(stat -c %s /mnt/s3/large.bin)" = 12582912
rm /mnt/s3/large.bin
fusermount -u /mnt/s3
trap - EXIT
`;
  await run(
    "docker",
    [
      "run",
      "--rm",
      "--privileged",
      "--name",
      name,
      "--add-host",
      "host.docker.internal:host-gateway",
      S3FS_IMAGE,
      "bash",
      "-lc",
      script,
    ],
    { maxBuffer: 16 * 1_024 * 1_024 },
  );
  containers.delete(name);
}
