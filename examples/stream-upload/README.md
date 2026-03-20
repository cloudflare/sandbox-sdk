# Stream Upload

**Upload files of any size to a sandbox via streaming, then download and verify integrity.**

A demo of the Sandbox SDK's `writeFile` and `readFileStream` APIs. When `writeFile` receives a `ReadableStream`, bytes are streamed directly to disk without base64 encoding or buffering, bypassing the 32 MiB size limit.

## Features

- Browser UI with file picker, upload, and SHA-256 verification
- Streaming upload via `writeFile` with a `ReadableStream` (no size limit)
- Streaming download via `readFileStream` + `streamFile`
- CLI test script for automated integrity checks

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:8787 in your browser, pick a file, and click "Upload & Verify".

## How It Works

1. **Upload** - The browser sends the file as a raw binary stream via `POST /upload`. The Worker passes `request.body` directly to `sandbox.writeFile()`, which streams bytes to disk with zero buffering.

2. **Download** - The browser requests `GET /download?path=...`. The Worker calls `sandbox.readFileStream()` and pipes the decoded chunks into the response body.

3. **Verify** - The browser computes SHA-256 of both the original and downloaded bytes and compares them.

## API

| Endpoint    | Method | Description                                                    |
| ----------- | ------ | -------------------------------------------------------------- |
| `/`         | GET    | Browser UI                                                     |
| `/upload`   | POST   | Stream a file to the sandbox. Query: `?filename=<name>`        |
| `/download` | GET    | Stream a file back from the sandbox. Query: `?path=<filepath>` |

## CLI Test Script

An automated test script is included for verifying the round-trip outside the browser:

```bash
# Default: 35 MB random file against localhost:8787
./test-upload.sh

# Custom server and size
./test-upload.sh http://localhost:8788 50
```

The script generates a random file with `dd`, uploads it, downloads it back, and compares SHA-256 hashes.

## Deploy

```bash
npm run deploy
```

After first deployment, wait 2-3 minutes for container provisioning before making requests.
