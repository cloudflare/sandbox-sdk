# Run background processes

Start a long-running process, such as a dev server, a build, or an agent, from one request, and manage it from later ones. Done when a later request can read the process's status and output, wait for it, and stop it.

The handle `exec()` returns lives in one Durable Object invocation's memory, so a later request cannot use it. Instead, each process gets a directory in the Container. A small shell wrapper writes the PID, output, and exit code there, and later requests read those files. The [process workspace example](../examples/process-workspace) is the complete Worker. Its `src/processes.ts` holds every script on this page.

## 1. Build the image

The wrapper needs `setsid` to give each process its own process group. Following output needs a `tail` that supports `--pid`. Debian includes both. Add `sandbox-shim` to use `Files` for the process directories.

Done when the image runs `setsid --version` and `tail --version`.

```dockerfile
ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM debian:trixie-slim
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace
CMD ["sleep", "infinity"]
```

## 2. Start a process that outlives the request

Reserve the process's directory with a non-recursive `mkdir()`. It fails with `EEXIST` if another request already used the ID. Write the command to `process.json`, then start the wrapper. Send the wrapper's own output to `"ignore"`. The process then keeps running after the request that started it ends.

Done when the process is still running after the request returns.

```ts
const RUN_SCRIPT = `dir=$1; shift
setsid sh -c 'echo "$$" >"$0/pid"; exec "$@"' "$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;

const dir = `/run/processes/${id}`;
await files.mkdir("/run/processes", { recursive: true });
await files.mkdir(dir); // Throws SandboxFileError with code EEXIST if the ID is taken.
await files.writeFile(`${dir}/process.json`, JSON.stringify({ id, command, cwd }));
await container.exec(["/bin/sh", "-c", RUN_SCRIPT, "run", dir, ...command], {
  cwd,
  env,
  stdout: "ignore",
  stderr: "ignore",
});
```

`setsid` makes the inner shell the leader of a new process group. The shell records its PID, which is also the group ID, then replaces itself with the command. The wrapper waits in the foreground, then writes the exit code under a temporary name and renames it, so a reader never sees a partial file. Do not start the command with `&` instead. A shell starts background jobs with `SIGINT` ignored, so the process could not be interrupted.

`exec()` does not inherit environment variables from `start()`. Pass everything the command needs in `env`.

## 3. Check status

A process has recorded an exit code, is still running, or has ended without recording one. `kill -0` checks whether the PID is alive without signalling it. Check the exit code again after a failed `kill -0`, because the process may have exited in between.

Done when the status changes from `running` to `exited` once the command ends.

```sh
if [ -e "$dir/exit-code" ]; then echo "exited $(cat "$dir/exit-code")"
elif [ ! -e "$dir/pid" ]; then echo starting
elif kill -0 "$(cat "$dir/pid")" 2>/dev/null; then echo "running $(cat "$dir/pid")"
elif [ -e "$dir/exit-code" ]; then echo "exited $(cat "$dir/exit-code")"
else echo lost
fi
```

The example runs this in a loop over every process directory, in one `exec()` call, so listing ten processes costs one command. Use `files.readDirectory("/run/processes")` to find the directories.

## 4. Read and follow output

Read the output so far with `files.readFile()`. To follow it, stream `tail -F` and stop it when the process exits.

Done when a followed stream shows new lines as they are printed and ends when the process exits.

```ts
const log = await files.readFile(`${dir}/stdout.log`);

const tail = await container.exec(
  ["tail", "-n", "+1", "-F", "--pid", String(pid), `${dir}/stdout.log`],
  {
    stderr: "ignore",
  },
);
return new Response(tail.stdout, { headers: { "Content-Type": "text/event-stream" } });
```

Use `Content-Type: text/event-stream`, or set it on the Worker's response. With other content types, the output can arrive all at once when the stream ends. For a process that has already exited, run `cat` instead, because `tail --pid` needs a live PID.

## 5. Wait for a log line or an exit

Poll the log files with `grep` in the Container until a line matches or the process exits. Do not pipe `tail -F` into `grep -m 1`. `tail` keeps running after `grep` exits, until the next line arrives.

Done when a wait returns the matching line, and returns `exited` for a process that ended without printing it.

```sh
while :; do
  exited=false; [ -e "$dir/exit-code" ] && exited=true
  line=$(grep -h -m 1 -E -e "$pattern" "$dir/stdout.log" "$dir/stderr.log" 2>/dev/null | head -n 1)
  [ -n "$line" ] && { printf '%s\n' "$line"; exit 0; }
  $exited && exit 3
  sleep 0.2
done
```

Waiting for an exit is the same loop over `exit-code`. Bound each wait with a timer you clear when the command finishes:

```ts
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), timeoutMs);
try {
  const wait = await container.exec(["/bin/sh", "-c", WAIT_FOR_LOG_SCRIPT, "wait", dir, pattern], {
    signal: abort.signal,
  });
  const { exitCode, stdout } = await wait.output();
  // 0: matched, 3: exited without a match, 137: timed out.
} finally {
  clearTimeout(timer);
}
```

Do not pass `AbortSignal.timeout()` to `exec()` here. It stays armed after the command exits. When it fires, the runtime signals a process that has already exited, which records an internal error on the Durable Object invocation.

To wait until a server answers, retry a request to its port. See [Preview a web app](preview-a-web-app.md).

## 6. Stop processes

Signal the process group, so children the command started stop too. `npm run dev`, for example, starts a separate `node` process.

Done when stopping a process also ends the processes it started, and its status becomes `exited` with code `143`.

```ts
await container.exec(["/bin/sh", "-c", 'kill -s "$1" -- "-$2"', "kill", "TERM", String(pid)]);
```

The wrapper records `128` plus the signal number: `143` for `SIGTERM`, `130` for `SIGINT`, `137` for `SIGKILL`. Signal only processes whose status is `running`. To stop every process, signal each running one. To clean up, remove the directories of processes that have ended.

## 7. Keep the Container awake and react to exits

Requests to the Durable Object keep the Container awake. A running process does not. While any process runs, schedule an alarm that checks on it well within the inactivity timeout. The check is itself a request to the Container.

Done when a process runs past the inactivity timeout with no other requests, and Workers Logs records `process.ended` when it exits.

```ts
override async alarm() {
  if (!this.#container.running) return;
  let running = false;
  for (const process of await this.#processes.list()) {
    if (process.status.state === "running" || process.status.state === "starting") {
      running = true;
    } else if (this.ctx.storage.kv.get(`reported:${process.id}:${process.startedAt}`) === undefined) {
      console.log({ event: "process.ended", id: process.id, status: process.status });
      this.ctx.storage.kv.put(`reported:${process.id}:${process.startedAt}`, true);
    }
  }
  if (running) await this.ctx.storage.setAlarm(Date.now() + 60_000);
}
```

Set the alarm when you start a process. Replace the `console.log()` with whatever should happen when a process ends, such as sending a notification or starting the next step. It runs up to one check interval after the exit. A process whose directory was removed before the check is not reported.

## Before production

- Authenticate every request. The example runs any command it receives.
- Processes end when the Container stops, and their directories go with its disk. Keep anything that must survive in Durable Object storage or an S3 mount.
- Log files grow until the process ends. Rotate them, or write to a mounted bucket, for processes that print a lot.
- Keep `enableInternet: false`, or route outbound requests through a Worker that allows only the hosts the processes need.
