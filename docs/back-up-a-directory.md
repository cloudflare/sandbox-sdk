# Back up a directory

Save one directory from a Container to R2, leaving out files you do not need, and restore it into a running or new Container. Done when a directory restored from R2 matches the backup after its Container was reset.

A shell script in the Container writes a compressed `tar` archive. The Durable Object streams it to an R2 binding and records when it expires. To restore, the Durable Object streams the object back into `tar`. The [backup workspace example](../examples/backup-workspace) is the complete Worker. To save the whole disk instead, see [Checkpoint a workspace](checkpoint-a-workspace.md).

## 1. Build the image and bind a bucket

Add `sandbox-shim` for `Files`, and `git` if backups should follow `.gitignore` rules. Debian includes GNU `tar`. Bind an R2 bucket to the Worker.

Done when `wrangler deploy` lists the `BACKUPS` binding.

```jsonc
"r2_buckets": [{ "binding": "BACKUPS", "bucket_name": "sandbox-backup-workspace-example" }]
```

## 2. Write the archive

Run `tar` with `exec()`, writing to a path outside every directory you back up, so the archive never includes itself. Pass each exclude pattern as its own `--exclude=` argument, not through a shell string.

Done when `tar -tzf` on the archive lists the files you expect.

```ts
const excludes = request.excludes.map((pattern) => `--exclude=${pattern}`);
await container.exec(["tar", "-C", dir, ...excludes, "-czf", archive, "."]);
```

GNU `tar` matches a pattern such as `node_modules` or `*.log` at any depth, and `./build` only at the top of the directory. Exit code `1` means a file changed while `tar` read it. The archive is still complete.

To follow `.gitignore` rules, let git list the files, and add `.git` so history survives. git applies every rule, including `!` exceptions and `.gitignore` files in subdirectories. Directories with no files are left out, because git lists only files.

```sh
cd "$dir"
{ git ls-files -z --cached --others --exclude-standard; [ -d .git ] && printf '.git\0'; } |
  tar -C "$dir" --ignore-failed-read --null -T - -czf "$archive"
```

Put `--exclude=` options before `-T`, or `tar` ignores them.

## 3. Upload it to R2

R2 needs the length of a streamed upload before it starts. Read the size with `files.stat()`, then pipe the archive through a `FixedLengthStream`.

Done when the object appears in the bucket with the archive's size.

```ts
const { size } = await files.stat(archive);
const contents = await files.readFile(archive);
const { readable, writable } = new FixedLengthStream(size);
await Promise.all([
  contents.body.pipeTo(writable),
  env.BACKUPS.put(`${sandboxName}/${id}.tar.gz`, readable, { customMetadata }),
]);
await files.remove(archive, { force: true });
```

Keep the directory, a name, and the expiry time in `customMetadata`, so listing the bucket describes each backup without a separate index.

## 4. Restore

Get the object and pass its body to `tar` as standard input. The example removes the directory first, so the result matches the backup exactly. It works in a running Container or a new one.

Done when a restored directory matches the backup after `DELETE .../execution`.

```ts
const object = await env.BACKUPS.get(key);
await container.exec(
  ["/bin/sh", "-c", 'set -e; rm -rf -- "$1"; mkdir -p -- "$1"; tar -xzf - -C "$1"', "restore", dir],
  { stdin: object.body },
);
```

Validate the directory before restoring over it. The example accepts only directories under `/workspace`, `/home`, `/tmp`, `/var/tmp`, and `/app`, without `.` or `..` segments.

## 5. Delete expired backups

Store each backup's expiry time, and set a Durable Object alarm for the earliest one. The alarm deletes expired objects, then sets itself for the next.

Done when a backup with a short time to live disappears from the list after it expires.

```ts
override async alarm() {
  let next: number | undefined;
  for (const backup of await this.listBackups(sandboxName)) {
    const expiresAt = Date.parse(backup.expiresAt);
    if (expiresAt <= Date.now()) await this.env.BACKUPS.delete(objectKey(sandboxName, backup.id));
    else if (next === undefined || expiresAt < next) next = expiresAt;
  }
  if (next !== undefined) await this.ctx.storage.setAlarm(next);
}
```

A Durable Object has one alarm. If it already uses one, merge the expiry check into it. To expire every backup after the same age instead, add an [R2 lifecycle rule](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) to the bucket.

## Before production

- Authenticate every request. Restoring replaces a directory with whatever the backup holds.
- The restore runs as `root`, so `tar` restores file modes and ownership as the backup recorded them.
- The archive takes disk space in the Container until the upload finishes. Large directories need a Container with room for both.
- Use a separate prefix or bucket for each tenant.
