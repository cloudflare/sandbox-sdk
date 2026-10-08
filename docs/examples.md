# Examples

This page explains how the examples in `examples/` are written, how to add one, and how to deploy one. Each example is a Worker that someone can deploy and use for one job, such as running a coding agent, previewing a web app, or backing up a directory. The examples are also where application policy lives, which the package leaves out on purpose. See [Architecture](architecture.md#what-stays-out-of-the-package).

## What an example contains

```txt
examples/<NAME>/
  Dockerfile
  README.md
  package.json
  tsconfig.json
  wrangler.jsonc
  src/index.ts
```

Each example is a template for `npm create cloudflare`, which copies only the example's folder. So the folder describes a project of its own: `package.json` pins a published version of `@cloudflare/sandbox`, the `Dockerfile` copies the shim from the donor image of the same version, and `tsconfig.json` has no settings from this repository. Inside the repository, the examples are npm workspaces, so the root `package-lock.json` installs them and the root `package.json` sets one Wrangler version for all of them.

`examples/coding-agents` is the exception. It deploys one Worker for each agent, and the agents share code in `coding-agents/shared/`, so `npm create cloudflare` cannot copy an agent on its own.

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
- `nodejs_compat` is on when the example uses `Files`, `S3Mount`, or `DirectoryBackup`.
- Observability is on.

An example that uses `Files`, `S3Mount`, or `DirectoryBackup` copies the shim from the donor image whose tag equals the package version in its `package.json`:

```dockerfile
# The donor image ships the shim that @cloudflare/sandbox runs in the container.
# Keep its tag equal to the installed @cloudflare/sandbox version.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:<VERSION>
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM debian:trixie-slim
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
```

Keep `SANDBOX_TOOLS_IMAGE` as the argument's name: deploys from the repository replace it with the local shim.

Any server in the image must listen on all interfaces, not only `127.0.0.1`. Create directories under `/run` when the container starts, not in the image. Keep application state and large files out of `/run`, because it is a small in-memory filesystem, and when it is full every `exec()` fails.

## Write the package manifest

Copy `package.json` and `tsconfig.json` from an existing example:

- `name` equals the `name` in `wrangler.jsonc`.
- `dependencies` pins `@cloudflare/sandbox` to the exact version that the other examples pin, and lists every other package that `src` imports, such as `zod`. Inside the repository, a package the example does not list still resolves from the root `node_modules`, so only `check-standalone`, described below, finds it missing. An example that does not import `@cloudflare/sandbox` does not depend on it.
- `devDependencies` lists `wrangler`, `@cloudflare/workers-types`, and `typescript` with caret ranges. The root `package.json` overrides every workspace's Wrangler with its own version.
- The scripts are `dev`, `deploy`, and `types`, which run Wrangler in the example's folder.

Do not commit a lockfile in the example. The root `package-lock.json` covers it.

The pinned version moves only after a stable release publishes, as described in [Releasing](releasing.md#release-a-version). Until then an example can use only the API of the version it pins, because `check-standalone` installs that version from npm. To use a new API in an example, change the example in the pull request that moves the examples to the release that ships the API.

## Write the README

Follow the shape of the existing READMEs:

1. A title, then one paragraph that says what the Worker does. Link the matching page on developers.cloudflare.com. Call the page a step-by-step guide only when the example follows the same design, and otherwise say how the example differs.
2. A line that starts with `Done when`, describing the result someone can check.
3. The `npm create cloudflare` command for the example and `npm run deploy`, then `curl` steps against `$WORKER_URL`, each followed by the response to expect.
4. How to reset or clean up the sandbox.

## Wire it into the repository

Run `npm install` in the repository root, so `package-lock.json` lists the new workspace. Nothing else names the example: the globs in the root `workspaces` and `.gitignore` cover every `examples/<NAME>`, `tools/example.ts` finds every one that has a `wrangler.jsonc`, and Knip reads its entry point from `wrangler.jsonc`. An example with a deeper layout, like `coding-agents/<AGENT>`, needs its own globs in the root `workspaces` and `.gitignore`, and its parent folder in `tools/example.ts`.

`npm run check` type-checks each example with its own `tsconfig.json`. Inside the repository, npm links `@cloudflare/sandbox` to `packages/sandbox` when the example's pin equals the version in `packages/sandbox/package.json`, so the example type-checks against the package that `vp pack` just built. Otherwise npm installs the pinned version from the registry.

## Deploy an example

From a project created with `npm create cloudflare`, `npm run deploy` deploys the published package and the donor image that the example names.

From the repository, deploy with this repository's package and shim instead:

```sh
npm run example -- deploy <NAME>
```

`tools/example.ts` builds the package and, when the `Dockerfile` copies the shim, `sandbox-tools:local`. It deploys from a config written next to the example's own, `wrangler.local.json`, which bundles the package from `packages/sandbox/dist` and passes `SANDBOX_TOOLS_IMAGE=sandbox-tools:local` to the image build. Arguments after a second `--` go to `wrangler deploy`, such as `--secrets-file .secrets.json` for a first deploy with required secrets.

## Check it

1. Run `npm run check`.
2. Run `npm run examples:check-bundles` and `npm run example -- check-versions`. The first bundles each example with the local package and fails unless the bundle took the package from `packages/sandbox/dist`. The second fails unless every example pins the same exact version and every `Dockerfile` that copies the shim defaults to the donor image of that version.
3. Run `npm run example -- check-standalone <NAME>`. It copies the example's files out of the repository, as `npm create cloudflare` does, installs them from npm, runs `tsc`, and bundles the Worker without building its image. Without a name it checks every example except the coding agents, which need `coding-agents/shared`.
4. Deploy the example and follow its README step by step, as described in [Testing](testing.md#test-in-production). Delete the deployment afterwards.
5. If a docs page covers the same job, link the example from that page's related resources when the designs match. When they differ, link it from the page where the difference is useful, such as a migration page, and say how it differs.

Done when every README step gives the response it describes.
