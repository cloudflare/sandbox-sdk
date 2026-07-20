import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
};

type MockRuntime = {
  status: "healthy" | "stopped";
  lastChange: number;
  starts: number;
  requests: string[];
};

async function bucketBytes(value: unknown): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ReadableStream) {
    return new Uint8Array(await new Response(value).arrayBuffer());
  }
  return new TextEncoder().encode(String(value));
}

function createMemoryBucket(): R2Bucket {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key: string, value: unknown) {
      const bytes = await bucketBytes(value);
      objects.set(key, bytes);
      return { key, size: bytes.byteLength };
    },
    async get(key: string) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        key,
        size: bytes.byteLength,
        body: new Response(bytes.buffer as ArrayBuffer).body,
        arrayBuffer: async () => bytes.buffer,
        text: async () => new TextDecoder().decode(bytes),
        json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T
      };
    },
    async head(key: string) {
      const bytes = objects.get(key);
      return bytes ? { key, size: bytes.byteLength } : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list() {
      return {
        objects: [...objects].map(([key, bytes]) => ({
          key,
          size: bytes.byteLength,
          uploaded: new Date()
        })),
        truncated: false
      };
    }
  } as unknown as R2Bucket;
}

type MockContainerMethods = {
  resetMockRuntime(status?: "healthy" | "stopped"): Promise<void>;
  getMockRuntime(): Promise<MockRuntime>;
};

/**
 * This extends the real 0.12.3 Sandbox implementation. Vite aliases only its
 * @cloudflare/containers platform dependency to the minimal boundary in
 * mock-containers.ts because temporary preview accounts cannot create
 * Container applications.
 */
export class Sandbox extends BaseSandbox<Env> {
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, { ...env, BACKUP_BUCKET: createMemoryBucket() } as Env);
  }

  private mock(): MockContainerMethods {
    return this as unknown as MockContainerMethods;
  }

  async runIssue825Reproduction() {
    await this.mock().resetMockRuntime("healthy");

    // The caller observes a running sandbox.
    const stateReadBeforeStop = await this.getState();

    // Sleep/eviction/crash wins the race after that observation.
    await this.stop();
    const stateAfterStop = await this.getState();

    // This is the unmodified SDK 0.12.3 implementation under test.
    const backup = await this.createBackup({
      dir: "/workspace",
      name: `issue-825-${Date.now()}`,
      localBucket: true,
      multipart: false
    });

    const stateAfterBackup = await this.getState();
    const runtime = await this.mock().getMockRuntime();
    const reproduced =
      stateReadBeforeStop.status === "healthy" &&
      stateAfterStop.status === "stopped" &&
      stateAfterBackup.status === "healthy" &&
      runtime.starts === 1 &&
      Boolean(backup.id);

    return {
      reproduced,
      sdkVersion: "@cloudflare/sandbox@0.12.3",
      expected:
        "An already-running-only backup should refuse after the stop and leave the container stopped.",
      observed: reproduced
        ? "The real createBackup() implementation called the startup path once, completed the backup, and changed stopped → healthy."
        : "The expected stopped → startup → healthy sequence was not observed.",
      sequence: {
        stateReadBeforeStop,
        stateAfterStop,
        backup,
        stateAfterBackup,
        startupCalls: runtime.starts,
        containerApiRequests: runtime.requests
      },
      boundaryNote:
        "The SDK code is unmodified; only the unavailable Container runtime and R2 storage boundaries are deterministic in-memory fakes."
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/reproduce") {
      return Response.json(await this.runIssue825Reproduction());
    }
    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/reproduce" && ["GET", "POST"].includes(request.method)) {
      const id = env.Sandbox.idFromName("issue-825");
      return env.Sandbox.get(id).fetch(new Request("https://sandbox/reproduce"));
    }
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
