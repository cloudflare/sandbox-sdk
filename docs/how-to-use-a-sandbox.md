# How to use a sandbox in a Worker

This guide attaches a container-backed sandbox to a Worker and accesses files
in it.

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

Extend `DurableObject` and construct `Files` with its container. Start the
container from application code before using the file operations:

```ts
import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

interface Env {
  SANDBOX: DurableObjectNamespace<MySandbox>;
  SANDBOX_IMAGE: string;
}

export class MySandbox extends DurableObject<Env> {
  readonly files: Files;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.files = new Files(this.requireContainer());
  }

  async read(path: string): Promise<Response> {
    const container = this.requireContainer();
    if (!container.running) {
      container.start({
        image: this.env.SANDBOX_IMAGE,
        instance: "lite",
        enableInternet: false,
      });
    }
    return this.files.readFile(path);
  }

  private requireContainer(): Container {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("Container attachment is unavailable");
    }
    return container;
  }
}
```

If a container is already running, the code above reuses it. To start from a
new image, destroy the current execution first.

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
[Files reference](sandbox.md). For identity, deployments, and
failures, see [About sandboxes](about-sandboxes.md). To run a command, see
[How to run a command](how-to-run-a-command.md). To forward HTTP, see
[How to forward HTTP](how-to-forward-http.md).
