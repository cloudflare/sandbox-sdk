# API map

Every public API of `@cloudflare/sandbox` 0.12, and what replaces it. For the steps, see [Migrate from the Sandbox class](README.md).

In the tables, `container` is `this.ctx.container` and `files` is a `Files` instance.

| Kind    | Meaning                                                  |
| ------- | -------------------------------------------------------- |
| Native  | Call `container` or another platform API directly.       |
| Package | Use `Files` or `S3Mounts` from `@cloudflare/sandbox`.    |
| Pattern | Write it yourself. The linked page or example shows how. |
| Product | Use another Cloudflare product.                          |
| None    | No replacement yet.                                      |
| Removed | Not needed. The note says what to do instead.            |

## Class, identity, and lifetime

| 0.12                                                                             | Kind    | Replacement                                                   | Notes                                                                                                     |
| -------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `class X extends Sandbox`, `export { Sandbox }`                                  | Removed | `class X extends DurableObject`                               | Construct `Files` or `S3Mounts` from `container`.                                                         |
| `getSandbox(ns, id, options)`                                                    | Native  | `env.NS.getByName(id)`                                        | Validate names yourself.                                                                                  |
| `normalizeId`, `setSandboxName()`                                                | Removed | Lowercase names yourself                                      | Needed only when names become hostnames.                                                                  |
| `sleepAfter`, `setSleepAfter()`                                                  | Native  | `container.setInactivityTimeout(ms)`                          | At most 6 hours. Set it from every Durable Object instance.                                               |
| `keepAlive`, `setKeepAlive()`                                                    | Pattern | Alarm that sends the Container a request while work remains   | [Run background processes](../run-background-processes.md#7-keep-the-container-awake-and-react-to-exits). |
| `renewActivityTimeout()`                                                         | Native  | Any request to the Durable Object                             | The timeout counts from when the Durable Object becomes inactive.                                         |
| `containerTimeouts`, `setContainerTimeouts()`                                    | Removed | `AbortSignal`                                                 |                                                                                                           |
| `transport`, `setTransport()`, `SANDBOX_TRANSPORT`                               | Removed | —                                                             |                                                                                                           |
| `labels`, `setLabels()`                                                          | Native  | `container.start({ labels })`                                 |                                                                                                           |
| `configure()`                                                                    | Removed | Options on each call                                          |                                                                                                           |
| `setEnvVars()`, class `envVars`                                                  | Native  | `container.start({ env })` or `container.exec(argv, { env })` | `exec()` does not inherit `start()` variables.                                                            |
| Class `entrypoint`, `enableInternet`                                             | Native  | `container.start({ entrypoint, enableInternet })`             | `enableInternet` defaults to `false`. It defaulted to `true` in 0.12.                                     |
| Class `defaultPort`, `requiredPorts`                                             | Native  | `container.getTcpPort(port)`                                  |                                                                                                           |
| `start()`                                                                        | Native  | `container.start({ image })`                                  | Does not wait for the Container.                                                                          |
| `startAndWaitForPorts()`, `waitForPort()`                                        | Pattern | Retry `getTcpPort(port).fetch()`                              | [Preview a web app](../preview-a-web-app.md).                                                             |
| `stop()`, `destroy()`                                                            | Native  | `container.signal()`, `container.destroy()`                   |                                                                                                           |
| `getState()`                                                                     | Native  | `container.running`, `container.monitor()`                    |                                                                                                           |
| `onStart`, `onStop`, `onError`, `onActivityExpired`                              | Pattern | Your code around `start()` and `monitor()`                    |                                                                                                           |
| `schedule()`, `listSchedules()`, `getSchedule()`, `deleteSchedules()`, `alarm()` | Native  | Durable Object alarms                                         | One alarm per object. Store your own schedule if you need several.                                        |
| `fetch()`, `containerFetch()`                                                    | Native  | `container.getTcpPort(port).fetch()`                          |                                                                                                           |

## Commands

| 0.12                                                 | Kind    | Replacement                                  | Notes                                                                                               |
| ---------------------------------------------------- | ------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `exec(command, options)`                             | Native  | `container.exec(argv, options)`              | `output()` returns bytes and `exitCode`. `success` is `exitCode === 0`.                             |
| `stream`, `onOutput`, `onComplete`, `onError`        | Native  | Read `stdout` and `stderr`; await `exitCode` |                                                                                                     |
| `execStream()`                                       | Native  | `container.exec(argv)` streams               | Set `Content-Type: text/event-stream` on the response. [Commands and files](commands-and-files.md). |
| `timeout`, `signal`                                  | Native  | `signal` from a timer you clear              | The process exits with code 137. [Commands and files](commands-and-files.md).                       |
| `cwd`, `env`                                         | Native  | The same options                             |                                                                                                     |
| `encoding`                                           | Removed | Decode bytes yourself                        |                                                                                                     |
| `isExecResult()`, `isProcess()`, `isProcessStatus()` | Removed | —                                            |                                                                                                     |

## Processes

| 0.12                                                     | Kind    | Replacement                                                 | Notes                                                                                           |
| -------------------------------------------------------- | ------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `startProcess()`                                         | Pattern | Wrapper that writes PID, output, and exit code to files     | `processId` becomes the directory name. [Background processes](background-processes.md).        |
| `Process.getStatus()`, `getProcess()`, `listProcesses()` | Pattern | Status check with `kill -0`                                 | [Background processes](background-processes.md).                                                |
| `getProcessLogs()`, `Process.getLogs()`                  | Package | `files.readFile()` on the log files                         | [Background processes](background-processes.md).                                                |
| `streamProcessLogs()`                                    | Pattern | Stream `tail -F --pid`                                      | Raw lines, not JSON events. [Background processes](background-processes.md).                    |
| `Process.waitForLog()`                                   | Pattern | Poll the log files with `grep -E`                           | The pattern is an extended regular expression. [Background processes](background-processes.md). |
| `Process.waitForExit()`                                  | Pattern | Poll for the exit code file                                 | [Background processes](background-processes.md).                                                |
| `Process.waitForPort()`                                  | Pattern | Retry `getTcpPort(port).fetch()`                            | [Preview a web app](../preview-a-web-app.md).                                                   |
| `Process.kill()`, `killProcess()`                        | Pattern | Signal the process group                                    | Reaches the processes it started. [Background processes](background-processes.md).              |
| `killAllProcesses()`, `cleanupCompletedProcesses()`      | Pattern | Signal each running process; remove ended directories       | [Background processes](background-processes.md).                                                |
| `onStart`, `onOutput`, `onError`                         | Pattern | Code after `start()`; follow the log; check exit code `127` | [Background processes](background-processes.md).                                                |
| `onExit`, `autoCleanup`                                  | Pattern | Durable Object alarm that checks each process               | [Background processes](background-processes.md).                                                |

## Sessions

| 0.12                                                 | Kind    | Replacement                  | Notes                                                                             |
| ---------------------------------------------------- | ------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `createSession()`, `getSession()`, `deleteSession()` | Removed | `cwd` and `env` on each call | [Commands and files](commands-and-files.md).                                      |
| `enableDefaultSession`                               | Removed | `cwd` and `env` on each call | `cd` and `export` do not carry over. [Commands and files](commands-and-files.md). |
| `isolation`                                          | Removed | Separate sandboxes           |                                                                                   |
| `commandTimeoutMs`                                   | Removed | `AbortSignal`                |                                                                                   |

`ExecutionSession` methods map like the top-level methods.

## Files

| 0.12                                                                          | Kind    | Replacement                                 | Notes                                                               |
| ----------------------------------------------------------------------------- | ------- | ------------------------------------------- | ------------------------------------------------------------------- |
| `readFile()`, `readFileStream()`                                              | Package | `files.readFile()`                          | Returns a `Response`. Use `.text()`, `.arrayBuffer()`, or the body. |
| `writeFile()`                                                                 | Package | `files.writeFile()`                         | Pass a string, bytes, a `Blob`, or a stream. No base64.             |
| `mkdir()`                                                                     | Package | `files.mkdir()`                             |                                                                     |
| `deleteFile()`                                                                | Package | `files.remove()`                            | Also removes directories with `recursive: true`.                    |
| `renameFile()`, `moveFile()`                                                  | Package | `files.rename()`                            | Fails with `EXDEV` across filesystems.                              |
| `listFiles()`                                                                 | Package | `files.readDirectory()`                     | One level. Includes hidden entries.                                 |
| `listFiles({ recursive: true })`                                              | Pattern | Walk `readDirectory()`                      | [Commands and files](commands-and-files.md).                        |
| `exists()`                                                                    | Package | `files.stat()`                              | Catch `SandboxFileError` with `ENOENT`.                             |
| File metadata                                                                 | Package | `files.stat()`, `files.lstat()`             |                                                                     |
| `watch()`, `checkChanges()`                                                   | Pattern | `inotifywait -m` through `container.exec()` | [Commands and files](commands-and-files.md).                        |
| `collectFile()`, `streamFile()`                                               | Removed | The `Response` body                         |                                                                     |
| `parseSSEStream()`, `responseToAsyncIterable()`, `asyncIterableToSSEStream()` | Removed | —                                           |                                                                     |
| `WriteFileResult`, `ReadFileResult`, and other result types                   | Removed | `void`, `Response`, or `SandboxFileStat`    | Failures throw `SandboxFileError`.                                  |

## Ports, preview URLs, and tunnels

| 0.12                                                                                            | Kind    | Replacement                                 | Notes                                         |
| ----------------------------------------------------------------------------------------------- | ------- | ------------------------------------------- | --------------------------------------------- |
| `exposePort()`, `unexposePort()`, `getExposedPorts()`, `isPortExposed()`, `validatePortToken()` | Pattern | Your own routing and authentication         | [Preview a web app](../preview-a-web-app.md). |
| `proxyToSandbox()`, `SandboxEnv`                                                                | Pattern | Route by hostname to `getByName()`          | [Preview a web app](../preview-a-web-app.md). |
| `wsConnect(request, port)`                                                                      | Native  | `container.getTcpPort(port).fetch(request)` | WebSockets pass through.                      |
| `tunnels.get()`, `tunnels.list()`, `tunnels.destroy()`                                          | None    | —                                           |                                               |

## Terminals

| 0.12                                        | Kind    | Replacement                                                            | Notes                                                                    |
| ------------------------------------------- | ------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `terminal()`, `proxyTerminal()`             | Pattern | tmux client on `container.exec(argv, { pty })`, bridged to a WebSocket | [Terminals](terminals.md).                                               |
| `session.terminal()`                        | Pattern | A tmux session per name                                                | `cwd` and `env` become `-c` and `-e`. [Terminals](terminals.md).         |
| Terminal reconnect and replay               | Pattern | tmux keeps the session; the page reconnects                            | tmux redraws the screen and keeps scrollback. [Terminals](terminals.md). |
| `@cloudflare/sandbox/xterm`, `SandboxAddon` | Pattern | xterm.js with a WebSocket the page reopens                             | [Terminals](terminals.md).                                               |

## Outbound network and Git

| 0.12                                                                                                                                             | Kind    | Replacement                                                                                   | Notes                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `outbound`, `outboundByHost`, `outboundHandlers`, `outboundProxies`, `outboundProxy`                                                             | Native  | `container.interceptOutboundHttp()`, `interceptOutboundHttps()`, `interceptAllOutboundHttp()` | The handler is a `Fetcher`, such as a `ctx.exports` entrypoint. [Run a coding agent](../run-a-coding-agent.md).   |
| `setOutboundHandler()`, `setOutboundByHost()`, `setOutboundByHosts()`                                                                            | Native  | The same `intercept*` methods                                                                 | Call them after each `start()`.                                                                                   |
| `removeOutboundByHost()`                                                                                                                         | None    | —                                                                                             | Intercepts last until the Container stops.                                                                        |
| `interceptHttps`                                                                                                                                 | Native  | `container.interceptOutboundHttps()`                                                          |                                                                                                                   |
| `allowedHosts`, `deniedHosts`, `setAllowedHosts()`, `setDeniedHosts()`, `allowHost()`, `denyHost()`, `removeAllowedHost()`, `removeDeniedHost()` | Pattern | `enableInternet: false` and one handler that checks the host                                  | [Run a coding agent](../run-a-coding-agent.md).                                                                   |
| `ContainerProxy`                                                                                                                                 | Removed | —                                                                                             |                                                                                                                   |
| `gitCheckout()`                                                                                                                                  | Pattern | `container.exec(["git", "clone", …])`                                                         | For private repositories, add credentials in an outbound handler. [Run a coding agent](../run-a-coding-agent.md). |

## Bucket mounts

| 0.12                                                                                                             | Kind    | Replacement                                              | Notes                                                                           |
| ---------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `mountBucket()` with an S3 endpoint                                                                              | Package | `S3Mounts.mount()` with `S3Gateway`                      | Credentials stay in the Worker. [Mount S3-compatible storage](../s3-mounts.md). |
| `prefix`, `readOnly`, `s3fsOptions`                                                                              | Package | `keyPrefix`, `access`, `s3fsOptions`                     |                                                                                 |
| `credentials`, `credentialProxy`, `R2_*` and `AWS_*` variables                                                   | Package | `S3Gateway` credentials                                  | Not read from the environment.                                                  |
| `mountBucket()` with an R2 binding                                                                               | Package | `S3Mounts.mount()` with `S3Gateway` and R2's S3 endpoint | Use an R2 API token. [Mount S3-compatible storage](../s3-mounts.md).            |
| `localBucket`                                                                                                    | None    | —                                                        |                                                                                 |
| `unmountBucket()`                                                                                                | Package | `S3Mounts.unmount()`                                     |                                                                                 |
| `BucketMountError`, `BucketUnmountError`, `InvalidMountConfigError`, `MissingCredentialsError`, `S3FSMountError` | Package | `SandboxS3MountError`                                    | [S3Mounts API](../s3-mounts-api.md).                                            |

## Backups

| 0.12                                                                      | Kind    | Replacement                                                      | Notes                                                   |
| ------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| `createBackup()`, `restoreBackup()`                                       | Native  | `container.snapshotDirectory()`, `container.snapshotContainer()` | [Checkpoint a workspace](../checkpoint-a-workspace.md). |
| `gitignore`, `excludes`, `ttl`, `compression`, `multipart`, `localBucket` | Removed | —                                                                |                                                         |
| `BACKUP_BUCKET`, `BACKUP_BUCKET_NAME`, `BACKUP_BUCKET_ENDPOINT`           | Removed | —                                                                |                                                         |
| `BackupCreateError`, `BackupRestoreError`, and other backup errors        | Removed | Native snapshot errors                                           |                                                         |

## Code interpreter and subpath packages

| 0.12                                                             | Kind    | Replacement                                                           | Notes                                                                                                                                                                  |
| ---------------------------------------------------------------- | ------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runCode()`, `runCodeStream()`, code contexts, `CodeInterpreter` | Product | [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/) | For one script, `container.exec(["python3", …])`.                                                                                                                      |
| `@cloudflare/sandbox/opencode`                                   | Pattern | Run `opencode` with `container.exec()`                                | [OpenCode example](../../examples/coding-agents/opencode). For the server, start `opencode serve` like the dev server in [Preview a web app](../preview-a-web-app.md). |
| `@cloudflare/sandbox/openai`                                     | Removed | —                                                                     |                                                                                                                                                                        |
| `@cloudflare/sandbox/bridge`, `WarmPool`                         | Removed | —                                                                     |                                                                                                                                                                        |

## Images

| 0.12                                                         | Kind    | Replacement                  | Notes                                                         |
| ------------------------------------------------------------ | ------- | ---------------------------- | ------------------------------------------------------------- |
| `cloudflare/sandbox`, `-python`, `-opencode`, `-musl` images | Removed | Your own `linux/amd64` image | Copy `sandbox-shim` into it if you use `Files` or `S3Mounts`. |

## Errors and clients

| 0.12                                                                                                    | Kind    | Replacement                    | Notes                                         |
| ------------------------------------------------------------------------------------------------------- | ------- | ------------------------------ | --------------------------------------------- |
| `ContainerUnavailableError`, `OperationInterruptedError`, `RPCTransportError`, `SessionTerminatedError` | Removed | Native errors from `container` | Not wrapped.                                  |
| `ProcessExitedBeforeReadyError`, `ProcessReadyTimeoutError`                                             | Pattern | Your readiness loop's results  | [Preview a web app](../preview-a-web-app.md). |
| `isPlatformTransientError()`, `isDurableObjectCodeUpdateReset()`                                        | Removed | —                              | The package does not retry.                   |
| `SandboxClient` and the other clients                                                                   | Removed | —                              |                                               |
| `SANDBOX_LOG_LEVEL`, `SANDBOX_LOG_FORMAT`                                                               | Removed | —                              |                                               |
