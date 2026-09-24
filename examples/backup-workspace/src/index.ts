import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BACKUP_ID_PATTERN = /^[0-9a-f-]{36}$/;
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_TTL_SECONDS = 3 * 24 * 60 * 60;
// Outside every directory a backup can cover, so an archive never includes itself.
const ARCHIVE_DIRECTORY = "/var/tmp/backups";
const SANDBOX_NAME_KEY = "sandbox-name";

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
  // GNU tar patterns. "node_modules" matches at any depth; "./build" only at the top.
  excludes: z.array(z.string().min(1).max(200)).max(100).default([]),
  // Leave out files that .gitignore rules ignore. Needs git in the image.
  gitignore: z.boolean().default(false),
  ttlSeconds: z
    .int()
    .min(60)
    .max(365 * 24 * 60 * 60)
    .default(DEFAULT_TTL_SECONDS),
});
const RestoreRequest = z.object({ dir: BackupDirectory.optional() });
const CommandRequest = z.object({ argv: z.array(z.string()).min(1) });

// Writes a gzip-compressed tar archive of the directory. The remaining arguments are tar
// options, such as --exclude=node_modules.
const ARCHIVE_SCRIPT = `dir=$1; archive=$2; mode=$3; shift 3
if [ "$mode" = gitignore ]; then
  command -v git >/dev/null || { echo "git is not installed" >&2; exit 3; }
  if git -c safe.directory='*' -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    cd "$dir" || exit 2
    # git lists the files that no .gitignore rule ignores. Keep .git, so history survives.
    { git -c safe.directory='*' ls-files -z --cached --others --exclude-standard
      if [ -d .git ]; then printf '.git\\0'; fi
    } | tar -C "$dir" "$@" --ignore-failed-read --null -T - -czf "$archive"
    exit $?
  fi
fi
exec tar -C "$dir" "$@" -czf "$archive" .`;

// Replaces the directory with the archive read from standard input.
const RESTORE_SCRIPT = `set -e
dir=$1
rm -rf -- "$dir"
mkdir -p -- "$dir"
tar -xzf - -C "$dir"`;

interface Env {
  SANDBOX: DurableObjectNamespace<BackupSandbox>;
  BACKUPS: R2Bucket;
}

interface Backup {
  id: string;
  dir: string;
  name?: string;
  size: number;
  createdAt: string;
  expiresAt: string;
}

// Stored as R2 custom metadata, so every value is a string.
type BackupMetadata = {
  dir: string;
  createdAt: string;
  expiresAt: string;
  name?: string;
};

type CreateBackupResult =
  | { state: "created"; backup: Backup }
  | { state: "failed"; exitCode: number; stderr: string };

type RestoreBackupResult =
  | { state: "restored"; id: string; dir: string }
  | { state: "not-found" }
  | { state: "failed"; exitCode: number; stderr: string };

export class BackupSandbox extends DurableObject<Env> {
  readonly #container: Container;
  readonly #files: Files;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#container = requireContainer(ctx);
    this.#files = new Files(this.#container);
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
  ): Promise<CreateBackupResult> {
    await this.#ensureExecution(sandboxName);
    const id = crypto.randomUUID();
    const archive = `${ARCHIVE_DIRECTORY}/${id}.tar.gz`;
    await this.#files.mkdir(ARCHIVE_DIRECTORY, { recursive: true });
    try {
      const mode = request.gitignore ? "gitignore" : "all";
      const excludes = request.excludes.map((pattern) => `--exclude=${pattern}`);
      const result = await this.#run([
        "/bin/sh",
        "-c",
        ARCHIVE_SCRIPT,
        "archive",
        request.dir,
        archive,
        mode,
        ...excludes,
      ]);
      // tar exits 1 when a file changed while it was read. The archive is still complete.
      if (result.exitCode > 1) return { state: "failed", ...result };

      const { size } = await this.#files.stat(archive);
      const createdAt = new Date();
      const backup: Backup = {
        id,
        dir: request.dir,
        name: request.name,
        size: Number(size),
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + request.ttlSeconds * 1_000).toISOString(),
      };
      const customMetadata: BackupMetadata = {
        dir: backup.dir,
        createdAt: backup.createdAt,
        expiresAt: backup.expiresAt,
      };
      if (backup.name !== undefined) customMetadata.name = backup.name;
      const contents = await this.#files.readFile(archive);
      if (contents.body === null) throw new Error("readFile() returned no body");
      // R2 needs the length of a streamed upload before it starts.
      const { readable, writable } = new FixedLengthStream(size);
      await Promise.all([
        contents.body.pipeTo(writable),
        this.env.BACKUPS.put(objectKey(sandboxName, id), readable, { customMetadata }),
      ]);
      await this.#scheduleExpiry(sandboxName, new Date(backup.expiresAt));
      return { state: "created", backup };
    } finally {
      await this.#files.remove(archive, { force: true });
    }
  }

  async listBackups(sandboxName: string): Promise<Backup[]> {
    const backups: Backup[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.env.BACKUPS.list({
        prefix: `${sandboxName}/`,
        include: ["customMetadata"],
        cursor,
      });
      for (const object of page.objects) backups.push(toBackup(object));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
    return backups;
  }

  // Replaces the directory, in the running Container or a new one.
  async restoreBackup(sandboxName: string, id: string, dir?: string): Promise<RestoreBackupResult> {
    const object = await this.env.BACKUPS.get(objectKey(sandboxName, id));
    if (object === null) return { state: "not-found" };
    const target = dir ?? toBackup(object).dir;
    await this.#ensureExecution(sandboxName);
    const result = await this.#run(
      ["/bin/sh", "-c", RESTORE_SCRIPT, "restore", target],
      object.body,
    );
    if (result.exitCode !== 0) return { state: "failed", ...result };
    return { state: "restored", id, dir: target };
  }

  async deleteBackup(sandboxName: string, id: string): Promise<boolean> {
    const key = objectKey(sandboxName, id);
    if ((await this.env.BACKUPS.head(key)) === null) return false;
    await this.env.BACKUPS.delete(key);
    return true;
  }

  async run(
    sandboxName: string,
    argv: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.#ensureExecution(sandboxName);
    return this.#run(argv);
  }

  async resetExecution(): Promise<void> {
    if (this.#container.running) await this.#container.destroy();
  }

  // Deletes expired backups, then waits for the next one to expire.
  override async alarm(): Promise<void> {
    const sandboxName = this.ctx.storage.kv.get<string>(SANDBOX_NAME_KEY);
    if (sandboxName === undefined) return;
    const now = Date.now();
    let next: number | undefined;
    for (const backup of await this.listBackups(sandboxName)) {
      const expiresAt = Date.parse(backup.expiresAt);
      if (expiresAt <= now) {
        await this.env.BACKUPS.delete(objectKey(sandboxName, backup.id));
        console.log({ event: "backup.expired", sandboxName, id: backup.id });
      } else if (next === undefined || expiresAt < next) {
        next = expiresAt;
      }
    }
    if (next !== undefined) await this.ctx.storage.setAlarm(next);
  }

  async #scheduleExpiry(sandboxName: string, expiresAt: Date): Promise<void> {
    this.ctx.storage.kv.put(SANDBOX_NAME_KEY, sandboxName);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || expiresAt.getTime() < current) {
      await this.ctx.storage.setAlarm(expiresAt);
    }
  }

  async #run(
    argv: string[],
    stdin?: ReadableStream<Uint8Array>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    // Not AbortSignal.timeout(): it stays armed after the command exits, and signalling an
    // exited process logs an internal error. Clear the timer instead.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), COMMAND_TIMEOUT_MS);
    try {
      const options: ContainerExecOptions = { cwd: "/workspace", signal: abort.signal };
      if (stdin !== undefined) options.stdin = stdin;
      const process = await this.#container.exec(argv, options);
      const output = await process.output();
      const decoder = new TextDecoder();
      return {
        exitCode: output.exitCode,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
      };
    } finally {
      clearTimeout(timer);
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
        const result = await sandbox.createBackup(
          sandboxName,
          CreateBackupRequest.parse(await request.json()),
        );
        if (result.state === "failed") return Response.json(result, { status: 422 });
        return Response.json(result.backup, { status: 201 });
      }
      if (resource === "backups" && id === undefined && request.method === "GET") {
        return Response.json(await sandbox.listBackups(sandboxName));
      }
      if (
        resource === "backups" &&
        id !== undefined &&
        action === "restore" &&
        request.method === "POST"
      ) {
        const body = request.headers.get("Content-Length") === "0" ? {} : await request.json();
        const { dir } = RestoreRequest.parse(body);
        const result = await sandbox.restoreBackup(sandboxName, id, dir);
        if (result.state === "not-found") return new Response("Backup not found", { status: 404 });
        return Response.json(result, { status: result.state === "failed" ? 422 : 200 });
      }
      if (
        resource === "backups" &&
        id !== undefined &&
        action === undefined &&
        request.method === "DELETE"
      ) {
        return (await sandbox.deleteBackup(sandboxName, id))
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
      if (cause instanceof SyntaxError)
        return new Response("Request body must be JSON", { status: 400 });
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

function objectKey(sandboxName: string, id: string): string {
  return `${sandboxName}/${id}.tar.gz`;
}

function toBackup(object: R2Object): Backup {
  const metadata = object.customMetadata ?? {};
  const id = object.key.slice(object.key.indexOf("/") + 1, -".tar.gz".length);
  return {
    id,
    dir: metadata.dir ?? "",
    name: metadata.name,
    size: object.size,
    createdAt: metadata.createdAt ?? object.uploaded.toISOString(),
    expiresAt: metadata.expiresAt ?? "",
  };
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
