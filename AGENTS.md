# Cloudflare Sandbox SDK

This file provides guidance for AI coding assistants working with this repository.

## Documentation Resources

**Always consult Cloudflare documentation** when working on this repository. Key topics:

- API usage patterns and examples
- Architecture concepts and best practices
- Configuration reference (wrangler, Dockerfile)
- Troubleshooting guides
- Production deployment requirements

**Use the `gh` CLI for GitHub interactions.** When you need to access GitHub issues, PRs, repository information, or any GitHub-related data, use the gh CLI tool (e.g., `gh issue view`, `gh pr view`, `gh repo view`) instead of trying to fetch GitHub URLs directly.

## Project Overview

The Cloudflare Sandbox SDK enables secure, isolated code execution in containers running on Cloudflare. The SDK allows Workers to execute arbitrary commands, manage files, run background processes, and expose services.

**Status**: Open Beta — API is stable but may evolve based on feedback. Safe for production use.

For the three-layer architecture, request flow, client pattern, container runtime structure, and monorepo layout, see the **architecture** skill (`.agents/skills/architecture/SKILL.md`).

## Development Commands

### Building

```bash
npm run build              # Build all packages (uses turbo)
npm run build:clean        # Force rebuild without cache
```

### Testing

See the **testing** skill (`.agents/skills/testing/SKILL.md`) for detailed guidance on unit vs E2E tests.

```bash
npm test                                           # All unit tests
npm test -w @cloudflare/sandbox                    # SDK unit tests only
npm test -w @repo/sandbox-container                # Container unit tests only

npm run test:e2e                                   # All E2E tests (vitest + browser, requires Docker)
npm run test:e2e:vitest -- -- tests/e2e/file.ts   # Single vitest E2E file
npm run test:e2e:vitest -- -- tests/e2e/file.ts -t 'test name'  # Single vitest E2E test
npm run test:e2e:browser                           # Browser E2E tests only (Playwright)
```

**Note**: Use `test:e2e:vitest` when filtering tests. The `test:e2e` wrapper doesn't support argument passthrough.

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

For the release pipeline, npm/Docker version sync, and CF Registry publishing, see the **changesets** skill (`.agents/skills/changesets/SKILL.md`).

### Running Examples

For running, listing, and adding examples (and the `EXPOSE` directive note), see the **examples** skill (`.agents/skills/examples/SKILL.md`).

## Development Workflow

**Main branch is protected.** All changes must go through pull requests. The CI pipeline runs comprehensive tests on every PR — these MUST pass before merging.

### Pull Request Process

1. Make your changes.

2. **Run code quality checks after any meaningful change:**

   ```bash
   npm run check    # Biome linter + typecheck
   ```

   This catches type errors that often expose real issues. Fix them before proceeding.

3. **Run unit tests:**

   ```bash
   npm test
   ```

4. **Create a changeset** if your change affects published packages. See the **changesets** skill for rules (only `@cloudflare/sandbox`, user-facing descriptions, `patch` for almost everything).

5. Push your branch and open a PR.

6. **CI runs automatically:**
   - Unit tests for `@cloudflare/sandbox` and `@repo/sandbox-container`
   - E2E tests that deploy a real test worker to Cloudflare
   - Both suites MUST pass.

7. After approval and passing tests, merge to main.

8. **Automated release** (no manual intervention) — see the **changesets** skill.

## Coding Standards

See the **coding-standards** skill (`.agents/skills/coding-standards/SKILL.md`) for:

- The no-`any` rule and where to put new types
- Uppercase-acronym style guide (`SandboxRPCAPI`, `containerURL`, …)
- Code comment rules (no historical context)
- API design guidelines

For commits, see the **git-commit** skill (`.agents/skills/git-commit/SKILL.md`). Quick reference: imperative mood, ≤50 char subject, explain why not how, no bullet points.

## Important Patterns

### Error Handling

- Custom error classes in `packages/shared/src/errors/`
- Errors flow from container → Sandbox DO → Worker
- Use `ErrorCode` enum for consistent error types

### Logging

See the **logging** skill (`.agents/skills/logging/SKILL.md`) for the constructor-injection pattern, child loggers, env-var configuration (`SANDBOX_LOG_LEVEL`, `SANDBOX_LOG_FORMAT`), and test mocking with `createNoOpLogger()`.

### Session Management

- Top-level `sandbox.exec()` and `sandbox.startProcess()` are stateless.
- Explicit sessions isolate execution contexts (working directory, env vars, aliases, functions, etc.).
- Multiple explicit sessions per sandbox are supported.

### Port Management

- Expose internal services via preview URLs
- Token-based authentication for exposed ports
- Automatic cleanup on sandbox sleep
- **Production requirement**: Preview URLs require a custom domain with wildcard DNS (`*.yourdomain.com`). `.workers.dev` does NOT support the subdomain patterns needed.

## Releases

For changeset rules, the automated release pipeline, and Docker/npm version synchronization, see the **changesets** skill (`.agents/skills/changesets/SKILL.md`).
