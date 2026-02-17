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

# Run
npm install
npm run dev
```

Open http://localhost:8787 in your browser.

## How It Works

1. **Save a checkpoint** - Click "Save Checkpoint" to snapshot `/workspace`
2. **Do something dangerous** - Try the "Destroy Everything" button
3. **Check it's gone** - Run `ls /workspace` to see the damage
4. **Restore** - Click any checkpoint to go back in time

Under the hood:

- `createBackup()` creates a compressed squashfs archive and uploads to R2
- `restoreBackup()` mounts the archive with FUSE overlayfs (instant, copy-on-write)
- Writes after restore use copy-on-write and don't affect the original backup

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
