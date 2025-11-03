# Contributing to Cloudflare Sandbox SDK

Thank you for your interest in contributing to the Cloudflare Sandbox SDK! This guide will help you get started.

## Getting Started

### Prerequisites

- Node.js 24+
- Bun (latest)
- Docker (for E2E tests)
- Git

### Setup

1. Fork the repository to your GitHub account
2. Clone your fork:

   ```bash
   git clone https://github.com/YOUR-USERNAME/sandbox-sdk.git
   cd sandbox-sdk
   ```

3. Install dependencies:

   ```bash
   npm install
   ```

4. Build the packages:

   ```bash
   npm run build
   ```

5. Run tests:
   ```bash
   npm test
   ```

## Development Workflow

### Making Changes

1. Create a new branch for your changes:

   ```bash
   git checkout -b feat/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

2. Make your changes following our coding standards (see CLAUDE.md)

3. Run code quality checks:

   ```bash
   npm run check    # Linting + type checking
   npm run fix      # Auto-fix linting issues
   ```

4. Run tests:
   ```bash
   npm test         # Unit tests
   npm run test:e2e # E2E tests (requires Docker)
   ```

### Commit Message Guidelines

Follow the [7 rules for great commit messages](https://cbea.ms/git-commit/):

1. Separate subject from body with a blank line
2. Limit the subject line to 50 characters
3. Capitalize the subject line
4. Do not end the subject line with a period
5. Use the imperative mood ("Add feature" not "Added feature")
6. Wrap the body at 72 characters
7. Use the body to explain what and why vs. how

Example:

```
Add session isolation for concurrent executions

Previously, multiple concurrent exec() calls would interfere with each
other's working directories and environment variables. This adds proper
session management to isolate execution contexts.
```

### Creating a Changeset

Before submitting a PR, create a changeset if your change modifies any published packages:

```bash
npx changeset
```

This will interactively guide you through:

1. Selecting which packages to include
2. Choosing the semantic version bump (`patch`, `minor`, or `major`)
3. Writing a description of your changes

Use semantic versioning:

- `patch`: Bug fixes, minor improvements
- `minor`: New features, non-breaking changes
- `major`: Breaking changes

The changeset bot will comment on your PR if a changeset is needed.

## Submitting a Pull Request

1. Push your branch to your fork:

   ```bash
   git push origin feat/your-feature-name
   ```

2. Open a pull request from your fork to `cloudflare/sandbox-sdk:main`

3. Fill out the PR template with:
   - Description of your changes
   - Motivation and context
   - How you tested the changes
   - Screenshots (if applicable)

### Review Process

A maintainer will review your PR and may:

- Request changes
- Ask questions
- Suggest improvements
- Approve and merge

Please be patient and responsive to feedback. We aim to review PRs within a few days.

## Code Style

We use Biome for linting and formatting. Key guidelines:

- Use TypeScript for all code
- Avoid `any` type - define proper types
- Write concise, readable code
- Add comments for complex logic
- Follow patterns in existing code

## Testing

### Unit Tests

Located in `packages/*/tests/`:

- Test individual components in isolation
- Mock external dependencies
- Fast feedback loop

Run with: `npm test`

### E2E Tests

Located in `tests/e2e/`:

- Test full workflows against real Workers and containers
- Require Docker
- Slower but comprehensive

Run with: `npm run test:e2e`

You can also run specific test files or individual tests:

```bash
# Run a single E2E test file
npm run test:e2e -- -- tests/e2e/process-lifecycle-workflow.test.ts

# Run a specific test within a file
npm run test:e2e -- -- tests/e2e/git-clone-workflow.test.ts -t 'should handle cloning to default directory'
```

### Writing Tests

- Write tests for new features
- Add regression tests for bug fixes
- Ensure tests are deterministic (no flaky tests)
- Use descriptive test names

## Documentation

- Update README.md if you change public APIs
- Add JSDoc comments to public functions
- Update CLAUDE.md if you change architecture or conventions

## Questions?

- Open an issue for bug reports or feature requests
- Start a discussion for questions or ideas
- Check existing issues and discussions first

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
