# Coding agents

Run a coding agent on a GitHub repository in a named Container. Each sandbox clones one repository, runs one task at a time, and returns the agent's changes as a diff. For a step-by-step guide, see [Build a coding agent runner](https://developers.cloudflare.com/sandbox/tutorials/build-a-coding-agent-runner/) and [Run coding agents in a sandbox](https://developers.cloudflare.com/sandbox/coding-agents/).

Done when `GET .../diff` shows the change you asked for.

| Agent                                                   | Directory                    | Reports its outcome through                           |
| ------------------------------------------------------- | ---------------------------- | ----------------------------------------------------- |
| [Pi](https://github.com/earendil-works/pi)              | [`pi`](pi)                   | its JSON events; it exits `0` when a model call fails |
| [Claude Code](https://code.claude.com/docs/en/overview) | [`claude-code`](claude-code) | the `is_error` field of its final `result` event      |
| [Codex](https://developers.openai.com/codex/cli)        | [`codex`](codex)             | its exit code and last message                        |
| [OpenCode](https://opencode.ai)                         | [`opencode`](opencode)       | its exit code and JSON events                         |

Each agent directory is a separate Worker with its own image and `wrangler.jsonc`. Deploy only the agent you want. The Worker code they share is in [`shared`](shared): the Durable Object that clones, runs, and tracks tasks, the outbound policy, and the HTTP routes. Each agent's `src/index.ts` supplies its command line and how to read its outcome. To copy an agent out of this repository, copy `shared` with it.

## Network access

The Container has no internet access. An `Outbound` entrypoint in the Worker receives every HTTP request on port 80 and HTTPS request on port 443 from the Container, and allows two hosts:

- `gateway.ai.cloudflare.com`, only under your account and gateway. The Worker adds the gateway token, so the Container never holds it.
- `github.com`. The Worker adds `GITHUB_TOKEN` when it is set.

Every other host gets `403`. Connections to other ports time out.

## Configure

Set `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID` in the agent's `wrangler.jsonc`. `MODEL` is a model ID in the format the agent expects; its README says which. To attach [custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/) to each model request, set `AI_GATEWAY_METADATA` to a JSON object, for example `{"project": "my-app"}`.

Create a Cloudflare API token with the **AI Gateway Run** permission. The first deploy of a Worker with required secrets reads them from a file:

```sh
npm run shim:build
printf '{"AI_GATEWAY_TOKEN":"%s"}\n' "$AI_GATEWAY_TOKEN" > .secrets.json
npx --yes wrangler@4.137.0 deploy --config examples/coding-agents/pi/wrangler.jsonc --secrets-file .secrets.json
rm .secrets.json
```

Later deploys use `npm run example:coding-agents:pi:deploy`. Replace `pi` with the agent you deploy.

To clone private repositories, add `GITHUB_TOKEN`. Use a fine-grained token limited to the repositories the agent works on. The agent can use the token for anything that token allows on `github.com`, including pushes if it has write access.

## Run a task

Clone a repository into `agent-1`:

```sh
curl --request POST "$WORKER_URL/sandboxes/agent-1/repository" \
  --header "content-type: application/json" \
  --data '{"url": "https://github.com/OWNER/REPOSITORY"}'
```

Start a task. The body is the prompt:

```sh
curl --request POST "$WORKER_URL/sandboxes/agent-1/task" \
  --data 'Add a test for the parser.'
```

The response is `202`. A second task while one runs returns `409`. The prompt is one argument of the agent's command, so a prompt of 128 KiB or more returns `413`.

Poll the task:

```sh
curl "$WORKER_URL/sandboxes/agent-1/task"
```

`state` is one of:

- `running`
- `succeeded`, with the agent's final reply
- `failed`, with the error
- `lost`, when the agent or its Container stopped before the agent finished
- `none`, when no task has run in this Container

Stream the agent's events with `GET .../events`.

You do not need to poll to keep the task alive. While the agent runs, an alarm checks the task every minute. Each check keeps the Container awake.

Read the changes:

```sh
curl "$WORKER_URL/sandboxes/agent-1/diff"
```

Reset the Container:

```sh
curl --request DELETE "$WORKER_URL/sandboxes/agent-1/execution"
```

The next clone starts on a fresh disk.

The agents run without their own permission prompts or sandboxes. The Container is the sandbox: the agent can run any command in it, but it reaches only the two hosts above.

Authenticate in production. Anyone who can reach this Worker can spend your AI Gateway budget.
