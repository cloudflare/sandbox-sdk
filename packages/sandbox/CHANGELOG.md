# @cloudflare/sandbox

## 1.0.2

### Patch Changes

- [#1001](https://github.com/cloudflare/sandbox-sdk/pull/1001) [`2d458d1`](https://github.com/cloudflare/sandbox-sdk/commit/2d458d190843a1f62881e4f9d4ed959b1e98d531) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix `Files.readFile()` hanging forever when the container sends file bytes before the opening control frame. The read now completes however the container transport orders the two streams.

## 1.0.1

### Patch Changes

- [#949](https://github.com/cloudflare/sandbox-sdk/pull/949) [`ab97179`](https://github.com/cloudflare/sandbox-sdk/commit/ab971797917bfbebe26c58f96cfd939fc563f64f) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Pin Zod 4.6.5, the version that Workers tooling such as `@cloudflare/vitest-plugin` pins, so a project that installs both installs one copy of Zod instead of two.

## 1.0.0

### Major Changes

1.0.0 is a ground-up rewrite. Your Durable Object extends `DurableObject` and runs its container through the native `ctx.container` API. The package adds `Files`, `S3Mount` and `DirectoryBackup` for the work the platform doesn't do itself. Application images copy the `sandbox-shim` helper from `docker.io/cloudflare/sandbox:1.0.0`.

Moving from 0.12 is a migration, not a version bump. See [Migrate from 0.x](https://developers.cloudflare.com/sandbox/sdk/migrate/). The [Sandbox docs](https://developers.cloudflare.com/sandbox/) and the [API reference](https://developers.cloudflare.com/sandbox/reference/) cover 1.x.

## 0.x

The [0.x changelog](https://github.com/cloudflare/sandbox-sdk/blob/v0/packages/sandbox/CHANGELOG.md) on the `v0` branch covers every release before 1.0.0.
