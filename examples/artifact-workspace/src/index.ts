import {
  Files,
  type S3GatewayBinding,
  S3Mounts,
  SandboxFileError,
  SandboxProtocolError,
  SandboxS3MountError,
  type S3MountInspection,
  type S3MountRequest,
} from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

export { S3Gateway } from "@cloudflare/sandbox";

const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MOUNT_PATH = "/artifacts";
const INPUT_PATH = `${MOUNT_PATH}/input.txt`;
const DIGEST_PATH = `${MOUNT_PATH}/output.sha256`;
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;

interface Env {
  SANDBOX: DurableObjectNamespace<ArtifactSandbox>;
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
}

interface ArtifactSandboxState extends DurableObjectState {
  readonly exports: Cloudflare.Exports & { readonly S3Gateway: S3GatewayBinding };
}

export class ArtifactSandbox extends DurableObject<Env> {
  readonly #container: Container;
  readonly #files: Files;
  readonly #mounts: S3Mounts;

  constructor(ctx: ArtifactSandboxState, env: Env) {
    super(ctx, env);
    this.#container = requireContainer(ctx);
    this.#files = new Files(this.#container);
    this.#mounts = new S3Mounts(this.#container, ctx.exports.S3Gateway);
    // Each Durable Object instance must set its own timeout; it is not inherited.
    if (this.#container.running) {
      void ctx.blockConcurrencyWhile(() =>
        this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
  }

  async writeInput(source: ReadableStream<Uint8Array>, sandboxName: string): Promise<void> {
    await this.#ensureArtifacts(sandboxName);
    await this.#files.writeFile(INPUT_PATH, source);
  }

  async computeDigest(sandboxName: string): Promise<Response> {
    await this.#ensureArtifacts(sandboxName);
    const process = await this.#container.exec(
      ["/bin/sh", "-c", "sha256sum /artifacts/input.txt > /artifacts/output.sha256"],
      { cwd: MOUNT_PATH },
    );
    const output = await process.output();
    if (output.exitCode !== 0) {
      throw new Error(
        `artifact processing exited with ${output.exitCode}: ${new TextDecoder().decode(output.stderr)}`,
      );
    }
    return this.#files.readFile(DIGEST_PATH);
  }

  async readDigest(sandboxName: string): Promise<Response> {
    await this.#ensureArtifacts(sandboxName);
    return this.#files.readFile(DIGEST_PATH);
  }

  async inspectMount(): Promise<S3MountInspection> {
    if (!this.#container.running) {
      return { mountPath: MOUNT_PATH, attachment: { status: "absent" } };
    }
    return this.#mounts.inspect(MOUNT_PATH);
  }

  async unmountArtifacts(): Promise<void> {
    if (!this.#container.running) return;
    await this.#mounts.unmount(MOUNT_PATH);
  }

  async resetExecution(): Promise<void> {
    if (!this.#container.running) return;
    await this.#mounts.unmount(MOUNT_PATH);
    await this.#container.destroy();
  }

  async #ensureArtifacts(sandboxName: string): Promise<void> {
    await this.#ensureExecution(sandboxName);
    await this.#mounts.mount(this.#mountRequest(sandboxName));
  }

  async #ensureExecution(sandboxName: string): Promise<void> {
    if (this.#container.running) return;
    this.#container.start({
      image: this.#container.images.sandbox,
      instance: "lite",
      enableInternet: false,
      labels: { example: "artifact-workspace", sandbox: sandboxName },
    });
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }

  #mountRequest(sandboxName: string): S3MountRequest {
    return {
      mountPath: MOUNT_PATH,
      source: {
        type: "s3",
        endpoint: this.env.S3_ENDPOINT,
        bucket: this.env.S3_BUCKET,
        region: this.env.S3_REGION,
        credentials: {
          type: "static",
          accessKeyId: this.env.S3_ACCESS_KEY_ID,
          secretAccessKey: this.env.S3_SECRET_ACCESS_KEY,
        },
      },
      keyPrefix: `sandboxes/${sandboxName}`,
      access: "read-write",
    };
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/sandboxes\/([^/]+)\/(input|digest|mount|execution)$/.exec(url.pathname);
    if (match === null) return new Response("Not found", { status: 404 });

    const sandboxName = match[1];
    const resource = match[2];
    if (!SANDBOX_NAME_PATTERN.test(sandboxName)) {
      return new Response(
        "sandbox name must contain 1-63 lowercase letters, digits, or hyphens and start with a letter or digit",
        { status: 400 },
      );
    }

    const sandbox = env.SANDBOX.getByName(sandboxName);
    try {
      if (resource === "input" && request.method === "PUT") {
        if (request.body === null) return new Response("Request body is required", { status: 400 });
        await sandbox.writeInput(request.body, sandboxName);
        return new Response(null, { status: 204 });
      }
      if (resource === "digest" && request.method === "POST") {
        return await sandbox.computeDigest(sandboxName);
      }
      if (resource === "digest" && request.method === "GET") {
        return await sandbox.readDigest(sandboxName);
      }
      if (resource === "mount" && request.method === "GET") {
        return Response.json(await sandbox.inspectMount());
      }
      if (resource === "mount" && request.method === "DELETE") {
        await sandbox.unmountArtifacts();
        return new Response(null, { status: 204 });
      }
      if (resource === "execution" && request.method === "DELETE") {
        await sandbox.resetExecution();
        return new Response(null, { status: 204 });
      }
      return new Response("Method not allowed", { status: 405 });
    } catch (cause) {
      console.error({
        event: "sandbox.request.failed",
        sandboxName,
        resource,
        error: describeError(cause),
      });
      return errorResponse(cause);
    }
  },
} satisfies ExportedHandler<Env>;

// Structured logs drop an Error's message and stack because they are not enumerable.
function describeError(cause: unknown): string {
  return cause instanceof Error && cause.stack !== undefined ? cause.stack : String(cause);
}

function requireContainer(ctx: DurableObjectState): Container {
  const container = ctx.container;
  if (container === undefined) throw new Error("Container attachment is unavailable");
  return container;
}

function errorResponse(cause: unknown): Response {
  if (SandboxFileError.is(cause)) {
    if (cause.code === "ENOENT") return new Response("Artifact not found", { status: 404 });
    if (cause.code === "EACCES" || cause.code === "EPERM") {
      return new Response("Artifact permission denied", { status: 403 });
    }
    return new Response("Artifact file operation failed", { status: 500 });
  }
  if (SandboxS3MountError.is(cause)) {
    const conflict = cause.code === "S3_MOUNT_BUSY" || cause.code === "S3_MOUNT_CONFLICT";
    return new Response("Artifact mount operation failed", { status: conflict ? 409 : 500 });
  }
  if (SandboxProtocolError.is(cause)) {
    return new Response("Sandbox protocol failed", { status: 500 });
  }
  return new Response("Artifact processing failed", { status: 500 });
}
