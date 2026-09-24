import {
  Files,
  type S3GatewayBinding,
  S3Mounts,
  type S3MountInspection,
  type S3MountRequest,
} from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

export { S3Gateway } from "@cloudflare/sandbox";

const contentPath = "/mnt/models/ready.txt";

interface MountConfiguration {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  keyPrefix: string;
  mountPath: string;
}

interface S3NativeLocalEnv {
  SANDBOX: DurableObjectNamespace<S3NativeLocalSandbox>;
}

interface S3NativeLocalState extends DurableObjectState {
  readonly exports: Cloudflare.Exports & { readonly S3Gateway: S3GatewayBinding };
}

export class S3NativeLocalSandbox extends DurableObject<S3NativeLocalEnv> {
  readonly #container: Container;
  readonly #files: Files;
  readonly #mounts: S3Mounts;

  constructor(ctx: S3NativeLocalState, env: S3NativeLocalEnv) {
    super(ctx, env);
    if (ctx.container === undefined) throw new Error("Container attachment is unavailable");
    this.#container = ctx.container;
    this.#files = new Files(this.#container);
    this.#mounts = new S3Mounts(this.#container, ctx.exports.S3Gateway);
  }

  async mount(configuration: MountConfiguration): Promise<S3MountInspection> {
    this.#ensureRunning();
    await this.#mounts.mount(mountRequest(configuration));
    return this.#mounts.inspect(configuration.mountPath, {
      signal: AbortSignal.timeout(15_000),
    });
  }

  inspect(): Promise<S3MountInspection> {
    return this.#mounts.inspect("/mnt/models", { signal: AbortSignal.timeout(15_000) });
  }

  async writeContent(content: string): Promise<void> {
    await this.#files.writeFile(contentPath, content);
  }

  readContent(): Promise<Response> {
    return this.#files.readFile(contentPath);
  }

  async guestSecrets(): Promise<string> {
    return this.#run(
      "find /run/sandbox -maxdepth 4 -type f -exec cat {} \\; 2>/dev/null || true; " +
        'for path in /proc/[0-9]*/cmdline; do tr "\\000" " " < "$path" 2>/dev/null; ' +
        "printf '\\n'; done",
    );
  }

  mountInfo(): Promise<string> {
    return this.#run("grep -F ' /mnt/models ' /proc/self/mountinfo || true");
  }

  unmount(): Promise<void> {
    return this.#mounts.unmount("/mnt/models");
  }

  async destroy(): Promise<void> {
    if (this.#container.running) await this.#container.destroy();
  }

  #ensureRunning(): void {
    if (this.#container.running) return;
    this.#container.start({
      image: this.#container.images.sandbox,
      instance: "lite",
      enableInternet: false,
      labels: { test: "s3-native-local" },
    });
  }

  async #run(script: string): Promise<string> {
    const process = await this.#container.exec(["sh", "-c", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await process.output();
    if (output.exitCode !== 0) {
      throw new Error(
        `guest command exited with ${output.exitCode}: ${new TextDecoder().decode(output.stderr)}`,
      );
    }
    return new TextDecoder().decode(output.stdout);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ready");

    const sandbox = env.SANDBOX.getByName("native-local");
    try {
      if (path === "/mount" && request.method === "POST") {
        const configuration = await request.json<MountConfiguration>();
        return Response.json(await sandbox.mount(configuration));
      }
      if (path === "/inspect" && request.method === "GET") {
        return Response.json(await sandbox.inspect());
      }
      if (path === "/content" && request.method === "PUT") {
        await sandbox.writeContent(await request.text());
        return new Response(null, { status: 204 });
      }
      if (path === "/content" && request.method === "GET") {
        return await sandbox.readContent();
      }
      if (path === "/guest-secrets" && request.method === "GET") {
        return new Response(await sandbox.guestSecrets());
      }
      if (path === "/mount-info" && request.method === "GET") {
        return new Response(await sandbox.mountInfo());
      }
      if (path === "/unmount" && request.method === "POST") {
        await sandbox.unmount();
        return new Response(null, { status: 204 });
      }
      if (path === "/destroy" && request.method === "POST") {
        await sandbox.destroy();
        return new Response(null, { status: 204 });
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error({ event: "s3-native-local.failed", path, error });
      return new Response(error instanceof Error ? error.message : "native local test failed", {
        status: 500,
      });
    }
  },
} satisfies ExportedHandler<S3NativeLocalEnv>;

function mountRequest(configuration: MountConfiguration): S3MountRequest {
  return {
    mountPath: configuration.mountPath,
    source: {
      type: "s3",
      endpoint: configuration.endpoint,
      bucket: configuration.bucket,
      region: configuration.region,
      credentials: {
        type: "static",
        accessKeyId: configuration.accessKeyId,
        secretAccessKey: configuration.secretAccessKey,
      },
    },
    keyPrefix: configuration.keyPrefix,
    access: "read-write",
  };
}
