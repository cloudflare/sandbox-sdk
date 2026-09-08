# How to open a live terminal

This guide connects one WebSocket to one live PTY in a sandbox.

The package does not own terminals, reconnect, or retained output. Use native
`container.exec()` with PTY options.

Start the container, then spawn a shell:

```ts
const process = await this.ctx.container.exec(["/bin/sh"], {
  env: { TERM: "xterm-256color" },
  pty: { cols: 80, rows: 24 },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "combined",
  signal: abort.signal,
});
```

Accept a standard WebSocket so this Durable Object instance stays awake with
the live handle. The handle cannot survive hibernation.

Write binary WebSocket messages to stdin. Those frames may arrive as
`ArrayBuffer` or `Blob`. Treat text messages as application controls such as
resize. On socket close, abort the exec and kill the direct child.

That cleanup is not a process-tree guarantee.

For why the session is bound to one object instance, see
[About sandboxes](about-sandboxes.md). For a runnable Worker, see
[Live terminal](../examples/live-terminal).
