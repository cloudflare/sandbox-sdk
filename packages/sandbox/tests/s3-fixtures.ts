// Images and Docker access for the S3 integration tests. Run this file to build or pull the
// images before the tests, so no test downloads anything inside its timeout:
//
//   node packages/sandbox/tests/s3-fixtures.ts
//
// Each built image is tagged with a hash of its Dockerfile, so an image that already exists is
// current and is not built again.
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const runExecFile = promisify(execFile);

/** Ubuntu with `s3fs`, for `linux/amd64` like the shim. */
export const S3FS_IMAGE = fixtureTag("s3fs");
export const MINIO_IMAGE = fixtureTag("minio");
export const SOCAT_IMAGE =
  "alpine/socat@sha256:c5a091e1e735a90aa941a5828529dbe6c6157407a8047a9aa473faa133361b82";

const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

function fixtureTag(name: string): string {
  const dockerfile = readFileSync(join(fixturesDir, name, "Dockerfile"));
  return `sandbox-test-${name}:${createHash("sha256").update(dockerfile).digest("hex").slice(0, 12)}`;
}

/**
 * Runs a Docker command and returns its stdout. A command that runs longer than `timeoutMs` is
 * killed, and the error names it.
 */
export async function docker(args: string[], timeoutMs = 60_000): Promise<string> {
  try {
    const result = await runExecFile("docker", args, {
      maxBuffer: 20 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return result.stdout;
  } catch (error) {
    // execFile's error names the command and includes stderr, but a timeout only sets `killed`.
    if (error instanceof Error && "killed" in error && error.killed === true) {
      throw new Error(`timed out after ${timeoutMs} ms: docker ${args.join(" ")}`, {
        cause: error,
      });
    }
    throw error;
  }
}

function provide(image: string, args: string[]): void {
  const inspected = spawnSync("docker", ["image", "inspect", image], {
    stdio: "ignore",
    timeout: 30_000,
  });
  if (inspected.error !== undefined) {
    throw new Error(`docker image inspect ${image} failed: ${inspected.error.message}`);
  }
  if (inspected.status === 0) {
    console.log(`${image} is present`);
    return;
  }
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    console.log(`docker ${args.join(" ")} (attempt ${attempt} of ${DOWNLOAD_ATTEMPTS})`);
    const result = spawnSync("docker", args, { stdio: "inherit", timeout: DOWNLOAD_TIMEOUT_MS });
    if (result.status === 0) return;
    console.log(
      result.error === undefined
        ? `docker exited with ${result.status ?? result.signal}`
        : `docker failed: ${result.error.message}`,
    );
  }
  throw new Error(`could not provide ${image} after ${DOWNLOAD_ATTEMPTS} attempts`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  provide(S3FS_IMAGE, [
    "build",
    "--platform",
    "linux/amd64",
    "--tag",
    S3FS_IMAGE,
    join(fixturesDir, "s3fs"),
  ]);
  provide(MINIO_IMAGE, ["build", "--tag", MINIO_IMAGE, join(fixturesDir, "minio")]);
  provide(SOCAT_IMAGE, ["pull", SOCAT_IMAGE]);
}
