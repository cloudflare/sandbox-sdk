# Time Machine

**Save checkpoints, experiment freely, travel back in time.**

A visual demo of Sandbox SDK's snapshot/restore feature. Create save points like in a video game - run dangerous commands without fear, then restore when needed.

## Features

- Interactive terminal UI
- One-click checkpoint saving
- Instant restore to any checkpoint
- Pre-built "dangerous" command buttons to test recovery

## Quick Start

```bash
# Create the R2 bucket for storing snapshots
wrangler r2 bucket create time-machine-snapshots

# Enable the localBucket flow for local development
cp .dev.vars.example .dev.vars

# Run
npm install
npm run dev
```

Open http://localhost:8787 in your browser.

## Backup Modes

This example supports both backup flows:

- `USE_LOCAL_BUCKET_BACKUPS=true` enables the local-development `localBucket` flow
- `USE_LOCAL_BUCKET_BACKUPS=false` uses the regular production backup flow

`wrangler.jsonc` defaults `USE_LOCAL_BUCKET_BACKUPS` to `false`, so deployed environments keep using the production path.

For local development, copy `.dev.vars.example` to `.dev.vars` to enable `localBucket` by default and showcase the local R2 binding flow.

If you want to test the production-style flow during local development, either delete `.dev.vars` or set:

```dotenv
USE_LOCAL_BUCKET_BACKUPS=false
```

When `USE_LOCAL_BUCKET_BACKUPS=false`, `createBackup()` uses presigned URLs while `wrangler dev` still uses local R2 storage by default. Cloudflare's R2 docs note that local Worker development writes to local storage unless the binding is configured with `"remote": true`, so set `"remote": true` on the `BACKUP_BUCKET` binding if you want local development to exercise the production path against a real R2 bucket.

## How It Works

1. **Save a checkpoint** - Click "Save Checkpoint" to snapshot `/workspace`
2. **Do something dangerous** - Try the "Destroy Everything" button
3. **Check it's gone** - Run `ls /workspace` to see the damage
4. **Restore** - Click any checkpoint to go back in time

Under the hood:

- `createBackup()` always creates the same backup archive structure in R2
- with `USE_LOCAL_BUCKET_BACKUPS=true`, the example calls `createBackup({ localBucket: true })` and restores through the local R2 binding path
- with `USE_LOCAL_BUCKET_BACKUPS=false`, the example uses the regular production backup flow

## Use Cases

- **Tutorial Platforms** - Reset to lesson start if student breaks something
- **AI Coding Agents** - Checkpoint before AI makes changes, restore if wrong
- **Config Testing** - Snapshot before editing configs, restore if broken
- **Dev Environments** - Share a "golden" environment, everyone starts from same state

## API

| Endpoint           | Method | Description                                 |
| ------------------ | ------ | ------------------------------------------- |
| `/api/exec`        | POST   | Run a command. Body: `{ "command": "..." }` |
| `/api/checkpoint`  | POST   | Save checkpoint. Body: `{ "name": "..." }`  |
| `/api/restore`     | POST   | Restore checkpoint. Body: `{ "id": "..." }` |
| `/api/checkpoints` | GET    | List all checkpoints                        |
