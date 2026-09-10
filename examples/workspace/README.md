# Code workspace

Deploy this Worker to write a script into a named Container and run it. For the walkthrough, refer to [Run a Linux task](../../docs/get-started.md).

Done when `POST .../run` returns `hello from the sandbox` in `stdout`.

```sh
npm run example:workspace:deploy
```

```sh
printf 'printf "hello from the sandbox\n"\n' | \
  curl --request PUT --data-binary @- \
  "$WORKER_URL/sandboxes/agent-1/source"

curl --request POST "$WORKER_URL/sandboxes/agent-1/run"
```

Read while that Container is still running:

```sh
curl "$WORKER_URL/sandboxes/agent-1/source"
```

Write `agent-2` to confirm names are isolated:

```sh
printf 'printf "hello from agent 2\n"\n' | \
  curl --request PUT --data-binary @- \
  "$WORKER_URL/sandboxes/agent-2/source"

curl "$WORKER_URL/sandboxes/agent-1/source"
curl "$WORKER_URL/sandboxes/agent-2/source"
```

Reset that Container:

```sh
curl --request DELETE "$WORKER_URL/sandboxes/agent-1/execution"
```

The Durable Object remains. The next start has a fresh disk unless you restore a snapshot.

Authenticate in production. Derive the name from your user or job. This Worker runs submitted shell.
