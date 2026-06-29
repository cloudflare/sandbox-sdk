# GitHub Release Tooling

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

## Release orchestrator

`release-orchestrator.ts` models the desired release state for stable and prerelease artifacts. For stable releases, Changesets still creates Version Packages PRs with changelog and version-file updates, while the orchestrator publishes and verifies npm, Docker Hub, CF Registry Library, GitHub Release, and binary assets. The backfill workflow also converges the full stable desired state, except npm publish is skipped; it resolves the release commit from the existing release tag and requires an explicit release commit SHA before creating a missing tag. For prereleases, the orchestrator publishes and verifies the npm prerelease dist-tag, Docker Hub tags, CF Registry Library tags, and optional moving Docker aliases. Reruns converge missing artifacts instead of depending on whether npm was newly published in the current workflow attempt.
