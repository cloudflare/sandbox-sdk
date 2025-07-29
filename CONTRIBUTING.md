# Contributing to Cloudflare Sandbox SDK

Thank you for your interest in contributing to the Cloudflare Sandbox SDK! This guide will help you get started with the contribution process.

## 🚀 Quick Start

```bash
# Fork and clone the repository
git clone https://github.com/your-username/sandbox-sdk.git
cd sandbox-sdk

# Install dependencies and build
npm install
npm run build

# Verify your setup
npm run test:unit
```

## 📋 Before You Contribute

### Prerequisites
- Node.js 18+ with npm
- Docker Desktop (for container testing)
- Git
- Familiarity with TypeScript and Vitest

### Understanding the Codebase
**New to the codebase?** Start with our comprehensive documentation:

- **[📖 docs/README.md](./docs/README.md)** - Documentation overview and navigation
- **[🏗️ docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** - Understand how we built the SDK
- **[👨‍💻 docs/DEVELOPER_GUIDE.md](./docs/DEVELOPER_GUIDE.md)** - Step-by-step development workflows
- **[🧪 docs/TESTING.md](./docs/TESTING.md)** - Comprehensive testing guide

## 🛠️ Types of Contributions

### 🐛 Bug Fixes
1. Check existing issues or create a new one
2. Read [docs/DEVELOPER_GUIDE.md](./docs/DEVELOPER_GUIDE.md) for development workflow
3. Write tests that reproduce the bug
4. Fix the issue following our code patterns
5. Ensure all tests pass: `npm test`

### ✨ New Features
1. **Discuss first** - Open an issue to discuss the feature
2. Review [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) to understand our design
3. Follow our feature development pattern in [docs/DEVELOPER_GUIDE.md](./docs/DEVELOPER_GUIDE.md):
   - Add client method → container endpoint → service logic → tests
4. Update documentation as needed

### 🧪 Tests & Coverage
1. Review [docs/TESTING.md](./docs/TESTING.md) for our 4-tier testing strategy
2. Follow our testing patterns:
   - **Container services**: Test `ServiceResult<T>` patterns (`container_src/`)
   - **Client SDK**: Test direct response interfaces with error throwing (`src/clients/`)
3. Maintain 90%+ line coverage and 85%+ branch coverage
4. Test at the appropriate tier (unit/integration/container/e2e)

### 📚 Documentation
1. Technical docs go in `/docs` folder
2. Follow our contributor-focused language patterns
3. Include practical examples from the actual codebase
4. Update the docs index in [docs/README.md](./docs/README.md)

## 🔄 Development Workflow

### 1. **Setup Your Branch**
```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/issue-description
```

### 2. **Development Process**
```bash
# Fast feedback during development
npm run test:unit:watch

# Test specific changes
npm run test:container  # For service layer changes
npm run test:integration  # For client-container changes

# Quality checks
npm run typecheck
npm run check
```

### 3. **Before Submitting**
```bash
# Run full test suite
npm test

# Check coverage
npm run test:coverage

# Build for distribution
npm run build
```

## 📝 Pull Request Process

### 1. **PR Title & Description**
- Use conventional commit format: `feat:`, `fix:`, `docs:`, `test:`
- Reference any related issues: "Fixes #123"
- Describe what you changed and why

### 2. **Code Review Checklist**
- [ ] All tests pass (`npm test`)
- [ ] Code follows our patterns (see [docs/DEVELOPER_GUIDE.md](./docs/DEVELOPER_GUIDE.md))
- [ ] New features include comprehensive tests
- [ ] Documentation updated if needed
- [ ] No breaking changes (or clearly documented)

### 3. **Review Process**
- PRs require approval from maintainers
- Address feedback promptly
- Keep PRs focused and reasonably sized
- Squash commits before merging

## 🏗️ Code Standards

### Architecture Patterns
- **Container Service Layer**: Always return `ServiceResult<T>` for business logic (`container_src/`)
- **Client SDK Layer**: Use direct response interfaces with error throwing (`src/clients/`)
- **Error Handling**: Container errors mapped to custom client exceptions
- **Security**: Use `SecurityService` for all input validation in container layer
- **Testing**: Write tests at the appropriate tier (see [docs/TESTING.md](./docs/TESTING.md))

### Code Style
- TypeScript strict mode enabled
- Use existing patterns for consistency
- Follow dependency injection patterns
- Include appropriate logging with context

### Security Guidelines
- Always validate user inputs through `SecurityService`
- Never execute user input directly
- Use allowlists for commands and URLs
- Prevent path traversal attacks

## 🐛 Reporting Issues

### Bug Reports
Include:
- Clear description of the issue
- Steps to reproduce
- Expected vs actual behavior
- Environment details (Node.js version, OS, etc.)
- Relevant logs or error messages

### Feature Requests
Include:
- Clear use case description
- Proposed API design (if applicable)
- Consider how it fits with our architecture
- Discuss alternatives you've considered

## 🤝 Getting Help

### Resources
- **Technical Questions**: Review [docs/](./docs/) for comprehensive guides
- **Implementation Patterns**: See existing code examples in test suites
- **Architecture Questions**: Check [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- **Development Workflow**: Follow [docs/DEVELOPER_GUIDE.md](./docs/DEVELOPER_GUIDE.md)

### Community
- Open an issue for discussion
- Reference specific docs sections in your questions
- Include relevant code examples

## 📄 License

By contributing to this project, you agree that your contributions will be licensed under the same license as the project.

---

**Ready to contribute?** Start by exploring our [documentation](./docs/) to understand the codebase, then pick an issue or propose a new feature!