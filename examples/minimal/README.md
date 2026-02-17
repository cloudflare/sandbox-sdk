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
| `squashfs-lz4`         | 13.9s     | 1.8s    | 12.1s  | 292MB | mksquashfs -comp lz4 → containerFetch  |
| `tar-zst-fast-chunked` | 22.4s     | 1.7s    | 20.1s  | 235MB | split → readFile base64 → R2 multipart |
| `tar-zst-fast-direct`  | 22.4s     | 9.3s    | 13.1s  | 235MB | tar + zstd -1 → containerFetch → R2    |
| `squashfs-zstd`        | 29.4s     | 21.6s   | 7.7s   | 205MB | mksquashfs → containerFetch → R2.put   |
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

### Production — Presigned URL (R2 → container direct, standard-4)

These strategies download from R2 via presigned URL directly into the container, bypassing JSRPC entirely. This is the recommended approach for cold-start restoration.

| Strategy                              | Total    | Download | Restore  | Size  | Method                                         |
| ------------------------------------- | -------- | -------- | -------- | ----- | ---------------------------------------------- |
| `presigned-squashfuse-mount`          | **2.2s** | 2.1s     | **40ms** | 205MB | curl R2 → squashfuse (FUSE, no CAP_SYS_ADMIN)  |
| `presigned-squashfs-mount`            | **2.5s** | 2.4s     | **43ms** | 205MB | curl R2 → mount -t squashfs (kernel mount)     |
| **`presigned-squashfs-mount-aria2c`** | **2.5s** | 2.5s     | **34ms** | 205MB | aria2c 4-conn → mount -t squashfs              |
| `presigned-squashfs-lz4-mount`        | 3.0–3.8s | 2.9–3.8s | **32ms** | 292MB | curl R2 → mount squashfs-lz4                   |
| `presigned-squashfs-lz4-mount-aria2c` | 3.0s     | 3.0s     | **35ms** | 292MB | aria2c 4-conn → mount squashfs-lz4             |
| `presigned-tar-zst-pipe`              | 4.7s     | (piped)  | —        | 212MB | curl R2 \| zstd -d \| tar xf                   |
| `presigned-tar-zst1-pipe`             | 5.5s     | (piped)  | —        | 236MB | curl R2 \| zstd -d \| tar xf (zstd -1 archive) |
| `presigned-tar-zst`                   | 48.9s    | 2.1s     | 46.8s    | 212MB | curl R2 → tar xf (zstd)                        |
| `presigned-squashfs-extract`          | 51.2s    | 1.9s     | 49.3s    | 205MB | curl R2 → unsquashfs                           |

### Production — In-container only (standard-4)

These strategies create and extract archives within the container (no R2 transfer). Useful for measuring pure archive/extract performance.

| Strategy                   | Total | Archive | Extract | Size    | Method                                             |
| -------------------------- | ----- | ------- | ------- | ------- | -------------------------------------------------- |
| `restore-tar`              | 15.2s | 10.4s   | 4.8s    | 704MB   | tar cf → tar xf (uncompressed)                     |
| `restore-squashfs-mount`   | 20.9s | 20.9s   | 0.05s   | 205MB   | mksquashfs → mount -t squashfs                     |
| `restore-tar-zst`          | 54.0s | 1.9s    | 52.2s   | 211MB   | tar+zstd cf → tar+zstd xf                          |
| `restore-tar-zst-pipe`     | 53.8s | —       | —       | (piped) | tar \| zstd \| zstd -d \| tar xf (single pipeline) |
| `restore-squashfs-extract` | 72.2s | 21.5s   | 50.8s   | 205MB   | mksquashfs → unsquashfs                            |
| `restore-tar-gz`           | 82.2s | 28.3s   | 53.9s   | 229MB   | tar.gz cf → tar.gz xf                              |

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

### Restore: SquashFuse Mount (`presigned-squashfuse-mount`)

Downloads the `.squashfs` image and mounts it via squashfuse (FUSE). Same near-instant mount as kernel squashfs, but runs entirely in userspace — no CAP_SYS_ADMIN required. Requires `/dev/fuse` to be available (confirmed on Cloudflare Firecracker).

### Restore: Presigned URL (`presigned-*`)

The fastest restore approach. The Worker generates a presigned R2 download URL (using `aws4fetch`, pure crypto, no network call) and passes it to the container via `exec()`. The container `curl`s R2 directly — no JSRPC, no Worker proxy, no base64.

```
Worker:    AwsClient.sign(r2Url) → presigned GET URL (0ms, in-memory)
           exec("curl <presigned-url> -o /tmp/snap.squashfs && mount -t squashfs ...")
Container: curl → R2 direct HTTP → disk → mount (70ms)
```

Requires an R2 API token (Access Key ID + Secret Access Key) set as Worker secrets. The presigned URL is valid for 1 hour and scoped to a single object.

## Key Findings

### Backup

**zstd + containerFetch is the winning combo.** `tar-zst-direct` is the fastest reliable strategy on both local (4.0s) and production (10.9s). zstd compresses 692MB → 211MB in ~1.7s; `containerFetch` streams raw binary with zero base64 overhead.

**base64 is the bottleneck for SDK file APIs.** `readFile` and `readFileStream` both base64-encode binary content — 33% inflation plus encode/decode CPU. Bypassing via `containerFetch` gives a 2x speedup on prod (22.4s chunked vs 10.9s direct).

**Pipe strategies OOM on production.** Collecting ~220MB of streamed chunks into a single typed array for R2 multipart upload exceeds Worker memory limits (`RangeError: Invalid typed array length`). Works locally where memory is unconstrained. Would need true streaming multipart upload to fix.

**R2 multipart requires identical part sizes.** All non-final parts must be exactly the same size, not just above the 5MB minimum. Variable-sized parts cause error 10048.

### Restore

**Presigned URL + SquashFS mount = 2.2–2.5s full restore from R2.** The container downloads from R2 via presigned URL (2.1–2.5s for 205MB) then mounts the squashfs image (32–43ms). This is the recommended path for cold-start optimization.

**squashfuse works on Cloudflare Firecracker.** The container runs kernel 6.12 with `/dev/fuse` available (`crw-rw-rw-`). squashfuse provides the same near-instant mount as `mount -t squashfs` but does NOT require CAP_SYS_ADMIN — it runs entirely in userspace via FUSE. This eliminates the need for elevated privileges.

**aria2c parallel downloads provide marginal benefit.** With 4 parallel connections to R2, download speed is similar to single-connection curl (~2.5s for 205MB). R2 download from the same datacenter is already near network-saturated, so parallelism doesn't help much for a single object.

**LZ4 is faster to create but slower to restore.** mksquashfs with LZ4 compression creates images 12x faster than zstd (1.8s vs 21.6s), but the 42% larger file (292MB vs 205MB) makes download slower. Since mount time is negligible (32ms), total restore time is dominated by download, making the smaller zstd image faster end-to-end.

**Presigned URLs bypass all SDK bottlenecks.** By having the container download from R2 directly, data never touches JSRPC, base64 encoding, or Worker memory. The `aws4fetch` presigned URL generation is pure crypto (0ms, no network call).

**Piped curl is competitive for no-mount scenarios.** `presigned-tar-zst-pipe` (curl | zstd -d | tar xf) achieves 4.7s and doesn't require any mount capabilities. Good fallback when neither kernel mount nor FUSE is available.

**Extraction is I/O-bound on production containers.** tar+zstd extraction takes 47-52s on prod vs 3.6s locally — a ~14x slowdown. This makes mount-based restore (which avoids writing 692MB to disk) dramatically faster.

### Recommended Backup + Restore Path

For cold-start optimization, use **SquashFS end-to-end**:

| Phase       | Strategy                     | Time     | What happens                                                           |
| ----------- | ---------------------------- | -------- | ---------------------------------------------------------------------- |
| **Backup**  | `squashfs-zstd`              | ~29s     | mksquashfs → containerFetch GET → R2.put (offline, async)              |
| **Restore** | `presigned-squashfuse-mount` | **2.2s** | Worker generates presigned URL → container curls R2 → squashfuse mount |

The 2.2s is almost entirely network transfer (205MB from R2). The mount itself is 40ms. Backup is slower (~29s vs 11s for tar+zstd) but runs offline — restore speed is what matters for cold starts.

squashfuse is the recommended mount method because it works via FUSE without requiring CAP_SYS_ADMIN. If squashfuse is not installed, `mount -t squashfs` achieves the same speed (2.5s) but requires elevated privileges.

For environments without any mount capability, use `presigned-tar-zst-pipe` (4.7s) as the fallback.

### Local vs Production

| Observation               | Local | Production | Delta                     |
| ------------------------- | ----- | ---------- | ------------------------- |
| tar+zstd archive creation | 1.5s  | 1.7s       | ~1x (CPU-bound, similar)  |
| tar+zstd extraction       | 3.6s  | 52.2s      | ~14x slower (I/O-bound)   |
| Uncompressed tar extract  | 0.8s  | 4.8s       | ~6x slower                |
| R2 upload (211MB)         | 2.5s  | 9.3s       | ~4x slower (network path) |
| R2 download (205MB)       | N/A   | 2.1–2.5s   | Presigned URL, direct     |
| squashfs mount            | N/A   | 0.03–0.07s | Only works on prod        |
| squashfuse (FUSE) mount   | N/A   | 0.04s      | FUSE works on prod        |

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

# Container diagnostics (kernel, filesystems, tools)
curl http://localhost:8787/probe

# Run a single backup
curl http://localhost:8787/backup/tar-zst-direct
curl http://localhost:8787/backup/squashfs-zstd
curl http://localhost:8787/backup/squashfs-lz4

# Run a single restore (requires backup to exist in R2)
curl http://localhost:8787/restore/presigned-squashfs-mount
curl http://localhost:8787/restore/presigned-squashfuse-mount
curl http://localhost:8787/restore/presigned-squashfs-mount-aria2c

# Run all backups
curl http://localhost:8787/backup/all

# Run all restores
curl http://localhost:8787/restore/all

# Run everything (all backups then all restores)
curl http://localhost:8787/benchmark/all
```

## Container Environment

The container runs on Cloudflare Firecracker with kernel 6.12. Key capabilities discovered via the `/probe` endpoint:

- **squashfs** in `/proc/filesystems` — kernel mount works with CAP_SYS_ADMIN
- **FUSE** available — `/dev/fuse` exists (`crw-rw-rw-`), `fuse` + `fusectl` in `/proc/filesystems`
- **OverlayFS** available — in `/proc/filesystems`
- **EROFS** not loaded — `modprobe` not available in the container

## Dockerfile

The custom Dockerfile extends the base sandbox image with:

- `zstd` for compression benchmarks
- `squashfs-tools` for mksquashfs/unsquashfs benchmarks
- `aria2` for parallel download benchmarks
- `squashfuse` for FUSE-based squashfs mounting (no CAP_SYS_ADMIN required)
- A clone of the sandbox-sdk repo with `npm install` as the test directory
- `EXPOSE 8080 8081 8082` for the direct/pipe/restore strategies' Bun servers
