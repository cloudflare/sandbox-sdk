# How to run a command

This guide runs a request-scoped Linux command in a sandbox that is already
attached to a Durable Object.

`@cloudflare/sandbox` does not wrap process execution. Use native
`container.exec()`.

Start the container from application code if it is not running. Then spawn the
command and wait for it in the same request:

```ts
const process = await this.ctx.container.exec(["uname", "-a"]);
const output = await process.output();
return new Response(output.stdout, {
  headers: { "content-type": "text/plain" },
});
```

`exec()` returns after spawn. `output()` or `exitCode` observes completion.
If the caller can disconnect, pass `request.signal` into `exec()`.

Do not retry a cancelled or failed spawn automatically. The process may already
exist. The live handle cannot be recovered in a later request.

For identity and why the handle does not survive, see
[About sandboxes](about-sandboxes.md). For a runnable Worker, see
[Command execution](../examples/command-exec).
