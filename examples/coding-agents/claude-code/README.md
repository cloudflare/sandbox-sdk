# Claude Code

Run [Claude Code](https://code.claude.com/docs/en/overview) on a GitHub repository in a named Container. Each sandbox clones one repository, runs one task at a time, and returns Claude Code's changes as a diff. For a step-by-step guide, see [Run Claude Code in a sandbox](https://developers.cloudflare.com/sandbox/coding-agents/claude-code/).

Done when `GET .../diff` shows the change you asked for.

## Deploy

```sh
npm create cloudflare@latest -- claude-code-agent --template=cloudflare/sandbox-sdk/examples/coding-agents/claude-code
cd claude-code-agent
```

In `wrangler.jsonc`, set `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID`. `MODEL` is an Anthropic model ID your gateway can serve, for example `claude-sonnet-5`. To attach [custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/) to each model request, set `AI_GATEWAY_METADATA` to a JSON object, for example `{"project": "my-app"}`.

Create a Cloudflare API token with the **AI Gateway Run** permission. The first deploy reads the required secret from a file:

```sh
printf '{"AI_GATEWAY_TOKEN":"%s"}\n' "$AI_GATEWAY_TOKEN" > .secrets.json
npm run deploy -- --secrets-file .secrets.json
rm .secrets.json
```

Later deploys use `npm run deploy`.

To clone private repositories, add a `GITHUB_TOKEN` secret with `npx wrangler secret put GITHUB_TOKEN`. Use a fine-grained token limited to the repositories the agent works on. The agent can use the token for anything that token allows on `github.com`, including pushes if it has write access.

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

## Network access

The Container has no internet access. An `Outbound` entrypoint in the Worker receives every HTTP request on port 80 and HTTPS request on port 443 from the Container, and allows two hosts:

- `gateway.ai.cloudflare.com`, only under your account and gateway. The Worker adds the gateway token, so the Container never holds it.
- `github.com`. The Worker adds `GITHUB_TOKEN` when it is set.

Every other host gets `403`. Connections to other ports time out.

The agent runs without its own permission prompts or sandbox. The Container is the sandbox: the agent can run any command in it, but it reaches only the two hosts above.

Authenticate in production. Anyone who can reach this Worker can spend your AI Gateway budget.

## How Claude Code runs

Claude Code reaches Anthropic models through AI Gateway by setting `ANTHROPIC_BASE_URL` to the gateway's Anthropic endpoint. It needs an API key to start, so the Container gets a placeholder that the Worker removes. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` turns off its update check, telemetry, and error reporting, so it only calls the gateway.

The outcome comes from the final `result` event's `is_error` field: a failed model call still reports `subtype: "success"`. Claude Code retries a failing model call up to 10 times, so a bad token takes about three minutes to fail.

Claude Code runs with `--dangerously-skip-permissions`. The Container runs as root, which needs `IS_SANDBOX=1`.

## Code

`src/index.ts` holds Claude Code's command line and how to read its outcome. `src/runner` is a copy of the runner that every [coding agent template](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/coding-agents) in `cloudflare/sandbox-sdk` shares: the HTTP routes, the outbound policy, and the Durable Object that clones, runs, and tracks tasks.
