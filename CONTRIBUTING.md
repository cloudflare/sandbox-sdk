# Contributing to Cloudflare Sandbox SDK

Thank you for your interest in contributing to the Cloudflare Sandbox SDK! This guide will help you get started with development.

## Development Setup

### Prerequisites

- Node.js 18+ and npm
- Docker (for container development)
- Bun (install from https://bun.sh)
- A Cloudflare account (for testing in production)

### Initial Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/cloudflare/sandbox-sdk
   cd sandbox-sdk
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Install container dependencies**

   The container source has its own dependencies that need to be installed for TypeScript checking:
   ```bash
   cd packages/sandbox/container_src && bun install && cd -
   ```

   > **Note**: This step is required for TypeScript to properly check the container source files. Without it, you'll see errors about missing modules like `@jupyterlab/services` and `uuid`.

4. **Build the project**
   ```bash
   npm run build
   ```

5. **Run type checking and linting**
   ```bash
   npm run check
   ```

### Project Structure

```
sandbox-sdk/
├── packages/
│   └── sandbox/              # Main SDK package
│       ├── src/              # SDK source code
│       ├── container_src/    # Container runtime code (uses Bun)
│       └── Dockerfile        # Container image definition
├── examples/
│   └── basic/                # Example implementation
├── scripts/                  # Build and development scripts
└── package.json             # Workspace configuration
```

### Development Workflow

1. **Making Changes**
   - The SDK code is in `packages/sandbox/src/`
   - Container runtime code is in `packages/sandbox/container_src/`
   - Example code is in `examples/basic/`

2. **Running Tests**
   ```bash
   npm test
   ```

3. **Type Checking**
   ```bash
   npm run typecheck
   ```

4. **Linting**
   ```bash
   npm run check
   ```

5. **Building**
   ```bash
   npm run build
   ```

### Testing Locally

To test the SDK locally with the example (ensure you've completed the development setup):

1. **Navigate to the example directory**
   ```bash
   cd examples/basic
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the development server**
   ```bash
   npm start
   ```

4. **Open your browser**
   Navigate to the URL shown in the terminal (typically `http://localhost:8787`)

### Container Development

The container source (`container_src/`) uses Bun as its runtime and has separate dependencies:

- Uses `bun.lock` for dependency management
- Requires `bun install` for installing dependencies
- Dependencies are installed inside Docker during build, but also needed locally for TypeScript

### Common Issues

1. **TypeScript errors about missing modules**
   - Make sure you've run `cd packages/sandbox/container_src && bun install`
   - This installs the container dependencies needed for type checking

2. **Port exposure errors in local development**
   - Ensure your Dockerfile includes `EXPOSE` directives for required ports
   - See the README for details on local development port requirements

3. **Build failures**
   - Run `npm run clean` to clear build artifacts
   - Ensure Docker is running for container builds

### Submitting Changes

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Write clear, concise commit messages
   - Add tests for new functionality
   - Update documentation as needed

3. **Run all checks**
   ```bash
   npm run check
   npm test
   ```

4. **Submit a pull request**
   - Provide a clear description of your changes
   - Reference any related issues
   - Ensure all CI checks pass

### Code Style

- We use TypeScript for all code
- Follow the existing code style (enforced by Biome)
- Use meaningful variable and function names
- Add JSDoc comments for public APIs

### Questions?

If you have questions or need help:
- Open an issue on GitHub
- Join our [Discord community](https://discord.gg/cloudflaredev)
- Check existing issues and pull requests

Thank you for contributing!
