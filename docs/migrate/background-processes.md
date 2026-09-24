# Move background processes

In 0.12, `startProcess()` returned a `Process`, and the Container kept a table of processes that any later request could query. The Container no longer keeps that table. Your app keeps it, as a directory per process in the Container. [Run background processes](../run-background-processes.md) builds it step by step. The [process workspace example](../../examples/process-workspace) is the complete Worker. Copy its `src/processes.ts` to get every call on this page.

Like 0.12's table, the directories last as long as the Container.

## 1. Start processes

Replace `startProcess()` with the wrapper from [step 2](../run-background-processes.md#2-start-a-process-that-outlives-the-request). The command is an array. To keep a 0.12 command string, run it with `["sh", "-c", command]`.

Done when a process started in one request is listed in the next.

```ts
// 0.12
const process = await sandbox.startProcess("npm run dev", {
  processId: "dev",
  cwd: "/workspace/app",
});

// Now, with the example's Processes class
const process = await processes.start({
  id: "dev",
  command: ["npm", "run", "dev"],
  cwd: "/workspace/app",
  env: { PORT: "8080" },
});
```

`start()` returns `undefined` if the ID is in use, where 0.12 threw. Pass `env` on every call, because `exec()` does not inherit it from `start()`. `sessionId` becomes `cwd` and `env`, as in [Change commands and file calls](commands-and-files.md).

## 2. Check status

Replace `getProcess()`, `listProcesses()`, and `Process.getStatus()` with `get()` and `list()`, which run the status check from [step 3](../run-background-processes.md#3-check-status).

Done when your code handles each status below.

| 0.12 status | Now                                              |
| ----------- | ------------------------------------------------ |
| `starting`  | `starting`                                       |
| `running`   | `running`, with `pid`                            |
| `completed` | `exited` with `exitCode` `0`                     |
| `failed`    | `exited` with another `exitCode` below `128`     |
| `killed`    | `exited` with `128` plus the signal, such as 143 |
| `error`     | `exited` with `127` if the command was not found |
| None        | `lost`: ended without recording an exit code     |

`start()` throws if the Container cannot run the wrapper at all. Keep your own `endTime` in Durable Object storage if you need it. The alarm in step 5 sees each exit.

## 3. Read logs

Replace `getProcessLogs()` and `Process.getLogs()` with `files.readFile()` on `stdout.log` and `stderr.log`. Replace `streamProcessLogs()` with a `tail -F` stream, as in [step 4](../run-background-processes.md#4-read-and-follow-output).

Done when a client that parsed 0.12 log events reads the new stream.

The stream carries raw output, not JSON `LogEvent`s. Drop `parseSSEStream()` and read lines. Follow `stdout` and `stderr` as separate streams, and check status for the exit, which 0.12 sent as an `exit` event. Output written before the Container restarted is gone with its disk, as in 0.12.

## 4. Wait

Replace `Process.waitForLog()` and `Process.waitForExit()` with the waits from [step 5](../run-background-processes.md#5-wait-for-a-log-line-or-an-exit). Replace `Process.waitForPort()` with requests to the port, as in [Preview a web app](../preview-a-web-app.md).

Done when a wait returns the same line, or the same exit code, that 0.12 returned.

```ts
// 0.12
const { line } = await process.waitForLog(/listening on \d+/, 30_000);

// Now
const result = await processes.waitForLog("dev", "listening on [0-9]+", 30_000);
if (result.state !== "matched") throw new Error(`dev server did not start: ${result.state}`);
```

The pattern is a `grep -E` extended regular expression, not a JavaScript `RegExp`. Replace `\d` with `[0-9]`, `\s` with `[[:space:]]`, and `\w` with `[[:alnum:]_]`. 0.12 threw on a timeout. The example returns `timed-out` or `exited`.

## 5. Stop processes and react to exits

Replace `killProcess()` and `Process.kill()` with `kill()`, which signals the whole process group, as in [step 6](../run-background-processes.md#6-stop-processes). Replace `killAllProcesses()` with `killAll()`, and `cleanupCompletedProcesses()` with `cleanup()`.

Done when stopping `npm run dev` also stops the `node` process it started.

The callbacks and `autoCleanup` move to the alarm from [step 7](../run-background-processes.md#7-keep-the-container-awake-and-react-to-exits). That alarm also keeps the Container awake while processes run, which `keepAlive` did in 0.12.

| 0.12          | Now                                                              |
| ------------- | ---------------------------------------------------------------- |
| `onStart`     | Your code after `start()` returns                                |
| `onExit`      | The alarm's `process.ended` branch                               |
| `onOutput`    | Follow the log                                                   |
| `onError`     | Catch errors from `start()`; handle exit code `127` in the alarm |
| `autoCleanup` | Call `cleanup()` from the alarm, after handling the exits        |
| `keepAlive`   | The alarm, which reschedules itself while any process is running |
