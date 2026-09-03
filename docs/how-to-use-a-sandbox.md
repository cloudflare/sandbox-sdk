# How to use a sandbox in a Worker

This guide attaches a container-backed sandbox to a Worker and reads or writes
files in it.

The container image must provide `/usr/local/bin/sandbox-shim`. Copy it into
your own base image:

```dockerfile
FROM <sandbox-tools-image> AS sandbox-tools

FROM alpine:3.23
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
```

Export a container-enabled Durable Object and bind it as `SANDBOX`:

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "SANDBOX",
        "class_name": "MySandbox",
      },
    ],
  },
  "exports": {
    "MySandbox": {
      "type": "durable-object",
      "storage": "sqlite",
      "container": {
        "images": [
          {
            "binding": "SANDBOX_IMAGE",
            "image": "./Dockerfile",
          },
        ],
      },
    },
  },
}
```

Extend `Sandbox` and start the attached container before the first file
operation:

```ts
import { Sandbox } from "@cloudflare/sandbox";

interface Env {
  SANDBOX: DurableObjectNamespace<MySandbox>;
  SANDBOX_IMAGE: string;
}

export class MySandbox extends Sandbox<Env> {
  async read(path: string): Promise<Response> {
    this.ensureRunning();
    return this.files.readFile(path);
  }

  async write(path: string, content: ReadableStream<Uint8Array>): Promise<void> {
    this.ensureRunning();
    await this.files.writeFile(path, content);
  }

  private ensureRunning(): void {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("Sandbox requires a container-enabled Durable Object");
    }
    if (!container.running) {
      container.start({
        image: this.env.SANDBOX_IMAGE,
        instance: "lite",
        enableInternet: false,
      });
    }
  }
}
```

Route work to a stable sandbox name:

```ts
export default {
  async fetch(request, env): Promise<Response> {
    const sandbox = env.SANDBOX.get(env.SANDBOX.idFromName("workspace-1"));
    return sandbox.read("/home/user/notes.txt");
  },
} satisfies ExportedHandler<Env>;
```

If the file is missing, `readFile` throws `SandboxFileError` with `code`
`ENOENT`. After a JSRPC hop, recognize it with `SandboxFileError.is(cause)`.

For method options, error fields, and accepted write content, see
[Sandbox SDK reference](sandbox.md). For why identity and lifecycle stay on the
Durable Object and Container APIs, see [About sandboxes](about-sandboxes.md).
