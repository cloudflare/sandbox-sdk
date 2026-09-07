# Cloudflare Sandbox SDK

`@cloudflare/sandbox` is a Durable Object base class for a container-backed
sandbox. A named sandbox is a Durable Object. The application starts and
destroys the attached container through `this.ctx.container`. The SDK reads
and writes the container filesystem using native Linux semantics.

- [About sandboxes](docs/about-sandboxes.md)
- [How to use a sandbox in a Worker](docs/how-to-use-a-sandbox.md)
- [Sandbox SDK reference](docs/sandbox.md)

## Examples

- [Files](examples/files)
- [Snapshot and restore](examples/snapshot-restore)
- [Container instance lifecycle](examples/instance-lifecycle)

## Development

```sh
npm install
npm run check
npm test
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
