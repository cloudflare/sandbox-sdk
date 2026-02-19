---
'@cloudflare/sandbox': patch
---

Add real-time file watching for detecting filesystem changes as they happen.

Use `sandbox.watch()` to monitor directories for create, modify, delete, and rename events with native inotify:

```typescript
const watcher = await sandbox.watch('/app/src', {
  recursive: true,
  include: ['*.ts', '*.js'],
  onEvent: (event) => console.log(event.type, event.path)
});
await watcher.stop();
```
