# Process workspace

Deploy this Worker to start named background processes in a Container. You can then check their status, read or follow their output, wait for a log line or an exit, and stop them. For a step-by-step guide, see [Run background processes](https://developers.cloudflare.com/sandbox/commands/run-background-processes/).

Done when a process started by one request is still running, and its output can be read, from later requests.

```sh
npm run example:process-workspace:deploy
```

Start a process named `ticker` in the sandbox `agent-1`:

```sh
curl --request POST "$WORKER_URL/sandboxes/agent-1/processes" \
  --header 'Content-Type: application/json' \
  --data '{"id":"ticker","command":["sh","-c","echo ready; for i in $(seq 1 300); do echo tick $i; sleep 1; done"]}'
```

The response has status `starting`. Omit `id` to get a random one. Starting a second process with the same ID returns `409`.

Wait for a line that matches an extended regular expression:

```sh
curl --request POST "$WORKER_URL/sandboxes/agent-1/processes/ticker/wait-for-log" \
  --header 'Content-Type: application/json' \
  --data '{"pattern":"^ready$","timeoutMs":30000}'
```

The response is `{"state":"matched","line":"ready"}`. It is `exited` if the process ended without printing a match, and `timed-out` if the timeout passed first.

Check the process and list every process:

```sh
curl "$WORKER_URL/sandboxes/agent-1/processes/ticker"
curl "$WORKER_URL/sandboxes/agent-1/processes"
```

Status is `starting`, `running` with a `pid`, `exited` with an `exitCode`, or `lost` if the process ended without recording one.

Read the output so far, then follow it as it arrives:

```sh
curl "$WORKER_URL/sandboxes/agent-1/processes/ticker/logs"
curl "$WORKER_URL/sandboxes/agent-1/processes/ticker/logs?stream=stderr"
curl --no-buffer "$WORKER_URL/sandboxes/agent-1/processes/ticker/logs?follow"
```

The followed stream ends when the process exits.

Wait up to 5 seconds for the process to exit:

```sh
curl --request POST "$WORKER_URL/sandboxes/agent-1/processes/ticker/wait" \
  --header 'Content-Type: application/json' \
  --data '{"timeoutMs":5000}'
```

The response is `{"state":"timed-out"}` while it runs. Stop it, which sends `SIGTERM` to the process and its children:

```sh
curl --request DELETE "$WORKER_URL/sandboxes/agent-1/processes/ticker"
```

Its status becomes `exited` with exit code `143`. Pass `?signal=INT`, `HUP`, or `KILL` to send another signal. Stop every process, then remove the records of those that ended:

```sh
curl --request DELETE "$WORKER_URL/sandboxes/agent-1/processes"
curl --request POST "$WORKER_URL/sandboxes/agent-1/processes/cleanup"
```

While any process runs, an alarm checks on it every minute. That keeps the Container awake, and Workers Logs records `process.ended` for each process that ended. Reset the Container, which ends every process:

```sh
curl --request DELETE "$WORKER_URL/sandboxes/agent-1/execution"
```

Authenticate in production. This Worker runs any command it receives.
