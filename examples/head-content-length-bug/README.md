# Bug: Outbound Interception Strips Content-Length from HEAD Responses

## Summary

When a container makes an HTTP `HEAD` request to an outbound-intercepted host, the
response received by the container always has `Content-Length: 0`, regardless of the
value set by the Durable Object handler. `GET` responses with a body are **not** affected.

This violates [RFC 9110 §9.3.2](https://www.rfc-editor.org/rfc/rfc9110#section-9.3.2):

> The server SHOULD send the same header fields in response to a HEAD request as it
> would have sent if the request method had been GET, except that the payload header
> fields MAY be omitted.

`Content-Length` is explicitly listed as a header that **MUST** be preserved on HEAD.

## Impact

Any software inside the container that relies on `HEAD` to discover resource size
receives `Content-Length: 0`. This breaks `s3fs-fuse` (which uses HEAD to stat files),
`curl -I`, and any HTTP client that checks content length before downloading.

## Reproduction

### Setup

```bash
cd examples/head-content-length-bug
npm install
wrangler deploy          # or: wrangler dev (local dev also affected?)
```

### Test

```bash
curl -s https://<worker-url>/test | jq .
```

### Expected output

```json
{
  "bug": false,
  "summary": "Content-Length is correct for HEAD — bug may be fixed!",
  "head": { "contentLength": 42, "expected": 42, "correct": true },
  "get": { "contentLength": 42, "expected": 42, "correct": true }
}
```

### Actual output

```json
{
  "bug": true,
  "summary": "HEAD Content-Length is 0 (expected 42). GET Content-Length is 42.",
  "head": { "contentLength": 0, "expected": 42, "correct": false },
  "get": { "contentLength": 42, "expected": 42, "correct": true }
}
```

## How the repro works

1. A `Sandbox` subclass registers an outbound handler for `fake-s3.internal`
2. The handler returns `new Response(null, { headers: { 'Content-Length': '42' } })` for HEAD
3. The handler returns `new Response('x'.repeat(42))` for GET (42-byte body)
4. The `/test` endpoint runs `curl -sI` (HEAD) and `curl -s -D` (GET) from inside the container
5. It parses `Content-Length` from each response and compares to the expected value of 42

The handler explicitly sets `Content-Length: 42` on the HEAD response, but the container
sees `Content-Length: 0`. The infrastructure proxy between the DO and the container is
rewriting the header.

## Other headers

All other response headers (`Content-Type`, `ETag`, `Last-Modified`, `X-Debug-Path`,
custom headers) are preserved correctly. Only `Content-Length` is rewritten on HEAD.

## Attempted workarounds (all failed)

| Approach                                                    | Result                                   |
| ----------------------------------------------------------- | ---------------------------------------- |
| Include a body (`new Response(body, { headers })`) for HEAD | `Content-Length` still 0                 |
| Use `FixedLengthStream` as body                             | Same — proxy strips for HEAD             |
| Return `Content-Range: bytes 0-41/42`                       | s3fs doesn't parse Content-Range on HEAD |

## Expected behaviour

The outbound interception proxy should preserve the `Content-Length` header set by the
DO handler on HEAD responses, matching standard HTTP semantics.

## Important: deploy to reproduce

This bug **only reproduces when deployed to Cloudflare** (`wrangler deploy`), not in
local dev (`wrangler dev`). In local dev, Miniflare simulates outbound interception
without the production infrastructure proxy that sits between the DO and the container.
The Content-Length stripping happens in that production proxy layer.

## Environment

- Cloudflare Containers (open beta)
- `@cloudflare/sandbox` SDK v0.9.2
- Wrangler 4.83+
