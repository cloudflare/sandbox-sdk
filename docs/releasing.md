# Releasing

This page explains how a change reaches a release of `@cloudflare/sandbox`: how to describe it, how a maintainer publishes it, and what to do when a run fails.

## Describe a change

Add a changeset to each pull request that changes what users get from the package or its donor image:

```sh
npx changeset
```

Pick `@cloudflare/sandbox` and the bump, then write the summary. The command writes it to a Markdown file under `.changeset/`. Commit that file with the change.

- **patch**: a fix, or a change that keeps every existing program working.
- **minor**: a new API or option.
- **major**: a change that existing programs must adapt to.

The summary becomes the change's entry in `packages/sandbox/CHANGELOG.md` and in the GitHub release notes, with a link to the pull request and the author. Write it for someone who uses the package and never saw the pull request: say what changed for them, and what they need to do, if anything.

Leave out a changeset when nothing published changes, as for docs, tests, CI, examples, and templates. To describe a change that merged without one, add a changeset in a later pull request and start its summary with a `pr: <NUMBER>` line, so the entry links to the pull request that made the change.

## How a release happens

1. Each push to `main` runs the `Release` workflow (`.github/workflows/release.yml`). When changesets are pending, it opens or updates the **Version Packages** pull request. That pull request bumps the version in `packages/sandbox/package.json` and `crates/sandbox-tools/Cargo.toml`, adds the version's section to `CHANGELOG.md`, and deletes the changesets it used.
2. A code owner approves and merges the Version Packages pull request. That merge is the decision to release.
3. The push of the merge publishes the new version, because npm doesn't have it yet. Before it publishes anything, the workflow runs `npm run check` and `npm run test:release`, described in [Testing](testing.md).
4. After a stable release, the workflow opens a pull request that moves every example to the new version. It merges itself once a code owner approves it and the checks pass.

The Version Packages pull request and the examples pull request come from a GitHub App, so the pull request checks run on them.

## What a release publishes

The workflow publishes four things with the same version:

| What                                             | Where                                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cloudflare/sandbox@<VERSION>`, with provenance | npm. A stable version gets the `latest` dist-tag. A prerelease version gets its prerelease name: `1.1.0-rc.0` gets `rc`.                                                                                                  |
| `cloudflare/sandbox:<VERSION>`                   | Docker Hub. The donor image from the `image` target of `images/sandbox-tools/Dockerfile`, for `linux/amd64`.                                                                                                              |
| `@cloudflare/sandbox@<VERSION>`                  | An annotated Git tag on the released commit.                                                                                                                                                                              |
| `@cloudflare/sandbox@<VERSION>`                  | A GitHub release on that tag. A stable version takes the version's section of `CHANGELOG.md` as its notes and becomes the latest release. A prerelease lists the pull requests merged since the previous release instead. |

The package and the image share a version because application images copy the shim from the donor image whose tag matches the installed package. See [Shim protocol](shim-protocol.md#versioning). The workflow pushes the image before it publishes the package, so a published package always has its image.

For a stable version, the workflow also replaces the Docker Hub description with `images/sandbox-tools/DOCKER_HUB.md`. A failure there does not fail the run.

## Before you start

- The npm package's trusted publisher names the repository `cloudflare/sandbox-sdk` and the workflow `release.yml`. The workflow has no npm token, so npm accepts the publish only through that trusted publisher. Check it in the package's settings on npmjs.com.
- The repository has these secrets:
  - `DOCKER_HUB_USERNAME` and `DOCKER_HUB_ACCESS_TOKEN`, for an account that can push to `cloudflare/sandbox` and edit its description.
  - `APP_ID` and `APP_PRIVATE_KEY`, for the GitHub App that opens the Version Packages and examples pull requests. It needs write access to contents and pull requests.

## Release a version

1. Review the Version Packages pull request. Its description and its `CHANGELOG.md` change show the release notes. Edit a changeset on `main` to change them, and the workflow updates the pull request.
2. Approve and merge it, then follow the run:

   ```sh
   gh run watch --repo cloudflare/sandbox-sdk
   ```

3. Approve the pull request that moves the examples. If `main` moves before it merges, update its branch. Its Examples job installs each example from npm, so it passes only once npm serves the new version.
4. Change the donor image tag in the Sandbox docs to the new version. The Dockerfiles on those pages copy the shim from `docker.io/cloudflare/sandbox:<VERSION>`. They live in `cloudflare/cloudflare-docs`, under `src/content/docs/sandbox/`.

Done when all of these succeed:

```sh
npm view @cloudflare/sandbox@<VERSION> dist.attestations.provenance
docker buildx imagetools inspect docker.io/cloudflare/sandbox:<VERSION>
git ls-remote --exit-code --tags origin "refs/tags/@cloudflare/sandbox@<VERSION>"
gh release view "@cloudflare/sandbox@<VERSION>" --repo cloudflare/sandbox-sdk
```

## Publish a prerelease

A prerelease skips changesets and can release from any branch.

1. On a branch, set `version` in `packages/sandbox/package.json` and `crates/sandbox-tools/Cargo.toml` to the prerelease version, such as `1.1.0-rc.0`. Run `npm install` and `cargo update --workspace`, so `package-lock.json` and `Cargo.lock` have the same version. Push the branch.
2. Run the workflow on that branch:

   ```sh
   gh workflow run release.yml --repo cloudflare/sandbox-sdk --ref <BRANCH>
   gh run watch --repo cloudflare/sandbox-sdk
   ```

The workflow refuses a prerelease version without a prerelease name to use as the dist-tag, such as `1.1.0-1`. A prerelease changes no example.

## When a run fails

Re-run the run's failed jobs once the cause is gone, such as a flaky test or a registry outage. The publish job checks what npm, the tag, and the GitHub release already have, and does only the steps that are missing. Re-run the failed jobs rather than the whole run: a whole run plans again, and finds nothing to publish once npm has the version.

When the release needs a code change, merge the fix to `main`. The push publishes the version if npm doesn't have it yet. Once npm has a version, it cannot change: npm never accepts a version number twice, even after an unpublish. Add a changeset for the fix and release the next version instead.

When `Move the examples` fails and a re-run doesn't help, move them yourself: on a branch from `main`, run `npm run example -- set-version <VERSION>` and open a pull request.
