# OpenCode

Run the [OpenCode](https://opencode.ai) coding agent on a GitHub repository. Configuration, routes, and task states are in the [coding agents README](../README.md).

```sh
npm run example:coding-agents:opencode:deploy
```

`MODEL` is `cloudflare-ai-gateway/<provider>/<model>`, from the model list built into the pinned OpenCode release. List them with `opencode models cloudflare-ai-gateway`.

OpenCode reaches AI Gateway through its built-in `cloudflare-ai-gateway` provider, which sends requests to the gateway's universal endpoint. It needs a token to start, so the Container gets a placeholder that the Worker replaces. Its model list, update, plugin, LSP, and share requests are turned off. It still tries to install `@opencode-ai/plugin` from npm in the background; that request gets `403` and OpenCode continues.

OpenCode exits nonzero on any model or session error, so the exit code decides the outcome. The task returns OpenCode's last text part, or the message from its last error event.

OpenCode runs with `--auto`, which approves every tool call it does not deny.

The image installs the baseline x64 binary directly. The `opencode-ai` installer picks a CPU variant from the build machine, which is an emulator when you build `amd64` images on other hosts.
