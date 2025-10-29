# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Documentation Resources

**Always consult the Cloudflare Docs MCP when working on this repository.** The MCP provides comprehensive documentation about:

- API usage patterns and examples
- Architecture concepts and best practices
- Configuration reference (wrangler, Dockerfile)
- Troubleshooting guides
- Production deployment requirements

Use the MCP tools (e.g., `mcp__cloudflare-docs__search_cloudflare_documentation`) to search for specific topics before making changes.

**Exa MCP is available for code search.** Use the exa-code tool when you need real-world code examples or patterns from GitHub repositories, documentation, or Stack Overflow to inform your implementation decisions and avoid hallucinations.

**Always use the `gh` CLI for GitHub interactions.** When you need to access GitHub issues, PRs, repository information, or any GitHub-related data, use the gh CLI tool (e.g., `gh issue view`, `gh pr view`, `gh repo view`) instead of trying to fetch GitHub URLs directly. The CLI provides structured, reliable output and better access to GitHub data.

## Project Overview

The Cloudflare Sandbox SDK enables secure, isolated code execution in containers running on Cloudflare. The SDK allows Workers to execute arbitrary commands, manage files, run background processes, and expose services.

**Status**: Open Beta - API is stable but may evolve based on feedback. Safe for production use.

## Architecture

### Three-Layer Architecture

1. **`@cloudflare/sandbox` (packages/sandbox/)** - Public SDK exported to npm
   - `Sandbox` class: Durable Object that manages the container lifecycle
   - Client architecture: Modular HTTP clients for different capabilities (CommandClient, FileClient, ProcessClient, etc.)
   - `CodeInterpreter`: High-level API for running Python/JavaScript with structured outputs
   - `proxyToSandbox()`: Request handler for preview URL routing

2. **`@repo/shared` (packages/shared/)** - Shared types and error system
   - Type definitions shared between SDK and container runtime
   - Centralized error handling and logging utilities
   - Not published to npm (internal workspace package)

3. **`@repo/sandbox-container` (packages/sandbox-container/)** - Container runtime
   - Bun-based HTTP server running inside Docker containers
   - Dependency injection container (`core/container.ts`)
   - Route handlers for command execution, file operations, process management
   - Not published to npm (bundled into Docker image)

### Key Flow

Worker → Sandbox DO → Container HTTP API (port 3000) → Bun runtime → Shell commands/File system

## Development Commands

### Building

```bash
npm run build              # Build all packages (uses turbo)
npm run build:clean        # Force rebuild without cache
```

### Testing

```bash
# Unit tests (runs in Workers runtime with vitest-pool-workers)
npm test

# E2E tests (requires Docker, runs sequentially due to container provisioning)
npm run test:e2e

# Run a single E2E test file
npm run test:e2e -- -- tests/e2e/process-lifecycle-workflow.test.ts

# Run a specific test within a file
npm run test:e2e -- -- tests/e2e/git-clone-workflow.test.ts -t 'test name'
```

**Important**: E2E tests (`tests/e2e/`) run sequentially (not in parallel) to avoid container resource contention. Each test spawns its own wrangler dev instance.

### Code Quality

```bash
npm run check              # Run Biome linter + typecheck
npm run fix                # Auto-fix linting issues + typecheck
npm run typecheck          # TypeScript type checking only
```

### Docker

Docker builds are typically **automated via CI**, but you can build locally for testing:

```bash
npm run docker:rebuild     # Rebuild container image locally (includes clean build + Docker)
```

**Note:** Docker images are automatically built and published by CI (`release.yml`):

- Beta images on every main commit
- Stable images when "Version Packages" PR is merged
- Multi-arch builds (amd64, arm64) handled by CI

**Critical:** Docker image version MUST match npm package version (`@cloudflare/sandbox@0.4.7` → `cloudflare/sandbox:0.4.12`). This is enforced via `ARG SANDBOX_VERSION` in Dockerfile.

### Development Server

From an example directory (e.g., `examples/minimal/`):

```bash
npm run dev                # Start wrangler dev server (builds Docker on first run)
```

**Local development gotcha**: When testing port exposure with `wrangler dev`, the Dockerfile must include `EXPOSE` directives for those ports. Without `EXPOSE`, you'll see "Connection refused: container port not found". This is only required for local dev - production automatically makes all ports accessible.

## Development Workflow

**Main branch is protected.** All changes must go through pull requests. The CI pipeline runs comprehensive tests on every PR - these MUST pass before merging.

### Pull Request Process

1. Make your changes

2. **Run code quality checks after any meaningful change:**

   ```bash
   npm run check    # Runs Biome linter + typecheck
   ```

   This catches type errors that often expose real issues with code changes. Fix any issues before proceeding.

3. **Run unit tests to verify your changes:**

   ```bash
   npm test
   ```

4. Create a changeset if your change affects published packages:

   Create a new file in `.changeset/` directory (e.g., `.changeset/your-feature-name.md`):

   ```markdown
   ---
   '@cloudflare/sandbox': patch
   ---

   Brief description of your change
   ```

   Use `patch` for bug fixes, `minor` for new features, `major` for breaking changes.

5. Push your branch and create a PR

6. **CI runs automatically:**
   - **Unit tests** for `@cloudflare/sandbox` and `@repo/sandbox-container`
   - **E2E tests** that deploy a real test worker to Cloudflare and run integration tests
   - Both test suites MUST pass

7. After approval and passing tests, merge to main

8. **Automated release** (no manual intervention):
   - Changesets action creates a "Version Packages" PR when changesets exist
   - Merging that PR triggers automated npm + Docker Hub publishing
   - Beta releases published on every main commit
   - Stable releases published when changesets are merged

## Testing Architecture

**Tests are critical** - they verify functionality at multiple levels and run on every PR.

**Development practice:** After making any meaningful code change:

1. Run `npm run check` to catch type errors (these often expose real issues)
2. Run `npm test` to verify unit tests pass
3. Run E2E tests if touching core functionality

### Unit Tests

Run these frequently during development:

```bash
# All unit tests
npm test

# Specific package
npm test -w @cloudflare/sandbox          # SDK tests (Workers runtime)
npm test -w @repo/sandbox-container      # Container runtime tests (Bun)
```

**Architecture:**

- **SDK tests** (`packages/sandbox/tests/`) run in Workers runtime via `@cloudflare/vitest-pool-workers`
- **Container tests** (`packages/sandbox-container/tests/`) run in Bun runtime
- Mock container for isolated testing (SDK), no Docker required
- Fast feedback loop for development

**Known issue:** Sandbox unit tests may hang on exit due to vitest-pool-workers workerd shutdown issue. This is cosmetic - tests still pass/fail correctly.

### E2E Tests

Run before creating PRs to verify end-to-end functionality:

```bash
# All E2E tests (requires Docker)
npm run test:e2e

# Single test file
npm run test:e2e -- -- tests/e2e/process-lifecycle-workflow.test.ts

# Single test within a file
npm run test:e2e -- -- tests/e2e/git-clone-workflow.test.ts -t 'should handle cloning to default directory'
```

**Architecture:**

- Tests in `tests/e2e/` run against real Cloudflare Workers + Docker containers
- **In CI**: Tests deploy to actual Cloudflare infrastructure and run against deployed workers
- **Locally**: Each test file spawns its own `wrangler dev` instance
- Config: `vitest.e2e.config.ts` (root level)
- Sequential execution (`singleFork: true`) to prevent container resource contention
- Longer timeouts (2min per test) for container operations

**CI behavior:** E2E tests in CI (`pullrequest.yml`):

1. Build Docker image locally (`npm run docker:local`)
2. Deploy test worker to Cloudflare with unique name (pr-XXX)
3. Run E2E tests against deployed worker URL
4. Cleanup test deployment after tests complete

## Client Architecture Pattern

The SDK uses a modular client pattern in `packages/sandbox/src/clients/`:

- **BaseClient**: Abstract HTTP client with request/response handling
- **SandboxClient**: Aggregates all specialized clients
- **Specialized clients**: CommandClient, FileClient, ProcessClient, PortClient, GitClient, UtilityClient, InterpreterClient

Each client handles a specific domain and makes HTTP requests to the container's API.

## Container Runtime Architecture

The container runtime (`packages/sandbox-container/src/`) uses:

- **Dependency Injection**: `core/container.ts` manages service lifecycle
- **Router**: Simple HTTP router with middleware support
- **Handlers**: Route handlers in `handlers/` directory
- **Services**: Business logic in `services/` (CommandService, FileService, ProcessService, etc.)
- **Managers**: Stateful managers in `managers/` (ProcessManager, PortManager)

Entry point: `packages/sandbox-container/src/index.ts` starts Bun HTTP server on port 3000.

## Monorepo Structure

Uses npm workspaces + Turbo:

- `packages/sandbox`: Main SDK package
- `packages/shared`: Shared types
- `packages/sandbox-container`: Container runtime
- `examples/`: Working example projects
- `tooling/`: Shared TypeScript configs

Turbo handles task orchestration (`turbo.json`) with dependency-aware builds.

## Coding Standards

### TypeScript

**Never use the `any` type** unless absolutely necessary (which should be a final resort):

- First, look for existing types that can be reused appropriately
- If no suitable type exists, define a proper type in the right location:
  - Shared types → `packages/shared/src/types.ts` or relevant subdirectory
  - SDK-specific types → `packages/sandbox/src/clients/types.ts` or appropriate client file
  - Container-specific types → `packages/sandbox-container/src/` with appropriate naming
- Use the newly defined type everywhere appropriate for consistency
- This ensures type safety and catches errors at compile time rather than runtime

### Git Commits

**Follow the 7 rules for great commit messages** (from https://cbea.ms/git-commit/):

1. **Separate subject from body with a blank line**
2. **Limit the subject line to 50 characters**
3. **Capitalize the subject line**
4. **Do not end the subject line with a period**
5. **Use the imperative mood in the subject line** (e.g., "Add feature" not "Added feature")
6. **Wrap the body at 72 characters**
7. **Use the body to explain what and why vs. how**

**Be concise, not verbose.** Every word should add value. Avoid unnecessary details about implementation mechanics - focus on what changed and why it matters.

Example:

```
Add session isolation for concurrent executions

Previously, multiple concurrent exec() calls would interfere with each
other's working directories and environment variables. This adds proper
session management to isolate execution contexts.

The SessionManager tracks active sessions and ensures cleanup when
processes complete. This is critical for multi-tenant scenarios where
different users share the same sandbox instance.
```

## Important Patterns

### Error Handling

- Custom error classes in `packages/shared/src/errors/`
- Errors flow from container → Sandbox DO → Worker
- Use `ErrorCode` enum for consistent error types

### Logging

- Centralized logger from `@repo/shared`
- Structured logging with component context
- Configurable via `SANDBOX_LOG_LEVEL` and `SANDBOX_LOG_FORMAT` env vars

### Session Management

- Sessions isolate execution contexts (working directory, env vars, etc.)
- Default session created automatically
- Multiple sessions per sandbox supported

### Port Management

- Expose internal services via preview URLs
- Token-based authentication for exposed ports
- Automatic cleanup on sandbox sleep
- **Production requirement**: Preview URLs require custom domain with wildcard DNS (\*.yourdomain.com)
  - `.workers.dev` domains do NOT support the subdomain patterns needed for preview URLs
  - See Cloudflare docs for "Deploy to Production" guide when ready to expose services

## Version Management & Releases

**Releases are fully automated** via GitHub Actions (`.github/workflows/release.yml`) and changesets (`.changeset/`):

- **Changesets**: Create a `.changeset/your-feature-name.md` file to document changes affecting published packages (see PR process above)
- **Beta releases**: Published automatically on every push to main (`@beta` tag on npm)
- **Stable releases**: When changesets exist, the "Version Packages" PR is auto-created. Merging it triggers:
  1. Version bump in `package.json`
  2. Docker image build and push to Docker Hub (multi-arch: amd64, arm64)
  3. npm package publish with updated version
- **Version synchronization**: Docker image version always matches npm package version (enforced via `ARG SANDBOX_VERSION` in Dockerfile)

**SDK version tracked in**: `packages/sandbox/src/version.ts`

## Container Base Image

The container runtime uses Ubuntu 22.04 with:

- Python 3.11 (with matplotlib, numpy, pandas, ipython)
- Node.js 20 LTS
- Bun 1.x runtime (powers the container HTTP server)
- Git, curl, wget, jq, and other common utilities

When modifying the base image (`packages/sandbox/Dockerfile`), remember:

- Keep images lean - every MB affects cold start time
- Pin versions for reproducibility
- Clean up package manager caches to reduce image size
