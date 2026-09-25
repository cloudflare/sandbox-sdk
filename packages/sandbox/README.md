<img width="1362" height="450" alt="sandbox" src="https://github.com/user-attachments/assets/6f770ae3-0a14-4d2b-9aed-a304ee5446c5" />

# Cloudflare Sandbox SDK

[![npm version](https://img.shields.io/npm/v/@cloudflare/sandbox)](https://www.npmjs.com/package/@cloudflare/sandbox)
[![npm downloads](https://img.shields.io/npm/dw/@cloudflare/sandbox)](https://www.npmjs.com/package/@cloudflare/sandbox)

Run untrusted or generated code in a Linux sandbox that belongs to one user, task, or session. Your Worker decides who gets a sandbox, which hosts it can reach, and which credentials stay out of it.

A sandbox is a Durable Object and the [Container](https://developers.cloudflare.com/containers/) it starts. The Durable Object starts the instance and runs commands with the Container API on `this.ctx.container`. `@cloudflare/sandbox` adds two things that API does not have:

- [`Files`](https://developers.cloudflare.com/sandbox/reference/files/) streams files in and out of the running instance and reports Linux errors such as `ENOENT`.
- [`S3Mounts`](https://developers.cloudflare.com/sandbox/reference/s3-mounts/) mounts an S3-compatible bucket at a path. Your Worker signs each storage request, so the credentials never enter the sandbox.

**[Read the documentation](https://developers.cloudflare.com/sandbox/)**

## Try it

Create a project from the minimal template, or deploy it directly:

```sh
npm create cloudflare@latest -- my-sandbox --template=cloudflare/sandbox-sdk/examples/minimal
```

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/sandbox-sdk/tree/main/examples/minimal)

The template gives each name in the URL its own sandbox. At its core is a Durable Object like this one:

```ts
import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

export class Sandbox extends DurableObject<Env> {
  async run(script: string) {
    const container = this.ctx.container;
    if (!container) throw new Error("The container binding is not configured");

    if (!container.running) {
      container.start({ image: container.images.sandbox, enableInternet: false });
    }

    const files = new Files(container);
    await files.writeFile("/workspace/task.sh", script);

    const process = await container.exec(["sh", "task.sh"], { cwd: "/workspace" });
    const { exitCode, stdout } = await process.output();
    return { exitCode, stdout: new TextDecoder().decode(stdout) };
  }
}

export default {
  async fetch(request, env) {
    // Authenticate the request, then choose the sandbox for this user or task.
    const sandbox = env.SANDBOX.getByName("user-123");
    return Response.json(await sandbox.run(await request.text()));
  },
} satisfies ExportedHandler<Env>;
```

The image needs the helper that `Files` runs, and the Worker needs `nodejs_compat`. Refer to [Requirements](https://developers.cloudflare.com/sandbox/reference/#requirements).

## What you can build

| Goal                                   | Guide                                                                                                                              | Example                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Run a script and read its output       | [Execute commands](https://developers.cloudflare.com/sandbox/commands/execute-commands/)                                           | [`workspace`](examples/workspace)                                                                        |
| Keep a server or build running         | [Run background processes](https://developers.cloudflare.com/sandbox/commands/run-background-processes/)                           | [`process-workspace`](examples/process-workspace)                                                        |
| Open a shell in the browser            | [Open a terminal in the browser](https://developers.cloudflare.com/sandbox/commands/open-a-terminal-in-the-browser/)               | [`terminal-workspace`](examples/terminal-workspace)                                                      |
| Process files from a bucket            | [Mount an R2 bucket](https://developers.cloudflare.com/sandbox/files/mount-an-r2-bucket/)                                          | [`artifact-workspace`](examples/artifact-workspace)                                                      |
| Save a workspace and resume it later   | [Save and restore a sandbox](https://developers.cloudflare.com/sandbox/files/save-and-restore-a-workspace/)                        | [`checkpoint-workspace`](examples/checkpoint-workspace), [`backup-workspace`](examples/backup-workspace) |
| Preview a web app while you edit it    | [Preview a web application](https://developers.cloudflare.com/sandbox/previews/preview-a-web-application/)                         | [`preview-workspace`](examples/preview-workspace)                                                        |
| Share a port on its own URL            | [Serve previews on their own hostnames](https://developers.cloudflare.com/sandbox/previews/serve-previews-on-their-own-hostnames/) | [`share-workspace`](examples/share-workspace)                                                            |
| Choose which hosts a sandbox can reach | [Control network access](https://developers.cloudflare.com/sandbox/network/)                                                       | [`outbound-workspace`](examples/outbound-workspace)                                                      |
| Run a coding agent on a repository     | [Coding agents](https://developers.cloudflare.com/sandbox/coding-agents/)                                                          | [`coding-agents`](examples/coding-agents), [`devin`](devin), [`openai/agents-api`](openai/agents-api)    |

To run JavaScript or Python without a Linux environment, use [Dynamic Workers](https://developers.cloudflare.com/sandbox/choose-an-environment/) instead.

## Coming from 0.x

Version 0.x provided a `Sandbox` class that owned the Container and ran commands for you. In 1.0, your own Durable Object starts the Container, and this package provides only file operations and bucket mounts. The [migration guide](https://developers.cloudflare.com/sandbox/sdk/migrate/) maps each 0.x API to its replacement. The 0.x source is on the [`v0`](https://github.com/cloudflare/sandbox-sdk/tree/v0) branch.

## Repository

| Path                                           | Contents                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| [`packages/sandbox`](packages/sandbox)         | The `@cloudflare/sandbox` package                                |
| [`crates/sandbox-tools`](crates/sandbox-tools) | `sandbox-shim`, the Linux helper that `Files` and `S3Mounts` run |
| [`images/sandbox-tools`](images/sandbox-tools) | The `cloudflare/sandbox` image that ships `sandbox-shim`         |
| [`examples`](examples)                         | Deployable Workers, one per goal                                 |

To learn how these parts fit together, read [Architecture](docs/architecture.md). The package and `sandbox-shim` exchange frames described in [Shim protocol](docs/shim-protocol.md).

Build and test with Node.js and Docker:

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

[Apache License 2.0](LICENSE)
