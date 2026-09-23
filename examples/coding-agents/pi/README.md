# Pi

Run the [Pi](https://github.com/earendil-works/pi) coding agent on a GitHub repository. Configuration, routes, and task states are in the [coding agents README](../README.md).

```sh
npm run example:coding-agents:pi:deploy
```

`MODEL` is a model ID from Pi's `cloudflare-ai-gateway` provider, for example `claude-sonnet-5`.

Pi reaches AI Gateway through its built-in `cloudflare-ai-gateway` provider. It needs an API key to start, so the Container gets a placeholder that the Worker replaces with the gateway token. `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, and `PI_TELEMETRY` turn off its other network requests; model calls still work.

Pi exits `0` even when a model call fails. The task succeeded when Pi's `agent_settled` event arrived and its last assistant message has a `stopReason` other than `error` or `aborted`.

Most Workers AI models in Pi 0.87.1's catalog request as many output tokens as their context window, and Workers AI rejects those requests. Use a provider model such as `claude-sonnet-5`.
