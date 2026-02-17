# R2 Backup & Restore Benchmark

Benchmarks how quickly a ~692MB directory (34.5k files) can be snapshotted from a Sandbox container to R2 and restored back, comparing different archival, transfer, and filesystem strategies.

## The Problem

The Sandbox SDK's file APIs (`readFile`, `readFileStream`) base64-encode binary data inside JSON/SSE frames. For small files this is invisible, but for large binary transfers (like backing up a 692MB directory), the 33% base64 inflation plus JSON parsing overhead becomes the bottleneck.

## Backup Results

Test directory: the sandbox-sdk repo cloned into the container with `npm install` (~692MB, 34.5k files).

### Production (standard-4: 4 vCPU, 12 GiB RAM, 20 GB disk)

| Strategy               | Total     | Archive | Upload | Size  | Method                                 |
| ---------------------- | --------- | ------- | ------ | ----- | -------------------------------------- |
| **`tar-zst-direct`**   | **10.9s** | 1.7s    | 9.3s   | 211MB | containerFetch raw binary → R2.put     |
| `tar-zst-fast-chunked` | 22.4s     | 1.7s    | 20.1s  | 235MB | split → readFile base64 → R2 multipart |
| `squashfs-zstd`        | 27.5s     | 21.0s   | 6.5s   | 205MB | mksquashfs → containerFetch → R2.put   |
| `tar-direct`           | 29.7s     | 1.4s    | 28.4s  | 704MB | containerFetch raw binary → R2.put     |
| `squashfs-lzo`         | 30.2s     | 20.2s   | 10.1s  | 236MB | mksquashfs → containerFetch → R2.put   |
| `tar-gz-direct`        | 35.4s     | 28.5s   | 7.0s   | 229MB | containerFetch raw binary → R2.put     |
| `tar-*-pipe`           | ❌ OOM    | —       | —      | —     | ~220MB buffer exceeds Worker memory    |

### Local dev (Docker on Apple Silicon)

| Strategy               | Total    | Archive Size | Method                                   |
| ---------------------- | -------- | ------------ | ---------------------------------------- |
| **`tar-zst-pipe`**     | **3.6s** | **212MB**    | **pipe → containerFetch → R2 multipart** |
| `tar-zst-fast-pipe`    | 3.7s     | 236MB        | pipe → containerFetch → R2 multipart     |
| `tar-zst-direct`       | 4.0s     | 212MB        | containerFetch raw binary → R2.put       |
| `tar-zst-fast-direct`  | 4.1s     | 236MB        | containerFetch raw binary → R2.put       |
| `tar-pipe`             | 8.0s     | 704MB        | pipe → containerFetch → R2 multipart     |
| `tar-direct`           | 8.8s     | 704MB        | containerFetch raw binary → R2.put       |
| `tar-zst-fast-chunked` | 16.4s    | 236MB        | split → readFile base64 → R2 multipart   |
| `tar-gz-direct`        | 17.7s    | 229MB        | containerFetch raw binary → R2.put       |

## Restore Results

Restore benchmarks create archives in-container and time extraction. This isolates archive/extract performance from network transfer (which is already benchmarked in backup strategies).

### Production (standard-4: 4 vCPU, 12 GiB RAM, 20 GB disk)

| Strategy                     | Total     | Archive | Extract   | Size    | Method                                             |
| ---------------------------- | --------- | ------- | --------- | ------- | -------------------------------------------------- |
| `restore-tar`                | 15.2s     | 10.4s   | 4.8s      | 704MB   | tar cf → tar xf (uncompressed)                     |
| **`restore-squashfs-mount`** | **20.9s** | 20.9s   | **0.05s** | 205MB   | mksquashfs → mount -t squashfs (**50ms mount!**)   |
| `restore-tar-zst`            | 54.0s     | 1.9s    | 52.2s     | 211MB   | tar+zstd cf → tar+zstd xf                          |
| `restore-tar-zst-pipe`       | 53.8s     | —       | —         | (piped) | tar \| zstd \| zstd -d \| tar xf (single pipeline) |
| `restore-squashfs-extract`   | 72.2s     | 21.5s   | 50.8s     | 205MB   | mksquashfs → unsquashfs                            |
| `restore-tar-gz`             | 82.2s     | 28.3s   | 53.9s     | 229MB   | tar.gz cf → tar.gz xf                              |

### Local dev (Docker on Apple Silicon)

| Strategy                   | Total    | Archive | Extract | Size    | Method                                              |
| -------------------------- | -------- | ------- | ------- | ------- | --------------------------------------------------- |
| **`restore-tar`**          | **1.4s** | 0.5s    | 0.8s    | 704MB   | tar cf → tar xf (uncompressed)                      |
| `restore-tar-zst-pipe`     | 3.4s     | —       | —       | (piped) | tar \| zstd \| zstd -d \| tar xf (single pipeline)  |
| `restore-tar-zst`          | 5.1s     | 1.5s    | 3.6s    | 212MB   | tar+zstd cf → tar+zstd xf                           |
| `restore-tar-gz`           | 21.7s    | 16.1s   | 5.6s    | 229MB   | tar.gz cf → tar.gz xf                               |
| `restore-squashfs-extract` | 25.1s    | 24.3s   | 0.8s    | 205MB   | mksquashfs → unsquashfs                             |
| `restore-squashfs-mount`   | N/A      | —       | —       | —       | Needs CAP_SYS_ADMIN (not available in local Docker) |

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

### Backup

**zstd + containerFetch is the winning combo.** `tar-zst-direct` is the fastest reliable strategy on both local (4.0s) and production (10.9s). zstd compresses 692MB → 211MB in ~1.7s; `containerFetch` streams raw binary with zero base64 overhead.

**base64 is the bottleneck for SDK file APIs.** `readFile` and `readFileStream` both base64-encode binary content — 33% inflation plus encode/decode CPU. Bypassing via `containerFetch` gives a 2x speedup on prod (22.4s chunked vs 10.9s direct).

**Pipe strategies OOM on production.** Collecting ~220MB of streamed chunks into a single typed array for R2 multipart upload exceeds Worker memory limits (`RangeError: Invalid typed array length`). Works locally where memory is unconstrained. Would need true streaming multipart upload to fix.

**R2 multipart requires identical part sizes.** All non-final parts must be exactly the same size, not just above the 5MB minimum. Variable-sized parts cause error 10048.

### Restore

**SquashFS mount is the killer feature on production — 50ms restore.** `mount -t squashfs` makes 205MB of files instantly accessible with zero extraction. The 20.9s total is dominated by `mksquashfs` creation time; the actual mount is 50ms. This requires CAP_SYS_ADMIN, which is available on Cloudflare production but not in local Docker.

**Extraction is I/O-bound on production containers.** tar+zstd extraction takes 52s on prod vs 3.6s locally — a ~14x slowdown. Uncompressed tar extraction (4.8s on prod) is much faster since it avoids decompression CPU. The container's virtual disk I/O is the bottleneck for writes, not CPU.

**Uncompressed tar is fastest for full extraction** on both local (1.4s) and prod (15.2s), but transfers 3x more data. For backup+restore workflows where the archive traverses the network, zstd's smaller size wins overall.

### Local vs Production

| Observation               | Local | Production | Delta                     |
| ------------------------- | ----- | ---------- | ------------------------- |
| tar+zstd archive creation | 1.5s  | 1.7s       | ~1x (CPU-bound, similar)  |
| tar+zstd extraction       | 3.6s  | 52.2s      | ~14x slower (I/O-bound)   |
| Uncompressed tar extract  | 0.8s  | 4.8s       | ~6x slower                |
| R2 upload (211MB)         | 2.5s  | 9.3s       | ~4x slower (network path) |
| squashfs mount            | N/A   | 0.05s      | Only works on prod        |

**OverlayFS enables incremental snapshots.** By backing up only the diff layer, subsequent snapshots after an initial full backup are dramatically smaller and faster. Requires CAP_SYS_ADMIN (production only).

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
