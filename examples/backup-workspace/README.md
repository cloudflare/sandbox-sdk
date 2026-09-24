# Backup workspace

Deploy this Worker to back up a directory in a named Container to R2, and restore it into the same Container or a new one. Backups can leave out files by pattern or by `.gitignore` rules, and an alarm deletes each backup when its time to live ends. For the walkthrough, see [Back up a directory](../../docs/back-up-a-directory.md).

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
  --data '{"dir":"/workspace/app","name":"before-upgrade","excludes":["node_modules"]}'
```

The response has the backup's `id`, `size`, and `expiresAt`, three days from now. Set `ttlSeconds` to change that.

| Field        | Meaning                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| `dir`        | Directory under `/workspace`, `/home`, `/tmp`, `/var/tmp`, or `/app`                      |
| `excludes`   | GNU tar patterns. `node_modules` matches at any depth. `./build` matches only at the top. |
| `gitignore`  | Leave out files that `.gitignore` rules ignore. Keeps `.git`, so history survives.        |
| `ttlSeconds` | Seconds until the alarm deletes the backup. Default: three days.                          |
| `name`       | A label returned with the backup                                                          |

List backups, then reset the Container, which discards its disk:

```sh
curl "$WORKER_URL/sandboxes/agent-1/backups"
curl --request DELETE "$WORKER_URL/sandboxes/agent-1/execution"
```

Restore the backup into a new Container. Pass `{"dir": "/workspace/other"}` to restore somewhere else:

```sh
curl --request POST "$WORKER_URL/sandboxes/agent-1/backups/$BACKUP_ID/restore"
```

Restoring replaces the directory: files that are not in the backup are removed. `/workspace/app/index.js` is back, and `node_modules` is not. Delete the backup when you no longer need it:

```sh
curl --request DELETE "$WORKER_URL/sandboxes/agent-1/backups/$BACKUP_ID"
```

With `gitignore`, directories that contain no files are left out, because git lists only files.

Authenticate in production. This Worker runs any command, and restores over any directory it accepts.
