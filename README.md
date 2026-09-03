# Cloudflare Sandbox SDK

`@cloudflare/sandbox` is a Durable Object base class for a container-backed
sandbox. A named sandbox is a Durable Object. Cloudflare starts and restores
the attached container. The SDK streams files in and out of that container
using native Linux semantics.

Container lifecycle stays on `this.ctx.container`.

- [About sandboxes](docs/about-sandboxes.md)
- [How to use a sandbox in a Worker](docs/how-to-use-a-sandbox.md)
- [Sandbox SDK reference](docs/sandbox.md)

## Examples

- [Read and write files](examples/read-write-files)
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
