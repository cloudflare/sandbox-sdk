import { execFile, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { AwsClient } from "aws4fetch";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { S3Gateway, S3Mounts, type S3MountRequest } from "../src/index.js";
import { TestExecutionContext, TestFetcher } from "./worker-test-doubles.js";

const runExecFile = promisify(execFile);
const enabled = process.env.SANDBOX_S3_LIFECYCLE === "1";
const describeLifecycle = enabled ? describe : describe.skip;
const accessKeyId = "release-access-key";
const secretAccessKey = "release-secret-key";
const testId = `${process.pid}-${Date.now()}`;
const toolsImage = `sandbox-tools-lifecycle-test-${testId}`;
const image = `sandbox-s3-lifecycle-test-${testId}`;
const minioImage =
  "minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const socatImage =
  "alpine/socat@sha256:c5a091e1e735a90aa941a5828529dbe6c6157407a8047a9aa473faa133361b82";
const extraCa = process.env.SANDBOX_EXTRA_CA;
const extraCaSecret = extraCa ? ["--secret", `id=extra_ca,src=${extraCa}`] : [];

interface RouteFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface RouteBlock {
  readonly entered: Promise<void>;
  readonly completed: Promise<void>;
  release(): void;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

describeLifecycle("public S3 mount lifecycle", () => {
  const network = `sandbox-s3-${testId}`;
  const minio = `sandbox-minio-${testId}`;
  const proxy = `sandbox-proxy-${testId}`;
  const workspace = `sandbox-workspace-${testId}`;
  const routes = new Map<string, RouteFetcher>();
  let bridge: ReturnType<typeof createServer>;
  let client: AwsClient;
  let container: DockerContainer;
  let endpoint: string;

  beforeAll(async () => {
    await docker([
      "build",
      "--platform",
      "linux/amd64",
      ...extraCaSecret,
      "--target",
      "image",
      "--tag",
      toolsImage,
      "--file",
      "images/sandbox-tools/Dockerfile",
      ".",
    ]);
    await docker([
      "build",
      "--platform",
      "linux/amd64",
      "--tag",
      image,
      "--build-arg",
      `SANDBOX_TOOLS_IMAGE=${toolsImage}`,
      "--file",
      "packages/sandbox/tests/fixtures/s3-lifecycle/Dockerfile",
      ".",
    ]);
    await docker(["network", "create", network]);
    await docker([
      "run",
      "--detach",
      "--name",
      minio,
      "--publish",
      "127.0.0.1::9000",
      "--env",
      `MINIO_ROOT_USER=${accessKeyId}`,
      "--env",
      `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
      minioImage,
      "server",
      "/data",
    ]);
    const port = await publishedPort(minio, 9000);
    endpoint = `http://127.0.0.1:${port}`;
    await waitForMinio(endpoint);
    client = new AwsClient({
      accessKeyId,
      secretAccessKey,
      region: "us-east-1",
      service: "s3",
    });
    const created = await client.fetch(`${endpoint}/models`, { method: "PUT" });
    if (!created.ok)
      throw new Error(`bucket creation failed: ${created.status} ${await created.text()}`);

    bridge = createServer((request, response) => {
      void bridgeRequest(routes, request, response);
    });
    await new Promise<void>((resolve) => bridge.listen(0, "0.0.0.0", resolve));
    const address = bridge.address();
    if (address === null) throw new Error("missing bridge address");
    // SAFETY: The bridge is bound to an IPv4 host and ephemeral TCP port above.
    const bridgePort = (address as AddressInfo).port;

    await docker([
      "run",
      "--detach",
      "--name",
      proxy,
      "--network",
      network,
      "--add-host",
      "host.docker.internal:host-gateway",
      socatImage,
      "-dd",
      "TCP-LISTEN:80,fork,reuseaddr",
      `TCP:host.docker.internal:${bridgePort}`,
    ]);
    const proxyAddress = await containerAddress(proxy, network);
    await docker([
      "run",
      "--detach",
      "--name",
      workspace,
      "--network",
      network,
      "--privileged",
      image,
      "tail",
      "--follow",
      "/dev/null",
    ]);
    container = new DockerContainer(workspace, proxyAddress, routes);
  }, 120_000);

  afterAll(async () => {
    await docker(["rm", "--force", workspace, proxy, minio], false);
    if (bridge !== undefined) await new Promise<void>((resolve) => bridge.close(() => resolve()));
    await docker(["network", "rm", network], false);
    await docker(["image", "rm", "--force", image, toolsImage], false);
  });

  it("mounts, adopts, inspects, denies, retries, and unmounts", async () => {
    const gatewayBinding = (options: {
      readonly props: ConstructorParameters<typeof S3Gateway>[0]["props"];
    }) => {
      const gateway = new S3Gateway(new TestExecutionContext(options.props), {});
      return new GatewayFetcher(gateway);
    };
    const mounts = new S3Mounts(container, gatewayBinding);
    const request = {
      mountPath: "/mnt/models",
      source: {
        type: "s3" as const,
        endpoint,
        bucket: "models",
        region: "us-east-1",
        credentials: { type: "static" as const, accessKeyId, secretAccessKey },
      },
      keyPrefix: "current",
      access: "read-write" as const,
    } satisfies S3MountRequest;

    await mounts.mount(request);
    await container.shell("printf 'release-ready' > /mnt/models/ready.txt");
    expect(await container.shell("cat /mnt/models/ready.txt")).toBe("release-ready");
    await container.shell(
      "dd if=/dev/zero of=/mnt/models/large.bin bs=1M count=30 status=none && " +
        'sync && test "$(stat -c %s /mnt/models/large.bin)" = 31457280 && ' +
        "printf patch | dd of=/mnt/models/large.bin bs=1 seek=1048576 conv=notrunc status=none && " +
        "sync && rm /mnt/models/large.bin && sync",
    );
    expect(await mounts.inspect(request.mountPath)).toMatchObject({
      attachment: { status: "managed", configuration: { keyPrefix: "current/" } },
      fuse: { status: "connected" },
      gateway: { status: "reachable", upstream: { status: "usable" } },
    });

    await mounts.mount(request);
    expect(await container.shell("cat /mnt/models/ready.txt")).toBe("release-ready");
    expect(
      await container.shell(
        "grep -R 'release-secret-key' /run/sandbox /proc/*/cmdline 2>/dev/null || true",
      ),
    ).toBe("");

    await docker([
      "exec",
      "--detach",
      workspace,
      "sh",
      "-c",
      "cd /mnt/models && echo $$ > /tmp/mount-holder.pid && exec tail --follow /dev/null",
    ]);
    await waitForFile(container, "/tmp/mount-holder.pid");
    await expect(mounts.unmount(request.mountPath)).rejects.toMatchObject({
      code: "S3_MOUNT_BUSY",
    });
    expect(await container.fetchLatestRoute()).toMatchObject({ status: 403 });
    const protectedValue = "must-not-be-readable-after-denial";
    const seeded = await client.fetch(`${endpoint}/models/current/after-deny.txt`, {
      method: "PUT",
      body: protectedValue,
    });
    if (!seeded.ok) throw new Error(`object seed failed: ${seeded.status} ${await seeded.text()}`);
    let deniedOutput = "";
    try {
      deniedOutput = await container.shell("cat /mnt/models/after-deny.txt");
    } catch {
      // s3fs may report an error or return empty data for a denied request.
    }
    expect(deniedOutput).not.toContain(protectedValue);
    expect(await mounts.inspect(request.mountPath)).toMatchObject({
      attachment: { status: "managed" },
      fuse: { status: "connected" },
    });

    await mounts.mount(request);
    const restoredValue = "read-through-restored-s3fs-route";
    const restored = await client.fetch(`${endpoint}/models/current/after-restore.txt`, {
      method: "PUT",
      body: restoredValue,
    });
    if (!restored.ok)
      throw new Error(`restored object seed failed: ${restored.status} ${await restored.text()}`);
    expect(await container.shell("cat /mnt/models/after-restore.txt")).toBe(restoredValue);
    await container.shell("kill $(cat /tmp/mount-holder.pid)");
    await waitForProcessExit(container, "/tmp/mount-holder.pid");
    await mounts.unmount(request.mountPath);
    expect(await mounts.inspect(request.mountPath)).toMatchObject({
      attachment: { status: "absent" },
    });
    expect(await container.fetchLatestRoute()).toMatchObject({ status: 403 });

    const block = container.blockNextRoute();
    const controller = new AbortController();
    const reason = new Error("cancel route installation");
    const mounting = mounts.mount(request, { signal: controller.signal });
    await block.entered;
    controller.abort(reason);
    await expect(mounting).rejects.toBe(reason);
    block.release();
    await block.completed;
    await waitForLatestRouteStatus(container, 403);
    expect(
      await mounts.inspect(request.mountPath, { signal: AbortSignal.timeout(5_000) }),
    ).toMatchObject({ attachment: { status: "stale" } });
    await mounts.unmount(request.mountPath);
    expect(await container.fetchLatestRoute()).toMatchObject({ status: 403 });
  }, 90_000);
});

class DockerContainer {
  #latestRouteHost: string | undefined;
  readonly #knownRouteHosts = new Set<string>();
  #routeBlock:
    | {
        readonly entered: () => void;
        readonly released: Promise<void>;
        readonly completed: () => void;
      }
    | undefined;

  constructor(
    readonly name: string,
    readonly proxyAddress: string,
    readonly routes: Map<string, RouteFetcher>,
  ) {}

  async exec(command: string[]): Promise<ExecProcess> {
    const child = spawn("docker", ["exec", "--interactive", this.name, ...command], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    // SAFETY: Node's adapters implement the runtime web-stream contracts used by Workers.
    return {
      stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
      pid: child.pid ?? 0,
      isPty: false,
      exitCode: new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      }),
      output: () => Promise.reject(new Error("DockerContainer.output is not implemented")),
      kill: (signal) => child.kill(signal === 9 ? "SIGKILL" : "SIGTERM"),
      resize: () => undefined,
    } as ExecProcess;
  }

  async interceptOutboundHttp(hostname: string, fetcher: Fetcher): Promise<void> {
    const block = this.#routeBlock;
    this.#routeBlock = undefined;
    block?.entered();
    await block?.released;
    this.routes.set(hostname, fetcher);
    if (!this.#knownRouteHosts.has(hostname)) {
      await docker([
        "exec",
        this.name,
        "sh",
        "-c",
        'echo "$1 $2" >> /etc/hosts',
        "route-host",
        this.proxyAddress,
        hostname,
      ]);
      this.#knownRouteHosts.add(hostname);
    }
    this.#latestRouteHost = hostname;
    block?.completed();
  }

  async shell(script: string): Promise<string> {
    return (await docker(["exec", this.name, "sh", "-c", script])).trim();
  }

  async fetchLatestRoute(): Promise<Response> {
    if (this.#latestRouteHost === undefined) throw new Error("no route installed");
    const fetcher = this.routes.get(this.#latestRouteHost);
    if (fetcher === undefined) throw new Error("latest route missing");
    return fetcher.fetch(
      `http://${this.#latestRouteHost}/models?list-type=2&max-keys=1&prefix=current%2F`,
    );
  }

  blockNextRoute(): RouteBlock {
    const entered = deferred();
    const released = deferred();
    const completed = deferred();
    this.#routeBlock = {
      entered: () => entered.resolve(),
      released: released.promise,
      completed: () => completed.resolve(),
    };
    return {
      entered: entered.promise,
      completed: completed.promise,
      release: () => released.resolve(),
    };
  }
}

class GatewayFetcher extends TestFetcher {
  constructor(readonly gateway: S3Gateway) {
    super();
  }

  override fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.gateway.fetch(new Request(input, init));
  }
}

async function bridgeRequest(
  routes: Map<string, RouteFetcher>,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  try {
    const host = incoming.headers.host?.split(":", 1)[0];
    const fetcher = host === undefined ? undefined : routes.get(host);
    if (fetcher === undefined) {
      outgoing.writeHead(502).end("route missing");
      return;
    }
    const body =
      incoming.method === "GET" || incoming.method === "HEAD"
        ? undefined
        : Readable.toWeb(incoming);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else if (value !== undefined) {
        headers.set(name, value);
      }
    }
    // SAFETY: Node supplies a byte stream, and its fetch requires duplex for streamed bodies.
    const init = {
      method: incoming.method,
      headers,
      body: body as BodyInit,
      duplex: "half",
    } as RequestInit;
    const request = new Request(`http://${host}${incoming.url ?? "/"}`, init);
    const response = await fetcher.fetch(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body === null) {
      outgoing.end();
      return;
    }
    // SAFETY: Response bodies implement the web stream contract expected by Node.
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      outgoing,
    );
  } catch (error) {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end(error instanceof Error ? error.message : "gateway bridge failure");
  }
}

async function docker(args: string[], reject = true): Promise<string> {
  try {
    const result = await runExecFile("docker", args, { maxBuffer: 20 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    if (!reject) return "";
    throw error;
  }
}

async function publishedPort(container: string, port: number): Promise<number> {
  const output = await docker(["port", container, `${port}/tcp`]);
  const match = /^127\.0\.0\.1:(\d+)$/m.exec(output);
  if (match?.[1] === undefined) throw new Error(`cannot determine published port from ${output}`);
  return Number(match[1]);
}

async function containerAddress(container: string, network: string): Promise<string> {
  return (
    await docker([
      "inspect",
      "--format",
      `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
      container,
    ])
  ).trim();
}

async function waitForMinio(endpoint: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${endpoint}/minio/health/ready`)).ok) return;
    } catch {
      // MinIO has not bound its published port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("MinIO did not become ready");
}

async function waitForFile(container: DockerContainer, path: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await container.shell(`test -s ${path} && echo ready || true`)) === "ready") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`file did not appear: ${path}`);
}

async function waitForProcessExit(container: DockerContainer, pidFile: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const running = await container.shell(
      `kill -0 $(cat ${pidFile}) 2>/dev/null && echo yes || true`,
    );
    if (running === "") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process did not exit: ${pidFile}`);
}

async function waitForLatestRouteStatus(
  container: DockerContainer,
  expectedStatus: number,
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if ((await container.fetchLatestRoute()).status === expectedStatus) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`latest route did not reach HTTP ${expectedStatus}`);
}

function deferred(): Deferred {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = () => resolve();
  });
  return { promise, resolve: resolvePromise };
}
