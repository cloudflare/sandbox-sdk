# Testing

This page explains how to check a change before you commit it: what each command runs, what it proves, and what it cannot prove.

## Before you start

- Node.js 24.11 or later. Run `npm install` in the repository root.
- Docker with BuildKit. The shim builds for `linux/amd64`, so on an Arm machine Docker needs amd64 emulation.
- If your network inspects TLS, set `SANDBOX_EXTRA_CA` to a CA bundle that trusts it. Image builds pass the bundle as a BuildKit secret, so it never becomes part of an image. Without the variable, builds work as before.

Done when `npm install` finishes and `docker info` succeeds.

## Check every change

Run both commands before each commit:

```sh
npm run check
npm test
```

`npm run check` runs:

1. `vp pack`, which builds the package into `packages/sandbox/dist`.
2. `vp check`, which formats, lints, and type-checks the TypeScript. The lint rules include the anti-slop rules in `tools/oxlint/anti-slop`. Fix what they report instead of adding a suppression.
3. `knip`, which finds unused files, exports, and dependencies.
4. `shim:check`, described below.

`npm test` runs the package's unit tests with `vp test`, then `shim:check` again. Integration tests skip themselves unless you turn them on.

Done when both commands exit with code `0`.

To run one test file while you work:

```sh
npx vp test run packages/sandbox/tests/read-file.test.ts
```

### Unit tests

The unit tests in `packages/sandbox/tests` run in Node.js, not in workerd. They give the package test doubles instead of a container: `helpers.ts` builds shim frames and fake processes, `worker-test-doubles.ts` provides Worker runtime objects such as `ExecutionContext`, and `cloudflare-workers.ts` stands in for the `cloudflare:workers` module. The lint rules forbid module mocking, so pass doubles in through constructors and parameters.

### Shim checks

`npm run shim:check` builds the `verify` target of `images/sandbox-tools/Dockerfile` for `linux/amd64`. Each stage fails the build when its check fails:

1. `cargo fmt --check`, `cargo clippy` with warnings as errors, and `cargo test`. The tests include `crates/sandbox-tools/tests/shim.rs`, which runs the built binary as a subprocess.
2. A static release build of `sandbox-shim`.
3. The contract test, `packages/sandbox/tests/shim-contract.test.mjs`. It runs the real package code against the compiled shim through a stand-in for `exec()` that spawns local processes, so the Rust and TypeScript sides of the protocol are tested together.
4. Checks that the binary is a 64-bit x86-64 ELF with no interpreter and no shared library dependencies.

The Rust tests run inside the Linux build, so Linux-specific behavior is tested even on a Mac. Run `cargo test` on the host only for quick feedback.

## Before a release

`npm run test:release` runs everything below and `npm test`. Each part can also run on its own.

| Command                     | What it proves                                                                                                                                                     | Needs                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `npm run test:package`      | The built package exports the expected runtime API. It also prints the files that `npm pack` would publish.                                                        | Nothing extra                 |
| `npm run test:s3-e2e`       | `S3Gateway` authorizes, signs, and forwards the requests that a real `s3fs` sends to MinIO for reads, writes, renames, directories, multipart uploads, and deletes | Docker, privileged containers |
| `npm run test:s3-lifecycle` | The shim mounts, reuses, inspects, denies, retries, and unmounts a real `s3fs` mount                                                                               | Docker, privileged containers |

The S3 tests start MinIO and an `s3fs` container, and reach services on the host through `host.docker.internal`. They remove the containers, networks, and images they create when they finish.

`npm run test:s3-native-local` runs the full mount lifecycle under `wrangler dev`. It is not part of `test:release`, because it needs Wrangler and workerd builds that are not released yet. Set `SANDBOX_WRANGLER_PATH` and `MINIFLARE_WORKERD_PATH` to local checkouts that contain the commits listed in `packages/sandbox/tests/s3-native-local.integration.test.ts`.

## Test in production

Local tests cannot show everything a deployed sandbox does. Under `wrangler dev`, the container has Docker's short hostname instead of the 64-character hostname of a deployed container, non-root users have no Linux capabilities, and reloading the Worker destroys the container instead of leaving it running. Deploy an example when a change depends on behavior like this.

1. Log in with `npx wrangler login`, and set `CLOUDFLARE_ACCOUNT_ID` if your login has more than one account.
2. Deploy the example:

   ```sh
   npm run example:workspace:deploy
   ```

   The deploy scripts build `sandbox-tools:local` first when the example uses the shim, and use the Wrangler version pinned in `package.json`.

3. Follow the `curl` steps in the example's README. If your account puts `workers.dev` behind Cloudflare Access, add the header `cf-access-token: $(cloudflared access token -app=<WORKER_URL>)` to each request.
4. Delete what you deployed. `npx wrangler delete --name <WORKER_NAME>` deletes the Worker. At Wrangler 4.137.0, Wrangler cannot delete the container application of a Durable Object, so delete it with the Containers API: request `GET /accounts/<ACCOUNT_ID>/containers/applications/<ID>` and check that the name is yours, then send `DELETE` to the same path. Delete by exact name or ID, never by a pattern.

Done when the README's steps give the expected responses and the Worker and container application are gone.

Workers Observability records each request, log, and exception, which helps when a step fails. A Durable Object invocation marked `canceled` is often a client that disconnected, not a failure in the container.
