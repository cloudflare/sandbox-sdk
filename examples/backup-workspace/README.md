# Backup workspace

Deploy this Worker to back up a directory in a named Container to R2 with `DirectoryBackups`, and restore it into the same Container or a new one. Backups can leave out files by pattern or by `.gitignore` rules, and an alarm deletes each backup when its time to live ends. The archive streams to R2 in parallel parts and never lands on the Container's disk.

Done when a directory restored from R2 matches the backup, after its Container was reset.

Create the bucket, then deploy:

```sh
npx wrangler r2 bucket create sandbox-backup-workspace-example
npm run example:backup-workspace:deploy
```

Make something to back up:

```sh
curl --request POST "$WORKER_URL/sandboxes/agent-1/commands" \
  --header 'Content-Type: application/json' \
  --data '{"argv":["bash","-c","mkdir -p /workspace/app/node_modules/x && echo hi > /workspace/app/index.js && echo dep > /workspace/app/node_modules/x/i.js"]}'
```

Back it up without `node_modules`:

```sh
curl --request POST "$WORKER_URL/sandboxes/agent-1/backups" \
  --header 'Content-Type: application/json' \
  --data '{"dir":"/workspace/app","name":"before-upgrade","exclude":["node_modules/"]}'
```

The response has the backup record under `backup`, with its `id`, `size`, and `sha256`, and an `expiresAt` three days from now. Set `ttlSeconds` to change that.

| Field        | Meaning                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| `dir`        | Directory under `/workspace`, `/home`, `/tmp`, `/var/tmp`, or `/app`                                      |
| `exclude`    | gitignore patterns, relative to `dir`. `node_modules/` matches at any depth; `/build` only at the top.    |
| `gitignore`  | Also leave out what `.gitignore` files and `.git/info/exclude` ignore. Keeps `.git`, so history survives. |
| `ttlSeconds` | Seconds until the alarm deletes the backup. Default: three days.                                          |
| `name`       | A label stored with the backup                                                                            |

List backups, then reset the Container, which discards its disk:

```sh
curl "$WORKER_URL/sandboxes/agent-1/backups"
curl --request DELETE "$WORKER_URL/sandboxes/agent-1/execution"
```

Restore the backup into a new Container. Pass `{"dir": "/workspace/other"}` to restore somewhere else:

```sh
curl --request POST "$WORKER_URL/sandboxes/agent-1/backups/$BACKUP_ID/restore"
```

Restoring replaces the directory: files that are not in the backup are gone. The restore unpacks beside the directory and swaps it in only after the archive checks out, so a failed restore leaves the directory as it was. `/workspace/app/index.js` is back, and `node_modules` is not. Delete the backup when you no longer need it:

```sh
curl --request DELETE "$WORKER_URL/sandboxes/agent-1/backups/$BACKUP_ID"
```

The Worker exports `DirectoryBackupGateway`. The Container reaches R2 only through it, and only for the one object its current operation writes or reads.

Authenticate in production. This Worker runs any command, and restores over any directory it accepts.
