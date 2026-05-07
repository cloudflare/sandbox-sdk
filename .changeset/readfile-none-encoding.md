---
'@cloudflare/sandbox': patch
---

`readFile` now accepts `encoding: 'none'` on the `rpc` transport, returning a result whose `content` is a `ReadableStream<Uint8Array>` of raw binary data with no base64 encoding or buffering. Mirrors the existing `writeFile` support for `ReadableStream` input.

```ts
// Stream a binary file without buffering or base64 overhead (rpc transport only)
const { content, size, mimeType } = await sandbox.readFile(
  '/workspace/image.png',
  { encoding: 'none' }
);
```
