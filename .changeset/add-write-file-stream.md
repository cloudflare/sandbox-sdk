---
'@cloudflare/sandbox': patch
---

`writeFile` now accepts `string | ReadableStream<Uint8Array>` as content,
removing the 32 MiB size limit for file uploads. When a ReadableStream is
provided, it is consumed and streamed directly to disk with no buffering.
The original stream cannot be reused after the call.

`writeFileStream` has been removed — use `writeFile` with a ReadableStream
instead. The `encoding` option on `writeFile` is deprecated; prefer passing
a ReadableStream for binary data rather than base64-encoded strings.
