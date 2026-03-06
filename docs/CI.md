# CI/CD Pipeline

How CI works in this repository. For architecture context, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Pipeline Architecture

All CI runs through **reusable workflows** composed by orchestrator files:

```
pr.yml / release.yml (orchestrators)
  ├── reusable-build.yml      JS build + Docker bake (6 images)
  ├── reusable-quality.yml    Lint, typecheck, unit tests (3 parallel jobs)
  └── reusable-e2e.yml        Deploy test workers + 3 parallel test suites
```

Additional workflows: `cleanup.yml` (PR-close + daily sweep), `performance.yml` (on-demand benchmarks).

### PR Pipeline

```
detect-changes ──→ build ──→ quality (3 jobs)  ──→ gate
                     │                               ↑
                     └──→ e2e (deploy + 3 jobs) ─────┘
                     └──→ publish-preview ───────────┘
```

The `gate` job is the single required status check for branch protection. It aggregates results from all upstream jobs, failing if any required job failed or was cancelled.

### Release Pipeline

On push to `main`: build → quality + e2e → publish-release (npm + Docker Hub + GitHub Release).

No content-addressed skipping on release — everything runs fresh every time.

## Optimization Layers

Four layers minimize redundant work on PRs:

### Layer 0: Path-Based Filtering

`dorny/paths-filter@v3` in the `detect-changes` job categorizes changed files:

| Category        | Paths                                           |
| --------------- | ----------------------------------------------- |
| `shared`        | `packages/shared/src/**`                        |
| `sdk`           | `packages/sandbox/src/**`                       |
| `container`     | `packages/sandbox-container/src/**`             |
| `docker-config` | `Dockerfile`, `docker-bake.hcl`, `.bun-version` |
| `build-config`  | `turbo.json`, `tsconfig*`, `biome.json`         |
| `e2e-tests`     | `tests/e2e/**`                                  |
| `deps`          | `package-lock.json`                             |
| `changesets`    | `.changeset/**`                                 |
| `workflows`     | `.github/workflows/**`                          |

Derived conditions control which jobs run:

- **`needs-docker`**: shared, container, docker-config, deps, **workflows**
- **`needs-e2e`**: shared, sdk, container, docker-config, e2e-tests, deps, **workflows**
- **`needs-quality`**: shared, sdk, container, build-config, deps, **changesets**
- **`needs-sdk-tests`**: shared, sdk, build-config, deps
- **`needs-container-tests`**: shared, container, build-config, deps

Workflow changes always trigger Docker + E2E (can't validate pipeline changes without running them).

### Layer 1: Content-Addressed Docker Skip

Docker inputs (Dockerfile, bake config, container source, lockfile, .bun-version) are hashed into a `docker_hash`. Before building:

1. `crane digest` checks the CF registry for tag `ci-${docker_hash}`
2. **Hit**: `crane copy` retags existing images (~2s vs ~240s build)
3. **Miss**: Full `docker buildx bake` + push, then tag with `ci-${docker_hash}` for future runs

This works across PRs — if two PRs have identical Docker inputs, the second one skips the build entirely.

### Layer 2: Deploy Skip

Before deploying the E2E test worker:

1. `curl` the worker's `/health` endpoint
2. Compare the `deploy_hash` in the response against the expected hash
3. **Match**: Skip deploy entirely (~7s vs ~81s)
4. **Mismatch**: Full `wrangler deploy` + secret injection

The `deploy_hash` is a content hash of all deploy inputs (source, lockfile, image tag, worker config). It's injected as a worker secret and returned in the health response.

### Layer 3: Node Modules Cache

`actions/cache@v5` in the build job saves all `node_modules` directories (root + workspace-local):

```yaml
path: |
  node_modules
  packages/*/node_modules
  examples/*/node_modules
  sites/*/node_modules
key: node-modules-${{ hashFiles('package-lock.json') }}
```

Downstream jobs use `actions/cache/restore@v5` (restore-only, no redundant save attempts). On cache hit, `npm ci` is skipped entirely.

**Why workspace-local directories?** npm workspaces may place packages in workspace-specific `node_modules/` when peer dependency conflicts prevent hoisting (e.g., `@cloudflare/kumo` requires `zod@^4` but root has `zod@3` from astro). Caching only root `node_modules` would lose these packages.

## Docker Images

Six image variants built via `docker-bake.hcl`:

| Bake target  | CF registry name     | Docker Hub tag suffix | Purpose                        |
| ------------ | -------------------- | --------------------- | ------------------------------ |
| `default`    | `sandbox`            | _(none)_              | Base Ubuntu + Python + Node.js |
| `python`     | `sandbox-python`     | `-python`             | Extra Python packages          |
| `opencode`   | `sandbox-opencode`   | `-opencode`           | OpenCode tooling               |
| `musl`       | `sandbox-musl`       | `-musl`               | Alpine/musl variant            |
| `desktop`    | `sandbox-desktop`    | `-desktop`            | Desktop environment            |
| `standalone` | `sandbox-standalone` | _(CF only)_           | E2E test standalone image      |

All images share a common base stage. The `standalone` image is built separately (requires the base image to be pushed first) and is only used for E2E testing — it's not published to Docker Hub.

Build cache uses GHCR (`ghcr.io/${{ github.repository }}/cache`) with per-target cache refs.

## Workflows Reference

| File                   | Trigger               | Purpose                                                                           |
| ---------------------- | --------------------- | --------------------------------------------------------------------------------- |
| `pr.yml`               | Pull requests         | Orchestrates build → quality + e2e + preview → gate                               |
| `release.yml`          | Push to main          | Build → quality + e2e → npm publish + Docker Hub + GitHub Release                 |
| `reusable-build.yml`   | Called by pr/release  | JS build (`turbo run build`) + Docker bake with content-addressed skip            |
| `reusable-quality.yml` | Called by pr/release  | 3 parallel jobs: lint+typecheck, SDK unit tests, container unit tests             |
| `reusable-e2e.yml`     | Called by pr/release  | Deploy test workers + 3 parallel jobs: HTTP tests, WebSocket tests, browser tests |
| `cleanup.yml`          | PR close + daily cron | Delete PR-specific workers, images, DNS records; sweep stale resources            |
| `performance.yml`      | Manual dispatch       | Deploy perf worker + run benchmarks                                               |

## Local Development Hooks

[Lefthook](https://github.com/evilmartians/lefthook) runs automatically:

- **pre-commit**: Biome lint+format on staged files, changeset validation
- **pre-push**: Full TypeScript typecheck (`turbo run typecheck`)

## Running CI Checks Locally

```bash
npm run check          # Biome lint + typecheck (same as quality/lint-typecheck)
npm test               # All unit tests (same as quality/sdk-tests + container-tests)
npm run test:e2e       # E2E tests (requires Docker + deployed worker)
```

## Key Design Decisions

**Why reusable workflows?** Eliminates duplication between PR and release pipelines. Each reusable workflow is self-contained with clear inputs/outputs.

**Why `crane` instead of `docker pull/push`?** crane operates on registry manifests directly — retagging images without downloading layers. This makes content-addressed skip near-instant.

**Why GHCR for Docker build cache?** The CF container registry doesn't support standard Docker login, only `wrangler containers push`. GHCR supports the `type=registry` cache backend natively and is free for public repos.

**Why `actions/cache/restore` in downstream jobs?** Only the build job (first to finish) needs to save the cache. Downstream jobs only restore. Using the restore-only action avoids redundant save attempts that would be no-ops anyway.

**Why no Turborepo remote cache?** Turbo's remote cache requires either Vercel (not appropriate for a Cloudflare project) or a self-hosted server. The overhead isn't justified when our build step is already fast (~15s) and Docker skip handles the expensive part.
