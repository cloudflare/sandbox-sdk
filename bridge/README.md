# Cloudflare Sandbox Bridge

HTTP bridge between the [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) and the [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/). Translates the SDK's sandbox session operations into calls against the `@cloudflare/sandbox` Durable Object API.

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

## Examples

- **[basic/](./examples/basic/)** — One-shot coding agent that executes a task and copies output files to the host. Supports `--image` for visual references.
- **[workspace-chat/](./examples/workspace-chat/)** — Full-stack chat UI with a persistent sandboxed filesystem, file browser sidebar, drag-and-drop uploads, and inline HTML previews.
