# Stable releases

How to cut and finish a stable Sandbox SDK release.

## Overview

Merging a **Version Packages** PR to `main` starts the release. CI creates the container images, git tag, GitHub Release, and binary assets before publishing the npm package directly to `latest` as the final release mutation. It then opens a **promotion** PR that updates Docker image pins in the repo. The release workflow stops after creating or updating that promotion PR. Once promotion is merged, a later push to `main` can open the next Version Packages PR when there are new changesets.

If a run fails partway through, retrying the same version is usually safe: CI fills in missing pieces and will not replace artifacts that already exist with different content.

## What to merge

| Order | Pull request                    | Review focus                           | After merge                                            |
| ----- | ------------------------------- | -------------------------------------- | ------------------------------------------------------ |
| 1     | Feature work (with a changeset) | Normal code review                     | No release until versions are bumped                   |
| 2     | **Version Packages**            | Version numbers and changelog          | CI publishes the release, then opens **promote/x.y.z** |
| 3     | **promote/x.y.z**               | Docker image pins in examples and docs | In-repo references match the published images          |

Do not bump example Docker tags by hand as part of releasing. The promotion PR owns those updates.

Examples and `bridge/worker` depend on `"@cloudflare/sandbox": "*"`. That is intentional for monorepo development; it is not a published version pin.

## When version x.y.z is complete

- `@cloudflare/sandbox@x.y.z` is on npm (`latest` points at it when it is the newest stable)
- Public container images are tagged `x.y.z`
- Git tag `@cloudflare/sandbox@x.y.z` exists
- GitHub Release for that version exists (including binary assets)
- The promotion PR is merged so in-repo Docker pins reference `x.y.z`

If packages and images are published but promotion is not merged yet, the release itself is out; only repository references still need to catch up.

## Checklist

1. Land work with changesets as you go.
2. Merge the **Version Packages** PR when you are ready to release.
3. Watch the **Release** workflow on `main` in GitHub Actions.
4. Open the **promote/x.y.z** PR CI created (if any).
5. Merge promotion after its checks pass.
6. Stop. The next Version Packages PR shows up on a later `main` run when new changesets exist.

## Automatic and manual runs

- **Automatic:** pushes to `main` may run the stable release workflow.
- **Manual:** **Reconcile stable release** in Actions uses the same rules when you need to finish or retry a version without waiting for another push. Successful reconciliation of the current release also creates or updates the promotion PR; historical reconciliation does not move repository references backward.

Only one stable release or reconcile run proceeds at a time on `main`; others queue. Queued runs are normal.

## If something fails

Retry the same version first: re-run the failed workflow, or start **Reconcile stable release** for that version.

| Situation                                                  | Likely meaning                                   | Action                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Failed during publish                                      | Transient error or incomplete progress           | Retry the same version                                                                   |
| npm version exists but `latest` points to an older version | npm publishing completed without tag promotion   | A maintainer must run the exact `npm dist-tag add` command reported by CI, then retry    |
| npm package exists but the matching git tag does not       | Broken or half-finished release identity         | Investigate before publishing again; do not skip ahead to a new version to paper over it |
| Conflict, unexpected image digest, or wrong tag target     | An existing artifact does not match this release | Investigate; CI will not overwrite mismatched immutable artifacts                        |
| Promote PR is open and there is no new Version Packages PR | Normal sequencing                                | Merge promote (or confirm refs already match)                                            |
| Workflows stuck in the queue                               | Another release or reconcile is running          | Wait, or cancel an abandoned older run in Actions                                        |

Prefer finishing the current version over cutting a new one to clear a stuck state.

## Prereleases

The `next` branch and privileged PR workflows publish prerelease channels. They do not advance stable `latest` or open promotion PRs. Use the stable flow above for production releases.

## Changing release automation

After editing release workflows or scripts under `.github/`:

```bash
npm run test:release-tools
```

Script and workflow layout: [`.github/release-tooling.md`](../.github/release-tooling.md).
