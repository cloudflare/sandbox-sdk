---
'@cloudflare/sandbox': patch
---

Add real-time file watching for detecting filesystem changes as they happen.

`sandbox.watch()` returns an SSE stream of create, modify, delete, and move events using native inotify. The stream can be proxied directly to a client or consumed server-side with `parseSSEStream`:

```typescript
// Stream events to a browser client
const stream = await sandbox.watch('/workspace/src', {
  recursive: true,
  include: ['*.ts', '*.js']
});
return new Response(stream, {
  headers: { 'Content-Type': 'text/event-stream' }
});

// Or consume server-side
for await (const event of parseSSEStream<FileWatchSSEEvent>(stream)) {
  console.log(event.type, event.path);
}
```
