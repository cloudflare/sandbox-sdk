# Cloudflare Sandbox Bridge

HTTP bridge that translates sandbox session operations into calls against the `@cloudflare/sandbox` Durable Object API.

| Directory            | Description                                      |
| -------------------- | ------------------------------------------------ |
| [worker/](./worker/) | Deployable Cloudflare Worker — the bridge itself |
| [script/](./script/) | Development scripts                              |

## Quick start

Deploy the bridge worker with one click:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/sandbox-sdk/tree/main/bridge/worker)

Or deploy manually — see [worker/README.md](./worker/README.md) for setup, configuration, and the full API reference.
