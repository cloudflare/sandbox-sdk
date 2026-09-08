# Cloudflare Sandbox SDK

Build a sandbox as a container-enabled Durable Object. Use native Container
APIs for lifecycle and process execution. Add `@cloudflare/sandbox` when you
need structured, streaming file operations with native Linux semantics.

- [About sandboxes](docs/about-sandboxes.md)
- [How to use a sandbox in a Worker](docs/how-to-use-a-sandbox.md)
- [How to run a command](docs/how-to-run-a-command.md)
- [Files reference](docs/sandbox.md)

## Examples

- [Files](examples/files)
- [Snapshot and restore](examples/snapshot-restore)
- [Container instance lifecycle](examples/instance-lifecycle)
- [Command execution](examples/command-exec)

## Development

```sh
npm install
npm run check
npm test
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
