# `@cloudflare/sandbox`

Read and write files in a running Container. Mount S3-compatible storage when a tool needs a filesystem path.

Start the Container, then:

```ts
import { Files } from "@cloudflare/sandbox";

const container = this.ctx.container;
if (container === undefined) {
  throw new Error("Container attachment is unavailable");
}

const files = new Files(container);
await files.writeFile("/workspace/input.txt", "hello from the sandbox\n");
return files.readFile("/workspace/input.txt");
```

The image must include `/usr/local/bin/sandbox-shim`. The Worker needs `nodejs_compat`.

This package does not start Containers. Extend `DurableObject` and call `this.ctx.container`.

Runtime exports: `Files`, `S3Mounts`, `S3Gateway`, `SandboxFileError`, `SandboxS3MountError`, and `SandboxProtocolError`.

For the walkthrough, see [Run a Linux task](../../docs/get-started.md). For APIs, see [Files API](../../docs/files.md) and [S3Mounts API](../../docs/s3-mounts-api.md).
