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

2. **`@repo/shared` (packages/shared/)** - Shared utilities
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

# E2E tests (requires Docker)
npm run test:e2e

# Run a single E2E test file
npm run test:e2e -- -- tests/e2e/process-lifecycle-workflow.test.ts

# Run a specific test within a file
npm run test:e2e -- -- tests/e2e/git-clone-workflow.test.ts -t 'test name'
```

**Important**: E2E tests share a single sandbox container for performance. Tests run in parallel using unique sessions for isolation.

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

**Critical:** Docker image version MUST match npm package version. This is enforced via `ARG SANDBOX_VERSION` in Dockerfile.

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
- **Shared sandbox**: All tests share ONE container, using sessions for isolation
- **In CI**: Tests deploy to actual Cloudflare infrastructure
- **Locally**: Global setup spawns wrangler dev once, all tests share it
- Config: `vitest.e2e.config.ts` (root level)
- Parallel execution via thread pool (~30s for full suite)
- See `docs/E2E_TESTING.md` for writing tests

**Build system trust:** The monorepo build system (turbo + npm workspaces) is robust and handles all package dependencies automatically. E2E tests always run against the latest built code - there's no need to manually rebuild or worry about stale builds unless explicitly working on the build setup itself.

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

**Subject line should stand alone** - don't require reading the body to understand the change. Body is optional and only needed for non-obvious context.

**Focus on the change, not how it was discovered** - never reference "review feedback", "PR comments", or "code review" in commit messages. Describe what the change does and why, not that someone asked for it.

**Avoid bullet points** - write prose, not lists. If you need bullets to explain a change, you're either committing too much at once or over-explaining implementation details. The body should be a brief paragraph, not a changelog.

Good examples:

```
Add session isolation for concurrent executions
```

```
Fix encoding parameter handling in file operations

The encoding parameter wasn't properly passed through the validation
layer, causing base64 content to be treated as UTF-8.
```

Bad examples:

```
Update files

Changes some things related to sessions and also fixes a bug.
```

```
Add file operations support

Implements FileClient with read/write methods and adds FileService
in the container with a validation layer. Includes comprehensive test
coverage for edge cases and supports both UTF-8 text and base64 binary
encodings. Uses proper error handling with custom error types from the
shared package for consistency across the SDK.
```

### Code Comments

**Write comments for future readers, not for the current conversation.**

Comments should describe the current state of the code. A developer reading the code months later won't have context about bugs that were fixed, conversations that happened, or previous implementations.

**Don't reference historical context:**

```typescript
// Bad: references a bug the reader knows nothing about
// Uses character tracking to avoid the bug where indexOf('') returns wrong position

// Bad: implies something was wrong before
// Start the server with proper WebSocket typing

// Bad: "prevent" implies there was a problem to prevent
// Assign synchronously to prevent race conditions
```

**Do describe current behavior and design intent:**

```typescript
// Good: describes what the code does now
// Returns parsed events and any remaining unparsed content

// Good: explains design rationale without historical context
// Assigned synchronously so concurrent callers share the same connection attempt

// Good: explains a non-obvious implementation choice
// Uses IIFE to ensure promise exists before any await points
```

**When in doubt:** If your comment includes phrases like "to avoid", "to fix", "to prevent", "instead of", or "properly" - reconsider whether you're describing current behavior or referencing something that no longer exists.

## Important Patterns

### Error Handling

- Custom error classes in `packages/shared/src/errors/`
- Errors flow from container → Sandbox DO → Worker
- Use `ErrorCode` enum for consistent error types

### Logging

**Pattern**: Explicit logger passing via constructor injection throughout the codebase.

```typescript
class MyService {
  constructor(private logger: Logger) {}

  async doWork() {
    const childLogger = this.logger.child({ operation: 'work' });
    childLogger.info('Working', { context });
  }
}
```

**Configuration**: `SANDBOX_LOG_LEVEL` (debug|info|warn|error) and `SANDBOX_LOG_FORMAT` (json|pretty) env vars, read at startup.

**Testing**: Use `createNoOpLogger()` from `@repo/shared` in tests.

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

### API Design

When adding or modifying SDK methods:

- Use clear, descriptive names that indicate what the method does
- Validate inputs before passing to container APIs
- Provide helpful error messages with context

Note: Container isolation is handled at the Cloudflare platform level (VMs), not by SDK code.

## Version Management & Releases

### Creating Changesets

**Important:** Changeset files should only reference `@cloudflare/sandbox`, never `@repo/shared` or `@repo/sandbox-container`. These internal packages should not be versioned independently - changes to them flow through the public package. Pre-commit hooks and CI will validate this rule.

**Write for end users.** Changeset descriptions appear in GitHub releases - they're user-facing documentation, not internal notes. Focus on the problem solved and the benefit, not technical implementation details. Include how to enable or use the feature when applicable.

```markdown
# Bad - technical/internal focused

Add WebSocket transport for request multiplexing over a single connection

# Good - user-focused with clear benefit and usage

Add WebSocket transport to avoid sub-request limits in Workers and Durable Objects.
Enable with `useWebSocket: true` in sandbox options.
```

**Releases are fully automated** via GitHub Actions (`.github/workflows/release.yml`) and changesets (`.changeset/`):

- **Changesets**: Create a `.changeset/your-feature-name.md` file to document changes affecting published packages (see PR process above)
- **Beta releases**: Published automatically on every push to main (`@beta` tag on npm)
- **Stable releases**: When changesets exist, the "Version Packages" PR is auto-created. Merging it triggers:
  1. Version bump in `package.json`
  2. Docker image build and push to Docker Hub (linux/amd64 architecture only to match production)
  3. npm package publish with updated version
- **Version synchronization**: Docker image version always matches npm package version (enforced via `ARG SANDBOX_VERSION` in Dockerfile)
- **Architecture**: Images are built for linux/amd64 only, matching Cloudflare's production container runtime. ARM Mac users will automatically use emulation (Rosetta/QEMU) for local development, ensuring perfect dev/prod parity.

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
