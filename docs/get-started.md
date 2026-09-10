# Run a Linux task in a sandbox

Write a shell script into a Container and run it. Done when `stdout` contains `hello from the sandbox`.

Your Worker receives the HTTP request. A Durable Object starts the Container and returns the output.

## 1. Build the image

`Files` needs `/usr/local/bin/sandbox-shim` in the image. Copy it from the donor.

Done when `sandbox-tools:local` exists.

```sh
npm run shim:build
```

```dockerfile
ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM alpine:3.23
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace
CMD ["sleep", "infinity"]
```

Keep your own base image. The donor is not the sandbox. Images must be `linux/amd64`.

## 2. Bind a Durable Object

Map names to Durable Objects. Attach a Container image to that class.

Done when the Worker has a `SANDBOX` binding and `nodejs_compat`.

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      {
        "name": "SANDBOX",
        "class_name": "WorkspaceSandbox",
      },
    ],
  },
  "exports": {
    "WorkspaceSandbox": {
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

Pass `this.env.SANDBOX_IMAGE` to `start()`. `nodejs_compat` lets `Files` read Linux error names through `node:os`.

## 3. Start the Container, write the script, run it

Extend `DurableObject`. Construct `Files` from `this.ctx.container`. Start the Container when `running` is false. Write `/workspace/task.sh`. Run it with `container.exec()`.

Done when the class can write the script and return process output.

```ts
import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

const SOURCE_PATH = "/workspace/task.sh";

export class WorkspaceSandbox extends DurableObject<Env> {
  readonly files: Files;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.files = new Files(this.requireContainer());
  }

  async writeSource(source: ReadableStream<Uint8Array>, name: string) {
    await this.ensureRunning(name);
    await this.files.writeFile(SOURCE_PATH, source);
  }

  async runTask(name: string) {
    const container = await this.ensureRunning(name);
    const process = await container.exec(["/bin/sh", SOURCE_PATH], {
      cwd: "/workspace",
    });
    const output = await process.output();
    return {
      stdout: new TextDecoder().decode(output.stdout),
    };
  }
}
```

`this.ctx.container` is undefined unless the class has a container attachment:

```ts
private requireContainer(): Container {
  const container = this.ctx.container;
  if (container === undefined) {
    throw new Error("Container attachment is unavailable");
  }
  return container;
}
```

Start the Container before `Files` or `exec()`. `exec()` throws if the Container is not running. `start()` does not wait until the instance is ready. Pass `image` and `instance` at start:

```ts
private async ensureRunning(name: string): Promise<Container> {
  const container = this.requireContainer();
  if (!container.running) {
    container.start({
      image: this.env.SANDBOX_IMAGE,
      instance: "lite",
      enableInternet: false,
      labels: { sandbox: name },
    });
  }
  return container;
}
```

The [code workspace example](../examples/workspace) adds HTTP routing and an inactivity timeout.

## 4. Address the Durable Object by name

Pick a name per user, session, or job. Call `getByName()`.

Done when both writes and runs go to that name.

```ts
const stub = env.SANDBOX.getByName(sandboxName);
await stub.writeSource(source, sandboxName);
const result = await stub.runTask(sandboxName);
```

## 5. Confirm the result

Deploy the [code workspace example](../examples/workspace), then:

```sh
printf 'printf "hello from the sandbox\n"\n' | \
  curl --request PUT --data-binary @- \
  "$WORKER_URL/sandboxes/agent-1/source"

curl --request POST "$WORKER_URL/sandboxes/agent-1/run"
```

Done when the JSON `stdout` string contains `hello from the sandbox`. The example Worker decodes `output().stdout` before it returns JSON.

Write a second script to `agent-2`. Each Durable Object name has its own Container:

```sh
printf 'printf "hello from agent 2\n"\n' | \
  curl --request PUT --data-binary @- \
  "$WORKER_URL/sandboxes/agent-2/source"

curl "$WORKER_URL/sandboxes/agent-1/source"
curl "$WORKER_URL/sandboxes/agent-2/source"
```

## After the first success

Authenticate in production. Derive the Durable Object name from your user or job.

This example runs submitted shell. Allow only the commands you intend.

`DELETE /sandboxes/agent-1/execution` destroys that Container. The Durable Object remains. The next start has a fresh disk from the image unless you restore a snapshot.

If the instance times out, disk is gone unless you checkpointed.

A canceled request can still have started the process. Look at the Container before you run the task again.

## Next steps

- [About sandboxes](about-sandboxes.md)
- [Files API](files.md)
- [Checkpoint a workspace](checkpoint-a-workspace.md)
