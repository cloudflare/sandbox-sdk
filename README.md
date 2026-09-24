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
- [Back up a directory](docs/back-up-a-directory.md)
- [Share a port](docs/share-a-port.md)
- [Preview a web app](docs/preview-a-web-app.md)
- [Run background processes](docs/run-background-processes.md)
- [Open a terminal in a sandbox](docs/open-a-terminal.md)
- [Control outbound requests](docs/control-outbound-requests.md)
- [Run a coding agent on a repository](docs/run-a-coding-agent.md)
- [Migrate from the Sandbox class](docs/migrate/README.md)

## Examples

- [Minimal sandbox](examples/minimal): start a project from a working Worker, Durable Object, and Container
- [Code workspace](examples/workspace): write a script and run it
- [Artifact workspace](examples/artifact-workspace): process files in a job-scoped S3 prefix
- [Backup workspace](examples/backup-workspace): back up a directory to R2 and restore it
- [Checkpoint a workspace](examples/checkpoint-workspace): save the disk and start from that snapshot
- [Preview workspace](examples/preview-workspace): run a dev server and open its live preview
- [Process workspace](examples/process-workspace): start, follow, wait for, and stop background processes
- [Share workspace](examples/share-workspace): give ports preview URLs with tokens, or open tunnels
- [Outbound workspace](examples/outbound-workspace): change which hosts a sandbox reaches while it runs
- [Terminal workspace](examples/terminal-workspace): open a live shell in the browser that survives reconnects
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

If your network inspects TLS, set `SANDBOX_EXTRA_CA` to a CA bundle that trusts it. Image builds pass the bundle as a build secret, so it never enters an image.

```sh
export SANDBOX_EXTRA_CA=/etc/ssl/certs/ca-certificates.crt
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
