# Cloudflare Sandbox Bridge

HTTP bridge between the [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) and the [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/). Translates Sandbox operations into calls against the `@cloudflare/sandbox` Durable Object API.

| Directory                | Description                                         |
| ------------------------ | --------------------------------------------------- |
| [worker/](./worker/)     | Deployable Cloudflare Worker — the bridge itself    |
| [examples/](./examples/) | Demo applications (basic CLI agent, workspace chat) |
| [harness/](./harness/)   | Stress testing and integration harness              |
| [script/](./script/)     | Development scripts                                 |

## Quick start

Deploy the bridge worker with one click:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/sandbox-sdk/tree/main/bridge/worker)

Or deploy manually — see [worker/README.md](./worker/README.md) for setup, configuration, and the full API reference.

## Process model

The bridge launches argv processes and returns after launch, not completion. Process status and SSE logs are recoverable by runtime-local ID while the current container remains alive; log cursors support replay after a client reconnects. Process discovery does not wake a sleeping sandbox, and IDs from a stopped or replaced runtime cannot be recovered. Shell syntax requires an explicit shell in `argv`, and process control uses numeric signals.

Terminals are separate PTY resources with input, resize, interrupt, terminate, and reconnect behavior. Closing an SSE connection cancels only that log observation and does not kill its process.

## Integration tests

`bun script/integration` starts a local Worker with containers disabled and checks routing, authentication, validation, and API metadata. Set `BASE_URL` to a deployed bridge to additionally exercise process launch, cancellable log observation, numeric process control, terminal input/reconnection/control, files, and workspace archives against a real container.

The deployed CI workflow supplies `SANDBOX_API_KEY` and always destroys the generated sandbox after the suite.

## Examples

- **[basic/](./examples/basic/)** — One-shot coding agent that executes a task and copies output files to the host. Supports `--image` for visual references.
- **[workspace-chat/](./examples/workspace-chat/)** — Full-stack chat UI with a persistent sandboxed filesystem, file browser sidebar, drag-and-drop uploads, and inline HTML previews.
