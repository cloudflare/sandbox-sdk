# Migrate from the Sandbox class

`@cloudflare/sandbox` 0.12 gave you a `Sandbox` Durable Object class that owned the Container. Now your own Durable Object calls `this.ctx.container` to start the Container and run commands. The package adds `Files` and `S3Mounts`.

## What changes

- You own the Durable Object class. It starts the Container. Nothing starts on first use.
- Commands are arrays, not shell strings. Each call runs one process, so `cd` and `export` do not carry over.
- Containers have no Internet access unless you pass `enableInternet: true` to `start()`. 0.12 allowed it by default.
- There are no SDK timeouts. Pass an `AbortSignal`.
- You choose the image. `Files` and `S3Mounts` need `sandbox-shim` in it.
- Files in Containers started by 0.12 do not carry over. Copy anything you need before you deploy.

## Pages

Start with the first page. Then do the pages for the features you use.

1. [Move to your own Durable Object](your-own-durable-object.md): image, configuration, class, deploy
2. [Change commands and file calls](commands-and-files.md): `exec()`, sessions, timeouts, files, watching
3. [Move background processes](background-processes.md): `startProcess()`, status, logs, waits, kills, callbacks
4. [Move browser terminals](terminals.md): `terminal()`, terminal sessions, reconnect, replay, `SandboxAddon`
5. [Move outbound rules](outbound-network.md): outbound handlers, allowed and denied hosts, runtime changes
6. [Move backups](backups.md): `createBackup()`, `restoreBackup()`, backup options, backups made by 0.12
7. [Move preview URLs and tunnels](ports-and-tunnels.md): `exposePort()`, `proxyToSandbox()`, `waitForPort()`, quick and named tunnels
8. [Move bucket mounts](bucket-mounts.md): `mountBucket()`, R2 binding mounts, `localBucket`, mount errors

For every 0.12 API and what replaces it, see the [API map](api-map.md).
