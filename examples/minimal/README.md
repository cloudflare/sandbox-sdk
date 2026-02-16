# R2 Backup Benchmark

Benchmarks how quickly a ~692MB directory (34.5k files) can be snapshotted from a Sandbox container to R2, comparing different archival and transfer strategies.

## The Problem

The Sandbox SDK's file APIs (`readFile`, `readFileStream`) base64-encode binary data inside JSON/SSE frames. For small files this is invisible, but for large binary transfers (like backing up a 692MB directory), the 33% base64 inflation plus JSON parsing overhead becomes the bottleneck.

## Results

Test directory: the sandbox-sdk repo cloned into the container with `npm install` (~692MB, 34.5k files).

| Strategy               | Total    | Archive Size | Method                                   |
| ---------------------- | -------- | ------------ | ---------------------------------------- |
| `tar-zst-fast-chunked` | 16.4s    | 236MB        | split → readFile base64 → R2 multipart   |
| `tar-gz-direct`        | 17.7s    | 229MB        | containerFetch raw binary → R2.put       |
| `tar-direct`           | 8.8s     | 704MB        | containerFetch raw binary → R2.put       |
| `tar-zst-direct`       | 4.0s     | 212MB        | containerFetch raw binary → R2.put       |
| `tar-zst-fast-direct`  | 4.1s     | 236MB        | containerFetch raw binary → R2.put       |
| `tar-pipe`             | 8.0s     | 704MB        | pipe → containerFetch → R2 multipart     |
| **`tar-zst-pipe`**     | **3.6s** | **212MB**    | **pipe → containerFetch → R2 multipart** |
| `tar-zst-fast-pipe`    | 3.7s     | 236MB        | pipe → containerFetch → R2 multipart     |

## Four Strategy Families

### 1. Chunked (`*-chunked`)

The baseline approach using only standard SDK file APIs.

```
Container: tar + compress → write archive to disk → split into 10MB chunks
Worker:    readFile(chunk, {encoding:'base64'}) → decode → R2 multipart uploadPart
```

Every byte passes through base64 encoding (container-side), JSON serialization, base64 decoding (worker-side). For 236MB of archive data, that's ~315MB of text through JSON parsing. Slow but works with no special setup.

### 2. Streaming (`*-stream`)

Uses `readFileStream()` + `streamFile()` to avoid loading the entire file into memory at once, but still hits the same base64/SSE overhead since the streaming API encodes binary data identically.

### 3. Direct (`*-direct`)

Bypasses the SDK's file APIs entirely by starting a Bun HTTP file server inside the container and fetching via `containerFetch()`.

```
Container: tar + compress → write archive to disk → Bun.serve(Bun.file(archive))
Worker:    containerFetch(url, port) → raw binary Response → FixedLengthStream → R2.put
```

Zero base64. Zero SSE. Raw binary over HTTP. The `FixedLengthStream` wrapper provides the `Content-Length` that `R2.put()` requires for stream uploads.

### 4. Pipe (`*-pipe`)

The fastest approach. Archives and transfers simultaneously with no intermediate file on disk.

```
Container: Bun.serve → Bun.spawn("tar cf - | zstd") → pipe stdout as Response body
Worker:    containerFetch → collect chunks → R2 multipart upload (fixed-size parts)
```

Archive and transfer overlap, so total time approaches `max(archiveTime, transferTime)` instead of their sum. Uses R2 multipart upload since the stream has no known `Content-Length`.

## Key Findings

**base64 is the bottleneck.** The SDK's `readFile` and `readFileStream` both base64-encode binary content. For large files, this adds 33% data inflation plus encode/decode CPU cost. Bypassing this via `containerFetch` to a custom port gives a 4x speedup.

**zstd dominates.** zstd at default level (-3) compresses 692MB → 212MB in ~1.5s. gzip produces a similar size but takes 15s. Uncompressed tar is fast to create but 3x larger to transfer. zstd -1 (fastest) is marginally worse compression for no meaningful speed gain.

**Pipe eliminates sequential overhead.** The direct approach archives to disk (1.5s) then transfers (2.5s) = 4.0s total. The pipe approach overlaps both operations = 3.6s total. The win is modest here but grows with larger directories.

**R2 multipart requires identical part sizes.** All non-final parts must be exactly the same size, not just above the 5MB minimum. Variable-sized parts cause error 10048.

## R2 Binding

The `wrangler.jsonc` includes an R2 bucket binding (`BACKUP_BUCKET`). Create the bucket before running:

```bash
npx wrangler r2 bucket create backup-bench
```

## Setup

```bash
npm install
npm run build
npm run dev  # first run builds the Docker image (2-3 min)
```

## Usage

```bash
curl http://localhost:8787/                          # list all strategies
curl http://localhost:8787/info                       # source directory stats
curl http://localhost:8787/benchmark/tar-zst-pipe     # run a single strategy
curl http://localhost:8787/benchmark/all              # run all strategies
```

## Dockerfile

The custom Dockerfile extends the base sandbox image with:

- `zstd` for compression benchmarks
- A clone of the sandbox-sdk repo with `npm install` as the test directory
- `EXPOSE 8080 8081` for the direct/pipe strategies' Bun file servers
