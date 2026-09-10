# Build sandboxes on Cloudflare

Give each user or job a Linux workspace. Your Worker receives the request. A Durable Object starts a Container and sends it work.

This repository is that pattern. `@cloudflare/sandbox` adds streaming file operations. The Durable Object calls `this.ctx.container` to start the instance, run commands, and take snapshots.

Cloudflare also sandboxes work with [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/). This repository is Containers.

## Start here

- [Run a Linux task](docs/get-started.md)
- [About sandboxes](docs/about-sandboxes.md)
- [Files API](docs/files.md)
- [Checkpoint a workspace](docs/checkpoint-a-workspace.md)

## Examples

- [Code workspace](examples/workspace): write a script and run it
- [Checkpoint a workspace](examples/checkpoint-workspace): save the disk and start from that snapshot

## In this repository

- [`packages/sandbox`](packages/sandbox): `Files` and error recognizers
- [`crates/sandbox-tools`](crates/sandbox-tools): Linux helper used by `Files`
- [`images/sandbox-tools`](images/sandbox-tools): donor image that ships that helper

## Development

```sh
npm install
npm run check
npm test
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
