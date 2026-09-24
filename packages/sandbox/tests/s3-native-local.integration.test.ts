import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AwsClient } from "aws4fetch";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const runExecFile = promisify(execFile);
const enabled = process.env.SANDBOX_S3_NATIVE_LOCAL === "1";
const describeNativeLocal = enabled ? describe : describe.skip;
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureConfig = join(
  repositoryRoot,
  "packages/sandbox/tests/fixtures/s3-native-local/wrangler.jsonc",
);
const requiredWorkersSdkCommit = "b6db4e2a5127763e095607e5e62c4c0c5dc492ee";
const requiredWorkerdCommit = "826ca8ac4139b5b872330f968a6a167b48094c92";
const accessKeyId = "native-local-access-key";
const secretAccessKey = "native-local-secret-key";
const bucket = "models";
const keyPrefix = "current";
const mountPath = "/mnt/models";
const content = "native-local-release-ready";
const minioImage =
  "minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const localImagePattern = "cloudflare-dev/s3nativelocalsandbox-sandbox:*";
const testId = `${process.pid}-${Date.now()}`;
const workerName = `sandbox-s3-native-${testId}`;
const minioName = `sandbox-s3-native-minio-${testId}`;

interface NativeMountRequest {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  keyPrefix: string;
  mountPath: string;
}

let wrangler: ChildProcessWithoutNullStreams | undefined;
let wranglerLog = "";
let stateDirectory: string | undefined;
let workerOrigin: string | undefined;
let minioEndpoint: string | undefined;
let minioStarted = false;
let imagesBefore = new Set<string>();
let imagesCaptured = false;

describeNativeLocal("native local S3 mount lifecycle", () => {
  let client: AwsClient;

  beforeAll(async () => {
    try {
      const wranglerPath = requiredEnvironmentPath("SANDBOX_WRANGLER_PATH");
      const workerdPath = requiredEnvironmentPath("MINIFLARE_WORKERD_PATH");
      await verifyToolchain(wranglerPath, workerdPath);
      await buildToolsImage();

      imagesBefore = await localContainerImages();
      imagesCaptured = true;
      await startMinio();
      if (minioEndpoint === undefined) throw new Error("MinIO endpoint was not initialized");
      client = new AwsClient({
        accessKeyId,
        secretAccessKey,
        region: "us-east-1",
        service: "s3",
      });
      const created = await client.fetch(`${minioEndpoint}/${bucket}`, {
        method: "PUT",
        signal: AbortSignal.timeout(5_000),
      });
      if (!created.ok) {
        throw new Error(`bucket creation failed: ${created.status} ${await created.text()}`);
      }

      await startWrangler(wranglerPath, workerdPath);
      await waitForWorker();
    } catch (error) {
      await cleanup();
      throw error;
    }
  }, 300_000);

  afterAll(async () => {
    await cleanup();
  }, 30_000);

  it("mounts, adopts, inspects, and unmounts through native Container APIs", async () => {
    if (minioEndpoint === undefined) throw new Error("MinIO endpoint is unavailable");
    const request: NativeMountRequest = {
      endpoint: minioEndpoint,
      bucket,
      region: "us-east-1",
      accessKeyId,
      secretAccessKey,
      keyPrefix,
      mountPath,
    };

    const mounted: unknown = await (
      await workerRequest("/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      })
    ).json();
    expect(mounted).toMatchObject({
      attachment: { status: "managed", configuration: { keyPrefix: `${keyPrefix}/` } },
      fuse: { status: "connected" },
      gateway: { status: "reachable", upstream: { status: "usable" } },
    });

    await workerRequest("/content", { method: "PUT", body: content });
    expect(await (await workerRequest("/content")).text()).toBe(content);
    const stored = await client.fetch(`${minioEndpoint}/${bucket}/${keyPrefix}/ready.txt`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(stored.ok).toBe(true);
    expect(await stored.text()).toBe(content);

    const adopted: unknown = await (
      await workerRequest("/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      })
    ).json();
    expect(adopted).toMatchObject({
      attachment: { status: "managed" },
      fuse: { status: "connected" },
      gateway: { status: "reachable", upstream: { status: "usable" } },
    });
    expect(await (await workerRequest("/content")).text()).toBe(content);

    const guestSecrets = await (await workerRequest("/guest-secrets")).text();
    expect(guestSecrets).not.toContain(accessKeyId);
    expect(guestSecrets).not.toContain(secretAccessKey);
    expect(await (await workerRequest("/mount-info")).text()).toContain(` ${mountPath} `);

    await workerRequest("/unmount", { method: "POST" });
    const absent: unknown = await (await workerRequest("/inspect")).json();
    expect(absent).toMatchObject({ attachment: { status: "absent" } });
    expect(await (await workerRequest("/mount-info")).text()).toBe("");
  }, 120_000);
});

function requiredEnvironmentPath(name: "MINIFLARE_WORKERD_PATH" | "SANDBOX_WRANGLER_PATH"): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must point to the required local build`);
  }
  return value;
}

async function verifyToolchain(wranglerPath: string, workerdPath: string): Promise<void> {
  await access(wranglerPath, fsConstants.R_OK);
  await access(workerdPath, fsConstants.X_OK);
  await docker(["info"]);

  const workersSdkRoot = await gitRoot(dirname(wranglerPath));
  const workerdRoot = await gitRoot(dirname(workerdPath));
  await requireCommit(workersSdkRoot, requiredWorkersSdkCommit, "workers-sdk");
  await requireCommit(workerdRoot, requiredWorkerdCommit, "workerd");
}

async function gitRoot(path: string): Promise<string> {
  const result = await runExecFile("git", ["-C", path, "rev-parse", "--show-toplevel"]);
  return result.stdout.trim();
}

async function requireCommit(root: string, commit: string, project: string): Promise<void> {
  try {
    await runExecFile("git", ["-C", root, "merge-base", "--is-ancestor", commit, "HEAD"]);
  } catch {
    throw new Error(`${project} HEAD must contain required commit ${commit}`);
  }
}

async function buildToolsImage(): Promise<void> {
  await docker([
    "build",
    "--platform",
    "linux/amd64",
    "--target",
    "image",
    "--tag",
    "sandbox-tools:local",
    "--file",
    "images/sandbox-tools/Dockerfile",
    ".",
  ]);
}

async function startMinio(): Promise<void> {
  await docker([
    "run",
    "--detach",
    "--name",
    minioName,
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
  minioStarted = true;
  const published = await docker(["port", minioName, "9000/tcp"]);
  const match = /^127\.0\.0\.1:(\d+)$/m.exec(published);
  if (match?.[1] === undefined) {
    throw new Error(`cannot determine the MinIO port from ${published}`);
  }
  minioEndpoint = `http://127.0.0.1:${match[1]}`;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if (
        (
          await fetch(`${minioEndpoint}/minio/health/ready`, {
            signal: AbortSignal.timeout(1_000),
          })
        ).ok
      )
        return;
    } catch {
      // MinIO has not bound its published port yet.
    }
    await delay(250);
  }
  throw new Error("MinIO did not become ready");
}

async function startWrangler(wranglerPath: string, workerdPath: string): Promise<void> {
  stateDirectory = await mkdtemp(join(tmpdir(), "sandbox-s3-native-local-"));
  const port = await availablePort();
  workerOrigin = `http://127.0.0.1:${port}`;
  wrangler = spawn(
    process.execPath,
    [
      wranglerPath,
      "dev",
      "--name",
      workerName,
      "--config",
      fixtureConfig,
      "--port",
      String(port),
      "--show-interactive-dev-session=false",
      "--persist-to",
      stateDirectory,
      "--log-level",
      "log",
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        MINIFLARE_WORKERD_PATH: workerdPath,
        WRANGLER_LOG_PATH: join(stateDirectory, "wrangler.log"),
      },
    },
  );
  wrangler.stdin.end();
  wrangler.stdout.on("data", appendWranglerLog);
  wrangler.stderr.on("data", appendWranglerLog);
}

function appendWranglerLog(chunk: Buffer): void {
  wranglerLog = `${wranglerLog}${chunk.toString()}`.slice(-100_000);
}

async function waitForWorker(): Promise<void> {
  const deadline = AbortSignal.timeout(180_000);
  while (!deadline.aborted) {
    if (wrangler?.exitCode !== null) {
      throw new Error(`Wrangler exited before becoming ready\n${wranglerLog}`);
    }
    try {
      const response = await workerRequest("/health", { signal: deadline }, 1_000);
      if (response.ok) return;
    } catch {
      // Wrangler or its Container image is still starting.
    }
    await delay(250);
  }
  throw new Error(`Wrangler did not become ready\n${wranglerLog}`);
}

async function workerRequest(
  path: string,
  init?: RequestInit,
  timeout = 90_000,
): Promise<Response> {
  if (workerOrigin === undefined) throw new Error("Worker origin is unavailable");
  const timeoutSignal = AbortSignal.timeout(timeout);
  const callerSignal = init?.signal ?? undefined;
  const response = await fetch(`${workerOrigin}${path}`, {
    ...init,
    signal:
      callerSignal === undefined ? timeoutSignal : AbortSignal.any([callerSignal, timeoutSignal]),
  });
  if (!response.ok) {
    throw new Error(`Worker ${path} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null) {
    server.close();
    throw new Error("could not allocate a local port");
  }
  // SAFETY: This server was bound to a TCP host and therefore returns an AddressInfo.
  const port = (address as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

async function cleanup(): Promise<void> {
  if (workerOrigin !== undefined && wrangler?.exitCode === null) {
    try {
      await workerRequest("/destroy", { method: "POST" }, 5_000);
    } catch {
      // Container removal below is authoritative cleanup.
    }
  }
  await stopWrangler();

  const containerIds = (
    await docker(["ps", "-aq", "--filter", `name=workerd-${workerName}-`], false)
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (containerIds.length > 0) await docker(["rm", "--force", ...containerIds], false);
  if (minioStarted) await docker(["rm", "--force", minioName], false);
  minioStarted = false;

  if (imagesCaptured) {
    const imagesAfter = await localContainerImages();
    const newImages = [...imagesAfter].filter((image) => !imagesBefore.has(image));
    if (newImages.length > 0) await docker(["image", "rm", "--force", ...newImages], false);
  }
  if (stateDirectory !== undefined) await rm(stateDirectory, { recursive: true, force: true });
}

async function stopWrangler(): Promise<void> {
  const child = wrangler;
  wrangler = undefined;
  if (child === undefined || child.exitCode !== null) return;

  child.kill("SIGTERM");
  const exited = once(child, "exit").then(() => undefined);
  const stopped = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);
  if (stopped || child.exitCode !== null) return;
  child.kill("SIGKILL");
  await exited;
}

async function localContainerImages(): Promise<Set<string>> {
  const output = await docker(
    [
      "images",
      "--format",
      "{{.Repository}}:{{.Tag}}",
      "--filter",
      `reference=${localImagePattern}`,
    ],
    false,
  );
  return new Set(output.trim().split(/\s+/).filter(Boolean));
}

async function docker(args: string[], reject = true): Promise<string> {
  try {
    const result = await runExecFile("docker", args, {
      cwd: repositoryRoot,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 180_000,
    });
    return result.stdout;
  } catch (error) {
    if (!reject) return "";
    throw error;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
