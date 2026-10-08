# Coding agents

Run a coding agent on a repository in a sandbox. As in [Run coding agents in a sandbox](https://developers.cloudflare.com/sandbox/coding-agents/), there are two kinds: agents that run in your sandbox, and agents whose vendor runs the agent loop in its own service.

## The agent runs in your sandbox

Each of these templates is a Worker that runs a coding agent on a GitHub repository in a named Container. Each sandbox clones one repository, runs one task at a time, and returns the agent's changes as a diff. The Worker holds the AI Gateway token, and the Container can reach only your gateway and `github.com`. For a step-by-step guide, see [Build a coding agent runner](https://developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner/).

| Agent                                                   | Template                     | Reports its outcome through                           |
| ------------------------------------------------------- | ---------------------------- | ----------------------------------------------------- |
| [Pi](https://github.com/earendil-works/pi)              | [`pi`](pi)                   | its JSON events; it exits `0` when a model call fails |
| [Claude Code](https://code.claude.com/docs/en/overview) | [`claude-code`](claude-code) | the `is_error` field of its final `result` event      |
| [Codex](https://developers.openai.com/codex/cli)        | [`codex`](codex)             | its exit code and last message                        |
| [OpenCode](https://opencode.ai)                         | [`opencode`](opencode)       | its exit code and JSON events                         |

Each template is a project of its own, with its own Worker, image, and `wrangler.jsonc`. Its README creates a project with `npm create cloudflare`, deploys it, and runs a task.

### The runner

The four templates share one runner: the Durable Object that clones, runs, and tracks tasks (`sandbox.ts`), the outbound policy (`outbound.ts`), and the HTTP routes (`handler.ts`). Its source is in [`runner`](runner). `npm create cloudflare` copies only one template's folder, so each template carries a generated copy of the runner in `src/runner`. Each template's `src/index.ts` adds what is specific to its agent: the command line and how to read the outcome.

To change the runner, edit the files in `runner`, then write the copies from the repository root:

```sh
npm run example -- sync-runner
```

Do not edit a template's `src/runner` in this repository. CI runs `npm run example -- sync-runner --check`, which fails when a copy differs from `runner`.

## The vendor runs the agent loop

The vendor's service runs the agent loop and sends commands and file edits to sandboxes in your Cloudflare account. Each template gives every session its own sandbox. In the Devin, Cursor, and OpenAI Agents API templates, the vendor's worker process runs inside the sandbox, so the sandbox also holds a vendor credential.

| Agent                                                                                                   | Template                                                                                  |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Devin](https://developers.cloudflare.com/sandbox/coding-agents/devin/)                                 | [`templates/devin`](../../templates/devin)                                                |
| [Cursor Cloud Agents](https://developers.cloudflare.com/sandbox/coding-agents/cursor/)                  | [`anysphere/cloudflare-workers`](https://github.com/anysphere/cloudflare-workers)         |
| [Claude Managed Agents](https://developers.cloudflare.com/sandbox/coding-agents/claude-managed-agents/) | [`cloudflare/claude-managed-agents`](https://github.com/cloudflare/claude-managed-agents) |
| [OpenAI Agents API](https://developers.cloudflare.com/sandbox/coding-agents/openai-agents-api/)         | [`templates/openai-agents-api`](../../templates/openai-agents-api)                        |
