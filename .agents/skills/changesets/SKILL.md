---
name: changesets
description: Use when creating a changeset, preparing a release, or bumping versions. Covers which packages to reference, how to write user-facing changeset descriptions, the release automation flow, and the npm/Docker version sync requirement. (project)
---

# Changesets & Releases

This repository uses [changesets](https://github.com/changesets/changesets) to create Version Packages PRs and maintain changelog/version files. Stable and prerelease artifact publishing are handled by the release orchestrator. Create a changeset whenever your change affects published packages.

## Creating a Changeset

A changeset should be created when there is a change that is observable to a consumer of the
`@cloudflare/sandbox` package. This includes:

- Changes to the API surface area, new methods, deprecations or removals.
- Changes to the performance or security characteristics of the SDK.
- Bug fixes that are user visible.

Create a new file in `.changeset/` (e.g. `.changeset/your-feature-name.md`):

```markdown
---
'@cloudflare/sandbox': patch
---

Brief description of your change
```

### Rules

**Only reference `@cloudflare/sandbox`.** Never list `@repo/shared` or `@repo/sandbox-container` — those are internal workspace packages and must not be versioned independently. Changes to them flow through the public package. Pre-commit hooks and CI enforce this.

**Use `patch` for almost everything.** The SDK is in beta:

- `patch` — all normal changes (features, fixes, refactors)
- `minor` — breaking changes only
- `major` — never

## Writing the Description

**Important:** Changeset files should only reference `@cloudflare/sandbox`, never `@repo/shared` or `@repo/sandbox-container`. These internal packages should not be versioned independently - changes to them flow through the public package. Pre-commit hooks and CI will validate this rule.

**Important: Write for end users.** Changeset descriptions appear in GitHub releases - they're user-facing documentation, not internal notes.

- Focus on the problem solved and the benefit, not technical implementation details.
- Keep it short. Each changeset entry should aim to be a couple of sentences, no more than a single paragraph.
- Include a code example showing how to enable or use the feature when applicable.

```markdown
# Bad - technical/internal focused

Add WebSocket transport for request multiplexing over a single connection

# Good - user-focused with clear benefit and usage

Add WebSocket transport to avoid sub-request limits in Workers and Durable Objects.
Enable with `useWebSocket: true` in sandbox options.
```

## Release Automation

Releases run via `.github/workflows/release.yml`. There is no manual publishing step.

1. Merge a PR that contains a changeset.
2. The Changesets action opens (or updates) a **"Version Packages"** PR.
3. Merging the Version Packages PR triggers the stable release workflow.
4. The release orchestrator publishes and verifies the npm package, Docker Hub images, CF Registry public library images, GitHub Release, and standalone binary assets.
5. Prerelease workflows also publish through the release orchestrator, which verifies the npm dist-tag, Docker Hub images, CF Registry public library images, and optional moving Docker aliases before succeeding.
6. Release workflow reruns converge missing artifacts, so Docker images, GitHub releases, binaries, and prerelease aliases are not gated on npm being newly published in the current attempt.

## Version Synchronization

**Docker image version MUST match the npm package version.** This is enforced via `ARG SANDBOX_VERSION` in `packages/sandbox/Dockerfile`. Don't try to release them out of band.

- SDK version is tracked in `packages/sandbox/src/version.ts`
- Images build for `linux/amd64` only, matching Cloudflare's production runtime (ARM Macs use Rosetta/QEMU locally, preserving dev/prod parity)
- Images publish to both Docker Hub and `registry.cloudflare.com/library/sandbox:{version}` (with `-python`, `-opencode`, `-musl` variants). Any authenticated Cloudflare customer can pull from the `library/` namespace without our account ID.

## Checklist

- [ ] Filename in `.changeset/` is descriptive (`fix-stream-encoding.md`, not `patch.md`)
- [ ] Only `@cloudflare/sandbox` is listed
- [ ] Bump type is `patch` (or `minor` for breaking changes)
- [ ] Description explains the user-visible problem and benefit
- [ ] Usage hint is included when relevant (flag name, option, method)
