# Build sandboxes on Cloudflare

Give each user or job a Linux workspace. Your Worker receives the request. A Durable Object starts a Container and sends it work.

This repository is that pattern. `@cloudflare/sandbox` adds file operations and S3 mounts. The Durable Object calls `this.ctx.container` to start the instance, run commands, and take snapshots.

Cloudflare also sandboxes work with [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/). This repository is Containers.

## Start here

- [Run a Linux task](docs/get-started.md)
- [About sandboxes](docs/about-sandboxes.md)
- [Files API](docs/files.md)
- [Mount S3-compatible storage](docs/s3-mounts.md)
- [S3Mounts API](docs/s3-mounts-api.md)
- [Checkpoint a workspace](docs/checkpoint-a-workspace.md)
- [Preview a web app](docs/preview-a-web-app.md)
- [Open a terminal in a sandbox](docs/open-a-terminal.md)
- [Run a coding agent on a repository](docs/run-a-coding-agent.md)

## Examples

- [Code workspace](examples/workspace): write a script and run it
- [Artifact workspace](examples/artifact-workspace): process files in a job-scoped S3 prefix
- [Checkpoint a workspace](examples/checkpoint-workspace): save the disk and start from that snapshot
- [Preview workspace](examples/preview-workspace): run a dev server and open its live preview
- [Terminal workspace](examples/terminal-workspace): open a live shell in the browser
- [Coding agents](examples/coding-agents): run a coding agent on a GitHub repository

## In this repository

- [`packages/sandbox`](packages/sandbox): `Files`, `S3Mounts`, and their error recognizers
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
