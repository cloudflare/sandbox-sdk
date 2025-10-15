# Cloudflare Sandbox SDK

**Build secure, isolated code execution environments on Cloudflare's edge network.**

The Sandbox SDK lets you run untrusted code safely in isolated containers. Execute commands, manage files, run background processes, and expose services — all from your Workers applications.

Perfect for AI code execution, interactive development environments, data analysis platforms, CI/CD systems, and any application that needs secure code execution at the edge.

## Installation

```bash
npm install @cloudflare/sandbox
```

## Quick Example

```typescript
import { getSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const sandbox = getSandbox(env.Sandbox, 'user-123');

    // Execute Python code
    const result = await sandbox.exec('python3 -c "print(2 + 2)"');

    return Response.json({
      output: result.stdout,
      exitCode: result.exitCode
    });
  }
};
```

## Documentation

**📖 [Full Documentation](https://developers.cloudflare.com/sandbox/)**

- [Get Started Guide](https://developers.cloudflare.com/sandbox/get-started/) - Step-by-step tutorial
- [API Reference](https://developers.cloudflare.com/sandbox/api/) - Complete API docs
- [Guides](https://developers.cloudflare.com/sandbox/guides/) - Execute commands, manage files, expose services
- [Examples](https://developers.cloudflare.com/sandbox/tutorials/) - AI agents, data analysis, CI/CD pipelines

## Key Features

- **Secure Isolation** - Each sandbox runs in its own container
- **Edge-Native** - Runs on Cloudflare's global network
- **Code Interpreter** - Execute Python and JavaScript with rich outputs
- **File System Access** - Read, write, and manage files
- **Command Execution** - Run any command with streaming support
- **Preview URLs** - Expose services with public URLs
- **Git Integration** - Clone repositories directly

## Development

This repository contains the SDK source code. To contribute:

```bash
# Clone the repo
git clone https://github.com/cloudflare/sandbox-sdk
cd sandbox-sdk

# Install dependencies
npm install

# Run tests
npm test

# Build the project
npm run build

# Type checking and linting
npm run check
```

## Examples

See the [examples directory](./examples) for complete working examples:

- [Minimal](./examples/minimal) - Basic sandbox setup
- [Code Interpreter](./examples/code-interpreter) - Use sandbox as an interpreter tool with gpt-oss
- [Complete](./examples/basic) - Huge example integrated with every sandbox feature

## Status

**Beta** - The SDK is in active development. APIs may change before v1.0.

## License

[MIT License](LICENSE)

## Links

- [Documentation](https://developers.cloudflare.com/sandbox/)
- [GitHub Issues](https://github.com/cloudflare/sandbox-sdk/issues)
- [Developer Discord](https://discord.cloudflare.com)
- [Cloudflare Developers](https://twitter.com/CloudflareDev)
