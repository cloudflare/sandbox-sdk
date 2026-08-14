# GitHub Release Tooling

Operator guide for cutting stable releases: [docs/RELEASE.md](../docs/RELEASE.md).

Release workflows keep orchestration in YAML and shared release mechanics in small scripts:

- `install-crane.sh` installs `crane` for image copying.
- `login-release-registries.sh` logs in to Docker Hub and the Cloudflare registry.
- `publish-sandbox-images.sh` copies sandbox image variants from the internal Cloudflare registry to public release tags.
- `release-orchestrator.ts` publishes and verifies stable npm, Docker, CF Registry Library, GitHub Release, and binary assets, plus prerelease npm and Docker channel artifacts.
- `release.yml` uses Changesets to create Version Packages PRs and the release orchestrator to publish stable artifacts.
- `reusable-prerelease.yml` uses the release orchestrator to publish and verify prerelease npm dist-tags, Docker Hub images, CF Registry Library images, and moving Docker aliases.
- `prerelease-channel.ts` computes and applies prerelease channel versions.

Run the targeted release-tooling tests when changing these scripts or release publishing workflow blocks:

```bash
npm run test:release-tools
```

These tests are a focused release-tooling check. The default `npm test` path stays scoped to workspace unit tests.

## Stable release engine

Stable release runs use one inspect/plan/apply/reinspect engine. The engine is
rooted in a detached `releaseRoot` at the exact `releaseSHA`; release-owned
files, including `docker-images.txt`, package metadata, changelog text, Docker
inputs, and binary asset inputs, are read from that root. Local npm preparation
happens in a temporary directory and publishes the tarball validated by
`npm pack --json`.

If an immutable artifact already matches, the engine reuses it. If an artifact
is missing, the engine creates only that missing state. If a Git tag, Docker
digest, GitHub Release tag, npm identity, local export, source image, or binary
asset conflicts, the run fails before remote mutation. After applying missing
state, the engine performs a fresh inspection and requires a complete matching
release before promotion can start. Current releases publish npm directly to
`latest` as the final mutation so trusted publishing does not require a
separate authenticated dist-tag update. If the version already exists while
`latest` is behind, CI reports the maintainer command required before retrying.

Promotion is a separate current-main worktree transition. A run that creates or
updates `promote/<version>` stops; Changesets runs only on a later `main` push
where promotion reports `no-edits`.

## Prerelease orchestrator

For prereleases, `release-orchestrator.ts` publishes and verifies the npm
prerelease dist-tag, Docker Hub tags, CF Registry Library tags, and optional
moving Docker aliases. Reruns converge missing artifacts instead of depending
on whether npm was newly published in the current workflow attempt.
