# Claude Code

Run [Claude Code](https://code.claude.com/docs/en/overview) on a GitHub repository. Configuration, routes, and task states are in the [coding agents README](../README.md).

```sh
npm run example:coding-agents:claude-code:deploy
```

`MODEL` is an Anthropic model ID your gateway can serve, for example `claude-sonnet-5`.

Claude Code reaches Anthropic models through AI Gateway by setting `ANTHROPIC_BASE_URL` to the gateway's Anthropic endpoint. It needs an API key to start, so the Container gets a placeholder that the Worker removes. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` turns off its update check, telemetry, and error reporting, so it only calls the gateway.

The outcome comes from the final `result` event's `is_error` field: a failed model call still reports `subtype: "success"`. Claude Code retries a failing model call up to 10 times, so a bad token takes about three minutes to fail.

Claude Code runs with `--dangerously-skip-permissions`. The Container runs as root, which needs `IS_SANDBOX=1`.
