# Codex

Run the [Codex CLI](https://developers.openai.com/codex/cli) on a GitHub repository. Configuration, routes, and task states are in the [coding agents README](../README.md).

```sh
npm run example:coding-agents:codex:deploy
```

`MODEL` is an OpenAI model ID your gateway can serve, for example `gpt-6-sol`.

Codex reaches OpenAI models through AI Gateway as a custom provider with no API key. It runs with its analytics, update check, and plugin sync turned off, so it only calls the gateway. Plugin sync would otherwise clone a repository from `github.com` on every run, with `GITHUB_TOKEN` attached.

Codex exits `1` when the turn fails, so the exit code decides the outcome. A successful task returns the message Codex writes with `--output-last-message`.

Codex runs with `--dangerously-bypass-approvals-and-sandbox`.
