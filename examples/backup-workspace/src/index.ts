import {
  type DirectoryBackup,
  type DirectoryBackupGatewayBinding,
  DirectoryBackups,
  SandboxBackupError,
  SandboxFileError,
} from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

export { DirectoryBackupGateway } from "@cloudflare/sandbox";

const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BACKUP_ID_PATTERN = /^[0-9a-f-]{36}$/;
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;
const OPERATION_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_TTL_SECONDS = 3 * 24 * 60 * 60;
const BACKUP_KEY_PREFIX = "backup:";

// Restoring replaces the directory, so backups are limited to directories that hold work.
const BackupDirectory = z
  .string()
  .regex(
    /^\/(workspace|home|tmp|var\/tmp|app)(\/[^/\0]+)*$/,
    "use a directory under /workspace, /home, /tmp, /var/tmp, or /app",
  )
  .refine((path) => !path.split("/").some((part) => part === "." || part === ".."), {
    message: "the directory cannot contain . or .. segments",
  });

const CreateBackupRequest = z.object({
  dir: BackupDirectory,
  name: z.string().max(200).optional(),
  // gitignore patterns, relative to dir. "node_modules/" matches at any depth; "/build" only
  // at the top.
  exclude: z.array(z.string().min(1).max(200)).max(100).optional(),
  gitignore: z.boolean().optional(),
  ttlSeconds: z
    .int()
    .min(60)
    .max(365 * 24 * 60 * 60)
    .default(DEFAULT_TTL_SECONDS),
});
const RestoreRequest = z.object({ dir: BackupDirectory.optional() });
const CommandRequest = z.object({ argv: z.array(z.string()).min(1) });

interface Env {
  SANDBOX: DurableObjectNamespace<BackupSandbox>;
  BACKUPS: R2Bucket;
}

interface BackupSandboxState extends DurableObjectState {
  readonly exports: Cloudflare.Exports & {
    readonly DirectoryBackupGateway: DirectoryBackupGatewayBinding;
  };
}

// The record DirectoryBackups returns, with the expiry this example adds.
interface StoredBackup {
  backup: DirectoryBackup;
  createdAt: string;
  expiresAt: string;
}

export class BackupSandbox extends DurableObject<Env> {
  readonly #container: Container;
  readonly #backups: DirectoryBackups;

  constructor(ctx: BackupSandboxState, env: Env) {
    super(ctx, env);
    this.#container = requireContainer(ctx);
    // Each Durable Object keeps its own records, so every sandbox can share one prefix.
    this.#backups = new DirectoryBackups(this.#container, ctx.exports.DirectoryBackupGateway, {
      binding: "BACKUPS",
      prefix: "backups/",
    });
    // Each Durable Object instance must set its own timeout; it is not inherited.
    if (this.#container.running) {
      void ctx.blockConcurrencyWhile(() =>
        this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
  }

  async createBackup(
    sandboxName: string,
    request: z.infer<typeof CreateBackupRequest>,
  ): Promise<StoredBackup> {
    await this.#ensureExecution(sandboxName);
    const { ttlSeconds, ...options } = request;
    const backup = await withTimeout((signal) => this.#backups.backup({ ...options, signal }));
    const createdAt = new Date();
    const stored: StoredBackup = {
      backup,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlSeconds * 1_000).toISOString(),
    };
    this.ctx.storage.kv.put(BACKUP_KEY_PREFIX + backup.id, stored);
    await this.#scheduleExpiry(new Date(stored.expiresAt));
    return stored;
  }

  listBackups(): StoredBackup[] {
    const entries = this.ctx.storage.kv.list<StoredBackup>({ prefix: BACKUP_KEY_PREFIX });
    return Array.from(entries, ([, stored]) => stored);
  }

  // Replaces the directory, in the running Container or a new one.
  async restoreBackup(sandboxName: string, id: string, dir?: string): Promise<string | null> {
    const stored = this.#find(id);
    if (stored === undefined) return null;
    await this.#ensureExecution(sandboxName);
    await withTimeout((signal) => this.#backups.restore(stored.backup, { dir, signal }));
    return dir ?? stored.backup.dir;
  }

  async deleteBackup(id: string): Promise<boolean> {
    const stored = this.#find(id);
    if (stored === undefined) return false;
    await this.#backups.delete(stored.backup);
    this.ctx.storage.kv.delete(BACKUP_KEY_PREFIX + id);
    return true;
  }

  async run(
    sandboxName: string,
    argv: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.#ensureExecution(sandboxName);
    const process = await withTimeout((signal) =>
      this.#container.exec(argv, { cwd: "/workspace", signal }).then((child) => child.output()),
    );
    const decoder = new TextDecoder();
    return {
      exitCode: process.exitCode,
      stdout: decoder.decode(process.stdout),
      stderr: decoder.decode(process.stderr),
    };
  }

  async resetExecution(): Promise<void> {
    if (this.#container.running) await this.#container.destroy();
  }

  // Deletes expired backups, then waits for the next one to expire.
  override async alarm(): Promise<void> {
    const now = Date.now();
    let next: number | undefined;
    for (const stored of this.listBackups()) {
      const expiresAt = Date.parse(stored.expiresAt);
      if (expiresAt <= now) {
        await this.deleteBackup(stored.backup.id);
        console.log({ event: "backup.expired", id: stored.backup.id });
      } else if (next === undefined || expiresAt < next) {
        next = expiresAt;
      }
    }
    if (next !== undefined) await this.ctx.storage.setAlarm(next);
  }

  #find(id: string): StoredBackup | undefined {
    return this.ctx.storage.kv.get<StoredBackup>(BACKUP_KEY_PREFIX + id);
  }

  async #scheduleExpiry(expiresAt: Date): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || expiresAt.getTime() < current) {
      await this.ctx.storage.setAlarm(expiresAt);
    }
  }

  async #ensureExecution(sandboxName: string): Promise<void> {
    if (this.#container.running) return;
    this.#container.start({
      image: this.#container.images.sandbox,
      instance: "lite",
      enableInternet: false,
      labels: { example: "backup-workspace", sandbox: sandboxName },
    });
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const match =
      /^\/sandboxes\/([^/]+)\/(backups|commands|execution)(?:\/([^/]+))?(?:\/(restore))?$/.exec(
        url.pathname,
      );
    if (match === null) return new Response("Not found", { status: 404 });
    const [, sandboxName, resource, id, action] = match;
    if (!SANDBOX_NAME_PATTERN.test(sandboxName)) {
      return new Response(
        "sandbox name must contain 1-63 lowercase letters, digits, or hyphens and start with a letter or digit",
        { status: 400 },
      );
    }
    if (id !== undefined && (resource !== "backups" || !BACKUP_ID_PATTERN.test(id))) {
      return new Response("Not found", { status: 404 });
    }

    const sandbox = env.SANDBOX.getByName(sandboxName);
    try {
      if (resource === "backups" && id === undefined && request.method === "POST") {
        const backup = CreateBackupRequest.parse(await request.json());
        return Response.json(await sandbox.createBackup(sandboxName, backup), { status: 201 });
      }
      if (resource === "backups" && id === undefined && request.method === "GET") {
        return Response.json(await sandbox.listBackups());
      }
      if (
        resource === "backups" &&
        id !== undefined &&
        action === "restore" &&
        request.method === "POST"
      ) {
        const body = request.headers.get("Content-Length") === "0" ? {} : await request.json();
        const { dir } = RestoreRequest.parse(body);
        const restored = await sandbox.restoreBackup(sandboxName, id, dir);
        if (restored === null) return new Response("Backup not found", { status: 404 });
        return Response.json({ id, dir: restored });
      }
      if (
        resource === "backups" &&
        id !== undefined &&
        action === undefined &&
        request.method === "DELETE"
      ) {
        return (await sandbox.deleteBackup(id))
          ? new Response(null, { status: 204 })
          : new Response("Backup not found", { status: 404 });
      }
      if (resource === "commands" && id === undefined && request.method === "POST") {
        const { argv } = CommandRequest.parse(await request.json());
        return Response.json(await sandbox.run(sandboxName, argv));
      }
      if (resource === "execution" && id === undefined && request.method === "DELETE") {
        await sandbox.resetExecution();
        return new Response(null, { status: 204 });
      }
      return new Response("Method not allowed", { status: 405 });
    } catch (cause) {
      if (cause instanceof z.ZodError) return new Response(z.prettifyError(cause), { status: 400 });
      if (cause instanceof SyntaxError) {
        return new Response("Request body must be JSON", { status: 400 });
      }
      // Errors keep their recognizers across Durable Object RPC.
      if (SandboxFileError.is(cause)) {
        return Response.json({ code: cause.code, path: cause.path }, { status: 422 });
      }
      if (SandboxBackupError.is(cause)) {
        const status = cause.code === "BACKUP_NOT_FOUND" ? 404 : 502;
        return Response.json({ code: cause.code, detail: cause.detail }, { status });
      }
      console.error({
        event: "sandbox.request.failed",
        sandboxName,
        resource,
        error: describeError(cause),
      });
      return new Response("Sandbox request failed", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

// Not AbortSignal.timeout(): it stays armed after the operation ends. Clear the timer instead.
async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), OPERATION_TIMEOUT_MS);
  try {
    return await operation(abort.signal);
  } finally {
    clearTimeout(timer);
  }
}

function requireContainer(ctx: DurableObjectState): Container {
  const container = ctx.container;
  if (container === undefined) throw new Error("Container attachment is unavailable");
  return container;
}

// Structured logs drop an Error's message and stack because they are not enumerable.
function describeError(cause: unknown): string {
  return cause instanceof Error && cause.stack !== undefined ? cause.stack : String(cause);
}
