# Move backups

In 0.12, `createBackup()` wrote a directory to the `BACKUP_BUCKET` R2 bucket as a squashfs archive, and `restoreBackup()` mounted it back. Now the Container writes a `tar` archive, and your Durable Object streams it to an R2 binding and back. [Back up a directory](../back-up-a-directory.md) builds it step by step. The [backup workspace example](../../examples/backup-workspace) is the complete Worker. To save the whole disk instead, use [`snapshotContainer()`](../checkpoint-a-workspace.md).

## 1. Replace `createBackup()` and `restoreBackup()`

Replace each call with the archive and upload from steps [2](../back-up-a-directory.md#2-write-the-archive) and [3](../back-up-a-directory.md#3-upload-it-to-r2) of the how-to, and the restore from [step 4](../back-up-a-directory.md#4-restore). Bind your existing bucket, or a new one, in `wrangler.jsonc`.

Done when a restored directory matches the backup after its Container was reset.

```ts
// 0.12
const backup = await sandbox.createBackup({ dir: "/workspace/app", excludes: ["node_modules"] });
await sandbox.restoreBackup(backup);

// Now, with the example's Durable Object
const result = await sandbox.createBackup(name, {
  dir: "/workspace/app",
  excludes: ["node_modules"],
  gitignore: false,
  ttlSeconds: 259_200,
});
await sandbox.restoreBackup(name, result.backup.id);
```

0.12's `DirectoryBackup` held `id` and `dir`. The example's backup also has `name`, `size`, `createdAt`, and `expiresAt`, stored as R2 custom metadata. The example keys objects by sandbox name. To restore a backup into another sandbox, read the object by its key from that sandbox's Durable Object.

Restoring replaces the directory, as 0.12's mount did. It extracts every file instead of mounting the archive, so it takes longer for large directories.

## 2. Map the options

Done when each 0.12 option you used has a replacement below.

| 0.12 option   | Now                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------- |
| `dir`         | `dir`, limited to the same directories: `/workspace`, `/home`, `/tmp`, `/var/tmp`, `/app`   |
| `name`        | `name`, kept in custom metadata                                                             |
| `excludes`    | `tar --exclude=` patterns. See the note below.                                              |
| `gitignore`   | A file list from `git ls-files`, which applies every `.gitignore` rule and keeps `.git`     |
| `ttl`         | `ttlSeconds`, with the same three-day default. An alarm deletes the backup when it expires. |
| `compression` | `tar -z` writes gzip. For zstd, install `zstd` in the image and use `--zstd`.               |
| `multipart`   | Not needed. The Worker streams one upload of a known length.                                |
| `localBucket` | Not needed. `wrangler dev` simulates the R2 binding locally.                                |

0.12 matched each exclude pattern at any depth, as GNU `tar` does, so the same patterns work. To match only at the top of the directory, write `./build`.

0.12 refused to restore an expired backup but left it in R2. The example deletes it. If you relied on R2 lifecycle rules instead, keep them, and drop the alarm.

## 3. Replace the backup variables

Remove `BACKUP_BUCKET_NAME`, `BACKUP_BUCKET_ENDPOINT`, and the R2 access keys. 0.12 used them to sign upload URLs for the Container. The Worker now uploads through the binding, so the Container never holds bucket credentials. Keep `BACKUP_BUCKET` as a binding name if you like, or rename it.

Done when the Worker deploys without the removed variables.

Replace catches of `BackupCreateError`, `BackupRestoreError`, and the other backup errors. The example returns `{ state: "failed", exitCode, stderr }` when `tar` fails. R2 errors throw from the binding.

## 4. Restore backups made by 0.12

0.12 stored each backup as `backups/<id>/data.sqsh`, with its details in `backups/<id>/meta.json`. To restore one, install `squashfs-tools` in the image, write the archive into the Container, and extract it with `unsquashfs`. `unsquashfs` needs a file, not a stream.

Done when an old backup's files appear in the directory from its `meta.json`.

```ts
const meta = await (
  await env.BACKUP_BUCKET.get(`backups/${id}/meta.json`)
)?.json<{ dir: string }>();
const archive = await env.BACKUP_BUCKET.get(`backups/${id}/data.sqsh`);
await files.writeFile(`/run/${id}.sqsh`, archive.body);
await container.exec([
  "/bin/sh",
  "-c",
  'set -e; rm -rf -- "$1"; unsquashfs -d "$1" "$2"; rm -f -- "$2"',
  "restore",
  meta.dir,
  `/run/${id}.sqsh`,
]);
```

`unsquashfs -d` creates the directory. Removing it first gives the same result as 0.12's restore. Back the directory up again with the new format, so later restores do not need `squashfs-tools`.
