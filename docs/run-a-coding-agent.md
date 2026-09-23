# Run a coding agent on a repository

Clone a GitHub repository into a Container, run a coding agent on it, and return the agent's changes as a diff. Done when a task you submit ends as `succeeded` and `GET .../diff` shows its change.

This page uses [Pi](https://github.com/earendil-works/pi) with Cloudflare AI Gateway. The [coding agents examples](../examples/coding-agents) are complete Workers, one per agent. They share the Worker code for every step here. Only the image, the agent's command line, and how it reports its outcome change.

## 1. Build the image

Install the agent, Git, and the tools the agent calls at build time. The Container then runs with `enableInternet: false`.

Done when the image runs `pi --version`.

```dockerfile
ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.87.1
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
WORKDIR /workspace
CMD ["sleep", "infinity"]
```

## 2. Keep credentials in the Worker

Route every HTTP and HTTPS request from the Container through a `WorkerEntrypoint`. It allows the hosts the task needs and adds their credentials. The Container never holds a real key.

Done when a request from the Container to any other host returns `403`.

```ts
export class Outbound extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const gatewayPrefix = `/v1/${this.env.AI_GATEWAY_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}/`;
    if (url.hostname === GATEWAY_HOST && url.pathname.startsWith(gatewayPrefix)) {
      const headers = new Headers(request.headers);
      headers.set("cf-aig-authorization", `Bearer ${this.env.AI_GATEWAY_TOKEN}`);
      return fetch(new Request(request, { headers }));
    }
    if (url.hostname === "github.com") return fetch(request);
    return new Response(`${url.hostname} is not reachable from this sandbox\n`, { status: 403 });
  }
}
```

Install the intercepts after each `start()`. They last for one Container run.

```ts
this.#container.start({ image: this.#container.images.sandbox, enableInternet: false });
await this.#container.interceptAllOutboundHttp(this.#outbound);
await this.#container.interceptOutboundHttps("*", this.#outbound);
```

`this.#outbound` is `ctx.exports.Outbound({})`, created in the constructor.

## 3. Clone the repository

HTTPS interception re-signs traffic with a Containers CA. Point Git and Node at it. `exec()` does not inherit the environment from `start()`, so pass it on every command that makes HTTPS requests.

Done when `POST .../repository` returns `exitCode: 0`.

```ts
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const TRUST_ENV = {
  NODE_EXTRA_CA_CERTS: CA_PATH,
  GIT_SSL_CAINFO: CA_PATH,
  CURL_CA_BUNDLE: CA_PATH,
  SSL_CERT_FILE: CA_PATH,
};

await this.#container.exec(["git", "clone", "--depth", "1", "--", repository, "/workspace/repo"], {
  cwd: "/workspace",
  env: TRUST_ENV,
});
```

Accept only `https://github.com/` URLs, or the allowlist in step 2 blocks the clone.

## 4. Start the agent in the background

Agent tasks run for minutes. Write the agent's output to files and ignore the process streams. A process with piped output is killed by `SIGPIPE` once the request that started it ends. A shell wrapper records the exit code when the agent ends.

Done when `POST .../task` returns `202`.

```ts
const TASK_SCRIPT = `"$@" >${EVENTS_PATH} 2>${STDERR_PATH}
printf '%s\\n' "$?" >${EXIT_CODE_PATH}.tmp && mv ${EXIT_CODE_PATH}.tmp ${EXIT_CODE_PATH}`;

const { argv, env } = this.command(prompt);
const task = await this.#container.exec(["/bin/sh", "-c", TASK_SCRIPT, "agent", ...argv], {
  cwd: "/workspace/repo",
  env: { ...TRUST_ENV, ...env },
  stdout: "ignore",
  stderr: "ignore",
});
await this.#files.writeFile(PID_PATH, String(task.pid));
```

`command()` is the part each agent supplies. For Pi:

```ts
protected command(prompt: string): AgentCommand {
  return {
    argv: ["pi", "--mode", "json", "--no-session", "--provider", "cloudflare-ai-gateway",
      "--model", this.env.MODEL, "--", prompt],
    env: {
      CLOUDFLARE_API_KEY: "provided-by-worker",
      CLOUDFLARE_ACCOUNT_ID: this.env.AI_GATEWAY_ACCOUNT_ID,
      CLOUDFLARE_GATEWAY_ID: this.env.AI_GATEWAY_ID,
    },
  };
}
```

Pi requires an API key. The Worker replaces the placeholder in step 2. Keep the task files outside the repository so they stay out of the diff.

Run the start inside `ctx.blockConcurrencyWhile()`. Two concurrent starts then cannot both see an idle task.

## 5. Keep the Container awake

The inactivity timeout counts requests to the Container. A running process does not keep it awake. Without requests, the Container stops mid-task and the agent's work is lost.

Schedule an alarm when the task starts. Each check is a request, so the Container stays awake until the agent ends.

Done when a task that runs longer than the inactivity timeout ends as `succeeded` without any client polling.

```ts
async alarm(): Promise<void> {
  if (!this.#container.running) return;
  if ((await this.#taskStatus()).state === "running") {
    await this.ctx.storage.setAlarm(Date.now() + TASK_CHECK_INTERVAL_MS);
    return;
  }
  this.ctx.storage.kv.delete(TASK_KEY);
}
```

The example records the task in Durable Object storage when it starts. If the Container is stopped while that record exists, the task reports `lost`.

## 6. Report the outcome

Pi exits `0` even when a model call fails. Read the outcome from its JSON events instead. The task succeeded when an `agent_settled` event arrived and the last assistant `message_end` has a `stopReason` other than `error` or `aborted`.

Done when a failed model call reports `failed` with the model's error.

Validate each event before reading it. The events file comes from the Container, so treat it as untrusted input. The example uses Zod.

While no exit code is recorded, check the process with `kill -0` through `sh`. Slim images do not ship `/bin/kill`. A process that ended without recording an exit code reports `lost`.

## 7. Return the diff

Mark new files with intent-to-add so they appear in the diff.

Done when `GET .../diff` shows the agent's change.

```ts
await this.#container.exec(["/bin/sh", "-c", "git add --intent-to-add . && git diff"], {
  cwd: "/workspace/repo",
});
```

## Before production

- Authenticate requests. Anyone who can reach the Worker can spend your AI Gateway budget.
- Scope `GITHUB_TOKEN` to the repositories the agent works on. The agent can use the token for anything it allows on `github.com`, including pushes.
- Pin the agent version. Headless flags and event formats change between releases.
- Size the instance for the agent and the repository. The example uses `standard-1`.
