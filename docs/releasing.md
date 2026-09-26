# Releasing

This page explains how a maintainer publishes a version of `@cloudflare/sandbox`: what a release publishes, how to run it, and what to do when a run fails.

## What a release publishes

The `Release` workflow (`.github/workflows/release.yml`) publishes three things with the same version:

| What                                             | Where                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `@cloudflare/sandbox@<VERSION>`, with provenance | npm. A stable version gets the `latest` dist-tag. A prerelease version gets its prerelease name: `1.1.0-rc.0` gets `rc`. |
| `cloudflare/sandbox:<VERSION>`                   | Docker Hub. The donor image from the `image` target of `images/sandbox-tools/Dockerfile`, for `linux/amd64`.             |
| `@cloudflare/sandbox@<VERSION>`                  | An annotated Git tag on the released commit.                                                                             |

The package and the image share a version because application images copy the shim from the donor image whose tag matches the installed package. See [Shim protocol](shim-protocol.md#versioning). The workflow pushes the image before it publishes the package, so a published package always has its image.

For a stable version, the workflow also replaces the Docker Hub description with `images/sandbox-tools/DOCKER_HUB.md`. A failure there does not fail the run.

## Before you start

- You can run workflows in `cloudflare/sandbox-sdk`.
- The npm package's trusted publisher names the repository `cloudflare/sandbox-sdk` and the workflow `release.yml`. The workflow has no npm token, so npm accepts the publish only through that trusted publisher. Check it in the package's settings on npmjs.com.
- The repository has the secrets `DOCKER_HUB_USERNAME` and `DOCKER_HUB_ACCESS_TOKEN`, for an account that can push to `cloudflare/sandbox` and edit its description.

## Release a version

1. On a branch, set `version` in `packages/sandbox/package.json` and `crates/sandbox-tools/Cargo.toml`. Run `npm install` and `cargo update --workspace`, so `package-lock.json` and `Cargo.lock` have the same version.
2. For a stable version, update `examples/minimal`, the template for `npm create cloudflare`:
   - set the tag in `SANDBOX_TOOLS_IMAGE` in its `Dockerfile` to the new version;
   - set the `@cloudflare/sandbox` range in its `package.json` to `^<VERSION>`.
3. Merge the change to `main`. The workflow releases a stable version only from `main`. A prerelease can release from any branch, so you can push its change to a branch instead.
4. Run the workflow with the version. The workflow checks that it equals the version in `packages/sandbox/package.json`:

   ```sh
   gh workflow run release.yml --repo cloudflare/sandbox-sdk --ref main -f version=<VERSION>
   gh run watch --repo cloudflare/sandbox-sdk
   ```

   For a prerelease from another branch, pass that branch as `--ref`. The workflow refuses a version that is already on npm, and a prerelease version without a prerelease name to use as the dist-tag, such as `1.1.0-1`. Before it publishes anything, it runs `npm run check` and `npm run test:release`, described in [Testing](testing.md).

5. For a stable version, change the donor image tag in the Sandbox docs to the new version. The Dockerfiles on those pages copy the shim from `docker.io/cloudflare/sandbox:<VERSION>`. They live in `cloudflare/cloudflare-docs`, under `src/content/docs/sandbox/`.

Done when all of these succeed:

```sh
npm view @cloudflare/sandbox@<VERSION> dist.attestations.provenance
docker buildx imagetools inspect docker.io/cloudflare/sandbox:<VERSION>
git ls-remote --exit-code --tags origin "refs/tags/@cloudflare/sandbox@<VERSION>"
```

## When a run fails

What to do depends on the last step that succeeded:

- **Before `Push the donor image`:** nothing is published. Fix the cause, merge the fix, and run the workflow again.
- **`Push the donor image` succeeded and `Publish to npm` failed:** only the image is published. Fix the cause and run the workflow again. The new run pushes the image again from the new commit, under the same tag.
- **`Publish to npm` succeeded and `Tag the release` failed:** the release is published, and the workflow refuses to run again for that version. Tag the commit that the run checked out, then push the tag:

  ```sh
  git tag --annotate --message "@cloudflare/sandbox@<VERSION>" "@cloudflare/sandbox@<VERSION>" <COMMIT>
  git push origin "refs/tags/@cloudflare/sandbox@<VERSION>"
  ```

npm never accepts a version number twice, even after an unpublish. To correct a published release, release a new version.
