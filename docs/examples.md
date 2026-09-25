# Examples

This page explains how the examples in `examples/` are written, and how to add one. Each example is a Worker that someone can deploy and use for one job, such as running a coding agent, previewing a web app, or backing up a directory. The examples are also where application policy lives, which the package leaves out on purpose. See [Architecture](architecture.md#what-stays-out-of-the-package).

## What an example contains

```txt
examples/<NAME>/
  Dockerfile
  README.md
  wrangler.jsonc
  src/index.ts
```

`examples/coding-agents` is the exception. It deploys one Worker for each agent, and the agents share code in `coding-agents/shared/`.

`examples/minimal` is also different. It is the template for `npm create cloudflare`, so it has its own `package.json`, depends on the published package, and copies the shim from the published donor image. It cannot build until those are published, and the root scripts do not deploy it.

## Write the Worker

- Put the job in a Durable Object class that owns one container. Use `this.ctx.container` directly for `start()`, `destroy()`, snapshots, and inactivity timeouts.
- Map each sandbox name to one Durable Object with `getByName()`. Check the name before you use it. Most examples accept 1 to 63 lowercase letters, digits, or hyphens.
- Make every policy explicit in the example's code: when the container starts, how long it stays running, what a request may reach, and when to give up. The package adds no timeouts or retries, so an example must not rely on any.
- `setInactivityTimeout()` applies to the Durable Object instance that calls it. When the container is already running, call it again in the constructor, as `examples/workspace` does.
- Declare the `Env` interface in the example's source. `.gitignore` ignores `wrangler types` output, so an example must type-check without it.
- Log errors with their stack, so a failure is readable in Workers Logs.

## Configure the Worker and the image

Start from an existing example's `wrangler.jsonc`. The examples share these settings:

- `name` is `sandbox-<NAME>-example`.
- The Durable Object binding is `SANDBOX`.
- The `containers` entry uses `scheduling_policy: "durable_object"` and builds `./Dockerfile` as an image named `sandbox`.
- `nodejs_compat` is on when the example uses `Files`, `S3Mounts`, or `DirectoryBackups`.
- Observability is on.

An example that uses `Files`, `S3Mounts`, or `DirectoryBackups` copies the shim from the local donor image:

```dockerfile
ARG SANDBOX_TOOLS_IMAGE=sandbox-tools:local
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM debian:trixie-slim
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
```

Any server in the image must listen on all interfaces, not only `127.0.0.1`. Create directories under `/run` when the container starts, not in the image. Keep application state and large files out of `/run`, because it is a small in-memory filesystem, and when it is full every `exec()` fails.

## Write the README

Follow the shape of the existing READMEs:

1. A title, then one paragraph that says what the Worker does. Link the matching page on developers.cloudflare.com. Call the page a step-by-step guide only when the example follows the same design, and otherwise say how the example differs.
2. A line that starts with `Done when`, describing the result someone can check.
3. The deploy command, then `curl` steps against `$WORKER_URL`, each followed by the response to expect.
4. How to reset or clean up the sandbox.

## Wire it into the repository

1. Add `example:<NAME>:deploy` and `example:<NAME>:types` scripts to the root `package.json`, copying an existing pair. Deploy scripts run `npm run shim:build` first when the example uses the shim, and every script uses the pinned Wrangler version.
2. The root `tsconfig.json` includes `examples/**`, and maps `@cloudflare/sandbox` to the package source, so `npm run check` type-checks the example against the current package.
3. Knip treats `examples/*/src/index.ts` as entry points, and `.gitignore` ignores `examples/*/worker-configuration.d.ts`. An example with a deeper layout, like `coding-agents`, needs its own globs in `knip.json` and `.gitignore`.

## Check it

1. Run `npm run check`.
2. Deploy the example and follow its README step by step, as described in [Testing](testing.md#test-in-production). Delete the deployment afterwards.
3. If a docs page covers the same job, link the example from that page's related resources when the designs match. When they differ, link it from the page where the difference is useful, such as a migration page, and say how it differs.

Done when every README step gives the response it describes.
