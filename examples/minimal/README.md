# R2 Backup & Restore Benchmark

Benchmarks how quickly a ~692MB directory (34.5k files) can be snapshotted from a Sandbox container to R2 and restored back, comparing different archival, transfer, and filesystem strategies.

## The Problem

The Sandbox SDK's file APIs (`readFile`, `readFileStream`) base64-encode binary data inside JSON/SSE frames. For small files this is invisible, but for large binary transfers (like backing up a 692MB directory), the 33% base64 inflation plus JSON parsing overhead becomes the bottleneck.

## Backup Results

Test directory: the sandbox-sdk repo cloned into the container with `npm install` (~692MB, 34.5k files).

| Strategy               | Total    | Archive Size | Method                                               |
| ---------------------- | -------- | ------------ | ---------------------------------------------------- |
| `tar-zst-fast-chunked` | 16.4s    | 236MB        | split → readFile base64 → R2 multipart               |
| `tar-gz-direct`        | 17.7s    | 229MB        | containerFetch raw binary → R2.put                   |
| `tar-direct`           | 8.8s     | 704MB        | containerFetch raw binary → R2.put                   |
| `tar-zst-direct`       | 4.0s     | 212MB        | containerFetch raw binary → R2.put                   |
| `tar-zst-fast-direct`  | 4.1s     | 236MB        | containerFetch raw binary → R2.put                   |
| `tar-pipe`             | 8.0s     | 704MB        | pipe → containerFetch → R2 multipart                 |
| **`tar-zst-pipe`**     | **3.6s** | **212MB**    | **pipe → containerFetch → R2 multipart**             |
| `tar-zst-fast-pipe`    | 3.7s     | 236MB        | pipe → containerFetch → R2 multipart                 |
| `squashfs-zstd`        | TBD      | TBD          | mksquashfs -comp zstd → containerFetch → R2.put      |
| `squashfs-lzo`         | TBD      | TBD          | mksquashfs -comp lzo → containerFetch → R2.put       |
| `squashfs-gzip`        | TBD      | TBD          | mksquashfs -comp gzip → containerFetch → R2.put      |
| `overlay-tar`          | TBD      | TBD          | overlayfs diff → tar → containerFetch → R2.put       |
| `overlay-tar-zst`      | TBD      | TBD          | overlayfs diff → tar\|zstd → containerFetch → R2.put |

## Restore Results

Restore benchmarks measure R2 → container download + extraction time. Requires corresponding backup to exist in R2 first.

| Strategy                     | Method                                     | Notes                                   |
| ---------------------------- | ------------------------------------------ | --------------------------------------- |
| `restore-tar`                | R2 → container → tar xf                    | Sequential download then extract        |
| `restore-tar-zst`            | R2 → container → tar xf (zstd)             | Sequential download then extract        |
| `restore-tar-gz`             | R2 → container → tar xzf                   | Sequential download then extract        |
| `restore-tar-pipe`           | R2 → pipe into tar xf                      | Download and extract simultaneously     |
| `restore-tar-zst-pipe`       | R2 → pipe into tar xf (zstd)               | Download and extract simultaneously     |
| `restore-tar-pipe-from-pipe` | R2 (pipe backup) → pipe into tar xf (zstd) | Tests pipe backup → pipe restore path   |
| `restore-squashfs-extract`   | R2 → container → unsquashfs                | Full extraction to disk                 |
| `restore-squashfs-mount`     | R2 → container → mount -t squashfs         | Instant mount, read-only, no extraction |

## Strategy Families

### Backup: Chunked (`*-chunked`)

The baseline approach using only standard SDK file APIs.

```
Container: tar + compress → write archive to disk → split into 10MB chunks
Worker:    readFile(chunk, {encoding:'base64'}) → decode → R2 multipart uploadPart
```

Every byte passes through base64 encoding (container-side), JSON serialization, base64 decoding (worker-side). For 236MB of archive data, that's ~315MB of text through JSON parsing. Slow but works with no special setup.

### Backup: Streaming (`*-stream`)

Uses `readFileStream()` + `streamFile()` to avoid loading the entire file into memory at once, but still hits the same base64/SSE overhead since the streaming API encodes binary data identically.

### Backup: Direct (`*-direct`)

Bypasses the SDK's file APIs entirely by starting a Bun HTTP file server inside the container and fetching via `containerFetch()`.

```
Container: tar + compress → write archive to disk → Bun.serve(Bun.file(archive))
Worker:    containerFetch(url, port) → raw binary Response → FixedLengthStream → R2.put
```

Zero base64. Zero SSE. Raw binary over HTTP. The `FixedLengthStream` wrapper provides the `Content-Length` that `R2.put()` requires for stream uploads.

### Backup: Pipe (`*-pipe`)

The fastest tar-based approach. Archives and transfers simultaneously with no intermediate file on disk.

```
Container: Bun.serve → Bun.spawn("tar cf - | zstd") → pipe stdout as Response body
Worker:    containerFetch → collect chunks → R2 multipart upload (fixed-size parts)
```

Archive and transfer overlap, so total time approaches `max(archiveTime, transferTime)` instead of their sum. Uses R2 multipart upload since the stream has no known `Content-Length`.

### Backup: SquashFS (`squashfs-*`)

Uses `mksquashfs` to create a compressed read-only filesystem image instead of a tar archive.

```
Container: mksquashfs /workspace/sandbox-sdk archive.squashfs -comp zstd
Worker:    containerFetch → FixedLengthStream → R2.put
```

SquashFS provides block-level dedup, so identical files are stored once. The image can be mounted directly on restore without extraction (`mount -t squashfs`). Note: `mksquashfs` cannot pipe to stdout, so only the "direct" strategy is available.

### Backup: OverlayFS (`overlay-*`)

Incremental backup strategy. Mounts an overlay filesystem on top of the source directory, simulates changes, then backs up only the diff layer (upper directory).

```
Container: mount -t overlay → simulate changes → tar the upper dir only
Worker:    containerFetch → FixedLengthStream → R2.put
```

The diff layer is much smaller than a full backup — only changed/new files. Ideal for periodic snapshots after an initial full backup.

### Restore: Sequential (`restore-tar-*`)

Downloads the archive from R2 to the container, then extracts.

```
Worker:    R2.get(key) → containerFetch PUT → Bun receive server writes to disk
Container: tar xf archive -C /tmp/restore
```

### Restore: Pipe (`restore-*-pipe`)

Downloads from R2 and extracts simultaneously — the Bun server pipes the incoming PUT body directly into `tar xf`.

```
Worker:    R2.get(key) → containerFetch PUT → Bun pipes stdin to tar process
Container: tar -I 'zstd -d' -xf - (reads from stdin)
```

### Restore: SquashFS Extract (`restore-squashfs-extract`)

Downloads the `.squashfs` image and extracts all files using `unsquashfs`.

### Restore: SquashFS Mount (`restore-squashfs-mount`)

Downloads the `.squashfs` image and mounts it read-only. Near-instant "restore" — files are accessible immediately without extraction. Ideal for read-heavy restore scenarios.

## Key Findings

**base64 is the bottleneck.** The SDK's `readFile` and `readFileStream` both base64-encode binary content. For large files, this adds 33% data inflation plus encode/decode CPU cost. Bypassing this via `containerFetch` to a custom port gives a 4x speedup.

**zstd dominates.** zstd at default level (-3) compresses 692MB → 212MB in ~1.5s. gzip produces a similar size but takes 15s. Uncompressed tar is fast to create but 3x larger to transfer. zstd -1 (fastest) is marginally worse compression for no meaningful speed gain.

**Pipe eliminates sequential overhead.** The direct approach archives to disk (1.5s) then transfers (2.5s) = 4.0s total. The pipe approach overlaps both operations = 3.6s total. The win is modest here but grows with larger directories.

**R2 multipart requires identical part sizes.** All non-final parts must be exactly the same size, not just above the 5MB minimum. Variable-sized parts cause error 10048.

**SquashFS enables instant restore.** While backup speed may be similar to tar+zstd, the `mount -t squashfs` restore is near-instantaneous since files are accessed on-demand from the image. No extraction step needed.

**OverlayFS enables incremental snapshots.** By backing up only the diff layer, subsequent snapshots after an initial full backup are dramatically smaller and faster.

## R2 Binding

The `wrangler.jsonc` includes an R2 bucket binding (`BACKUP_BUCKET`). Create the bucket before running:

```bash
npx wrangler r2 bucket create sandbox-backups
```

## Setup

```bash
npm install
npm run build
npm run dev  # first run builds the Docker image (2-3 min)
```

## Usage

```bash
# List all strategies
curl http://localhost:8787/

# Source directory stats
curl http://localhost:8787/info

# Run a single backup
curl http://localhost:8787/backup/tar-zst-pipe
curl http://localhost:8787/backup/squashfs-zstd
curl http://localhost:8787/backup/overlay-tar-zst

# Run a single restore (requires backup to exist in R2)
curl http://localhost:8787/restore/restore-tar-zst-pipe
curl http://localhost:8787/restore/restore-squashfs-mount

# Run all backups
curl http://localhost:8787/backup/all

# Run all restores
curl http://localhost:8787/restore/all

# Run everything (all backups then all restores)
curl http://localhost:8787/benchmark/all
```

## Dockerfile

The custom Dockerfile extends the base sandbox image with:

- `zstd` for compression benchmarks
- `squashfs-tools` for mksquashfs/unsquashfs benchmarks
- A clone of the sandbox-sdk repo with `npm install` as the test directory
- `EXPOSE 8080 8081 8082` for the direct/pipe/restore strategies' Bun servers
