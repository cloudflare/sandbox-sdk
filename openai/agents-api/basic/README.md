# Basic Agents API Worker

This example uses the OpenAI Agents API TypeScript SDK in a Cloudflare Worker. Its HTTP interface creates webhook-managed self-hosted sessions, runs initial and follow-up input, returns retained output as JSON, and cleans up both the OpenAI session and its executor Container.

The [executor Worker](../README.md) must already be deployed and configured for `OPENAI_AGENT_ID`.

## Install

```bash
cd openai/agents-api/basic
npm install
cp .dev.vars.example .dev.vars
```

Set these bindings in `.dev.vars`:

- `OPENAI_API_KEY`: application key used by the TypeScript SDK.
- `OPENAI_AGENT_ID`: agent configured in the executor Worker.
- `EXECUTOR_URL`: deployed executor Worker URL without `/webhook`.
- `EXECUTOR_CLIENT_SECRET`: bearer token used for executor cleanup.

`TASK_TIMEOUT_SECONDS` is a non-secret variable in `wrangler.jsonc` and defaults to `600`.

## Run locally

```bash
npm run dev
```

Check health:

```bash
curl --fail-with-body http://127.0.0.1:8787/health
```

Run the complete demo:

```bash
curl --fail-with-body \
  --request POST \
  http://127.0.0.1:8787/demo
```

The demo creates a session, writes and reads `/workspace/basic-demo.txt`, submits a follow-up that reads the file again, then deletes the OpenAI session and Cloudflare executor.

Create a session and run its first input:

```bash
curl --fail-with-body \
  --request POST \
  --header "Content-Type: application/json" \
  --data '{"input":"Write hello to /workspace/hello.txt, then read it."}' \
  http://127.0.0.1:8787/sessions
```

Save the returned `session_id`, then run follow-up input:

```bash
export SESSION_ID="sess_..."

curl --fail-with-body \
  --request POST \
  --header "Content-Type: application/json" \
  --data '{"input":"Read /workspace/hello.txt again."}' \
  "http://127.0.0.1:8787/sessions/$SESSION_ID/input"
```

Delete the OpenAI session and executor:

```bash
curl --fail-with-body \
  --request DELETE \
  "http://127.0.0.1:8787/sessions/$SESSION_ID"
```

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/sandbox-sdk/tree/main/openai/agents-api/basic)

For manual deployment:

```bash
npm run deploy
```

The Deploy to Cloudflare workflow prompts for the required bindings described in `package.json`.

## HTTP API

| Method   | Path                         | Behavior                                                        |
| -------- | ---------------------------- | --------------------------------------------------------------- |
| `GET`    | `/health`                    | Reports Worker readiness.                                       |
| `POST`   | `/demo`                      | Runs a complete create, input, follow-up, and cleanup workflow. |
| `POST`   | `/sessions`                  | Creates a self-hosted session and runs `input`.                 |
| `POST`   | `/sessions/:sessionID/input` | Runs `input` in an existing session.                            |
| `DELETE` | `/sessions/:sessionID`       | Deletes the OpenAI session and Cloudflare executor.             |
