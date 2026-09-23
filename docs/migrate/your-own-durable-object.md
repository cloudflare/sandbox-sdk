# Move to your own Durable Object

Replace the `Sandbox` class from `@cloudflare/sandbox` 0.12 with your own Durable Object that calls `this.ctx.container`. Done when your routes return the same results on the new code and no Container runs the old image.

Do this before the other [migration pages](README.md). This page migrates the 0.12 minimal example: `/run` runs a command, and `/file` writes and reads a file.

## 1. Build your own image

Replace `FROM cloudflare/sandbox` with a base image that has the tools your commands use, and copy `sandbox-shim` into it. The 0.12 image included Python, Node.js, and Git. Install the ones you use.

Done when the image has `/usr/local/bin/sandbox-shim` and runs your commands.

```dockerfile
ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM alpine:3.23
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace
EXPOSE 8080
CMD ["sleep", "infinity"]
```

[Run a Linux task](../get-started.md) shows how to build `sandbox-tools:local`.

## 2. Keep the class, change its configuration

Keep the class name `Sandbox`. Durable Objects keep their names and storage, so `getByName("my-sandbox")` reaches the same object as `getSandbox(env.Sandbox, "my-sandbox")`. If you passed `normalizeId: true`, lowercase the name yourself.

Replace `migrations` with `exports`. Use `sqlite` storage for a class created with `new_sqlite_classes`. A Worker deployed with `exports` cannot go back to `migrations`.

Give the Container application a new `name`. Without one, the new application gets the old application's name. The deploy then fails after the new Worker version is already live, and that version runs against the old Containers.

Done when the configuration has `exports`, no `migrations`, and a new application `name`.

Before:

```jsonc
{
  "containers": [
    {
      "class_name": "Sandbox",
      "image": "./Dockerfile",
      "instance_type": "lite",
      "max_instances": 1,
    },
  ],
  "durable_objects": { "bindings": [{ "class_name": "Sandbox", "name": "Sandbox" }] },
  "migrations": [{ "new_sqlite_classes": ["Sandbox"], "tag": "v1" }],
}
```

After:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "containers": [
    {
      "class_name": "Sandbox",
      "name": "my-worker-sandbox-v2",
      "scheduling_policy": "durable_object",
      "images": { "sandbox": { "dockerfile": "./Dockerfile" } },
    },
  ],
  "durable_objects": { "bindings": [{ "class_name": "Sandbox", "name": "Sandbox" }] },
  "exports": { "Sandbox": { "type": "durable-object", "storage": "sqlite" } },
}
```

The instance size moves from `instance_type` to `start({ instance })`. `nodejs_compat` lets `Files` read Linux error names.

## 3. Write the Durable Object

Extend `DurableObject` instead of re-exporting `Sandbox`. Start the Container when `running` is false. Construct `Files` from `this.ctx.container`.

Done when the class type-checks against the output of `wrangler types`.

```ts
import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

// Was sleepAfter: "10m".
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;

export class Sandbox extends DurableObject<Env> {
  readonly #container: Container;
  readonly #files: Files;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container === undefined) throw new Error("Container attachment is unavailable");
    this.#container = container;
    this.#files = new Files(container);
    // Each Durable Object instance must set its own timeout; it is not inherited.
    if (container.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }
  }

  async run() {
    await this.#ensureRunning();
    const process = await this.#container.exec(["sh", "-c", 'echo "2 + 2 = $((2 + 2))"']);
    const result = await process.output();
    const decoder = new TextDecoder();
    return {
      output: decoder.decode(result.stdout),
      error: decoder.decode(result.stderr),
      exitCode: result.exitCode,
      success: result.exitCode === 0,
    };
  }

  async file(): Promise<string> {
    await this.#ensureRunning();
    await this.#files.writeFile("/workspace/hello.txt", "Hello, Sandbox!");
    const file = await this.#files.readFile("/workspace/hello.txt");
    return file.text();
  }

  async #ensureRunning(): Promise<void> {
    if (this.#container.running) return;
    this.#container.start({
      image: this.#container.images.sandbox,
      instance: "lite",
      enableInternet: true,
    });
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }
}
```

`setInactivityTimeout()` replaces `sleepAfter`. It accepts at most 6 hours. To keep a Container running longer without requests, set a Durable Object alarm that calls it again, as the [coding agents example](../../examples/coding-agents) does.

Remove `enableInternet: true` if your commands do not need the Internet.

## 4. Call the Durable Object from the Worker

Replace `getSandbox()` with `getByName()`, and call your own methods over RPC.

Done when `/run` and `/file` call the new methods.

```ts
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = env.Sandbox.getByName("my-sandbox");
    if (url.pathname === "/run") return Response.json(await sandbox.run());
    if (url.pathname === "/file") return Response.json({ content: await sandbox.file() });
    return new Response("Try /run or /file");
  },
} satisfies ExportedHandler<Env>;
```

If you used `proxyToSandbox()` for preview URLs, see [Preview a web app](../preview-a-web-app.md).

## 5. Deploy and delete the old application

Deploy. On its next request, each Durable Object uses the new application and starts a Container from the new image. Containers started by 0.12 keep running in the old application, with no Durable Object attached.

Delete the old application. Its name is the one Wrangler generated before, such as `my-worker-sandbox`:

```sh
npx wrangler containers list
npx wrangler containers delete <OLD_APPLICATION_ID>
```

Done when `/run` and `/file` return results, and `wrangler containers list` shows only the new application.

## Next

[Change commands and file calls](commands-and-files.md) for the rest of your code.
