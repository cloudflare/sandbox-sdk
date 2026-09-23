# Change commands and file calls

Convert 0.12 `exec()`, session, and file calls to native `container.exec()` and `Files`. Done when no code calls a 0.12 method to run a command or touch a file.

Do [Move to your own Durable Object](your-own-durable-object.md) first. On this page, `container` is `this.ctx.container` and `files` is a `Files` instance.

## 1. Pass each command as an array

`container.exec()` runs one program with its arguments. It does not start a shell.

Done when every `exec()` call passes an array.

```ts
// Was: await sandbox.exec("npm test");
await container.exec(["npm", "test"]);

// Pipes, redirects, and variables need a shell.
await container.exec(["sh", "-c", "npm test 2>&1 | tee /tmp/test.log"]);
```

## 2. Read the result

`exec()` returns a running process. `output()` waits for it and returns bytes.

Done when each caller reads `exitCode` instead of `success`.

```ts
const process = await container.exec(["npm", "test"], { cwd: "/workspace" });
const result = await process.output();
const stdout = new TextDecoder().decode(result.stdout);
const passed = result.exitCode === 0;
```

To stream output instead, which replaces `stream: true`, `onOutput`, and `execStream()`, return the process's `stdout` as a response body. Pass `stderr: "combined"` to send standard error with it. Set `Content-Type: text/event-stream`. With other content types, the response can arrive all at once when the process exits.

```ts
const process = await container.exec(["npm", "test"], { cwd: "/workspace", stderr: "combined" });
return new Response(process.stdout, { headers: { "Content-Type": "text/event-stream" } });
```

The bytes are the command's own output, not server-sent events. Read them with `fetch()` and a stream reader, not `EventSource`.

## 3. Replace sessions

A 0.12 session kept a working directory and environment variables across calls. Keep them in an object, and pass it to each call.

Done when no code calls `createSession()` or `getSession()`.

```ts
// Was: const build = await sandbox.createSession({ cwd: "/workspace/app", env: { CI: "1" } });
const build = { cwd: "/workspace/app", env: { CI: "1" } };
await container.exec(["npm", "ci"], build);
await container.exec(["npm", "test"], build);
```

A command cannot change the directory or variables of later commands. A `cd` or `export` lasts until that command ends. Run steps that depend on each other in one `sh -c`.

`exec()` does not inherit the `env` passed to `start()`. Pass variables on each call that needs them.

For isolation between sessions, use separate sandbox names.

## 4. Replace timeouts

Pass an `AbortSignal` from a timer you clear when the command exits. It replaces `timeout` and `commandTimeoutMs`.

Done when no call passes `timeout`.

```ts
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 60_000);
try {
  const process = await container.exec(["npm", "test"], { signal: abort.signal });
  const result = await process.output();
  if (result.exitCode === 137) {
    // Killed when the timer fired.
  }
} finally {
  clearTimeout(timer);
}
```

When the signal fires, the process gets `SIGKILL`. `output()` still resolves, with exit code `137`. Check the exit code. The command may have made changes before it was killed.

Do not pass `AbortSignal.timeout()` to `exec()` for a command that can finish first. It stays armed. When it fires, the runtime signals a process that has already exited, which records an internal error on the Durable Object invocation. `Files` and `S3Mounts` accept `AbortSignal.timeout()`, because they stop following a signal when the operation ends.

## 5. Change each file call

Replace each file call with a `Files` method.

Done when no call passes `encoding` or reads `.content`.

| 0.12                                              | Now                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `readFile(path)`, then `.content`                 | `await (await files.readFile(path)).text()`                          |
| `readFile(path, { encoding: "base64" })`          | `await (await files.readFile(path)).arrayBuffer()`                   |
| `readFileStream(path)`                            | `(await files.readFile(path)).body`                                  |
| `writeFile(path, base64, { encoding: "base64" })` | `await files.writeFile(path, bytes)`                                 |
| `exists(path)`                                    | `files.stat(path)`, and catch `SandboxFileError` with `ENOENT`       |
| `listFiles(path)`                                 | `files.readDirectory(path)`                                          |
| `listFiles(path, { recursive: true })`            | A walk over `readDirectory()`, shown in the [Files API](../files.md) |
| `mkdir(path, { recursive: true })`                | `files.mkdir(path, { recursive: true })`                             |
| `deleteFile(path)`                                | `files.remove(path)`                                                 |
| `renameFile()`, `moveFile()`                      | `files.rename(source, destination)`                                  |

Failures throw `SandboxFileError`. Its `code` is the Linux error name, such as `ENOENT` or `EACCES`:

```ts
try {
  await files.stat("/workspace/package.json");
} catch (cause) {
  if (SandboxFileError.is(cause) && cause.code === "ENOENT") {
    // The file does not exist.
  } else {
    throw cause;
  }
}
```

`files.rename()` fails with `EXDEV` across filesystems. To move there, copy with `container.exec(["cp", "-a", source, destination])`, then remove the source.

## 6. Replace file watching

Run a watcher in the Container, and stream its output while the request is open. It replaces `watch()` and `checkChanges()`. The image needs `inotify-tools`.

Done when the stream shows a line for each change.

```ts
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 10 * 60_000);
const watcher = await container.exec(
  [
    "inotifywait",
    "-m",
    "-r",
    "-e",
    "create,modify,delete,move",
    "--format",
    "%e %w%f",
    "/workspace",
  ],
  { signal: abort.signal },
);
const stopTimer = () => clearTimeout(timer);
watcher.exitCode.then(stopTimer, stopTimer);
return new Response(watcher.stdout, { headers: { "Content-Type": "text/event-stream" } });
```

Each line is an event and a path, such as `MODIFY /workspace/src/index.ts`. The watcher stops, and the stream ends, when the timer fires. Clearing the timer when the watcher exits on its own, as it does after the client disconnects, keeps the timer from signalling an exited process.
