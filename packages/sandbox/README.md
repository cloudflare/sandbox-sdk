<img width="1362" height="450" alt="Image" src="https://github.com/user-attachments/assets/6f770ae3-0a14-4d2b-9aed-a304ee5446c5" />

# Cloudflare Sandbox SDK

[![npm version](https://img.shields.io/npm/v/@cloudflare/sandbox)](https://www.npmjs.com/package/@cloudflare/sandbox)
[![npm downloads](https://img.shields.io/npm/dw/@cloudflare/sandbox)](https://www.npmjs.com/package/@cloudflare/sandbox)

**Build secure, isolated code execution environments on Cloudflare.**

The Sandbox SDK lets you run untrusted code safely in isolated containers. Execute commands, manage files, run background processes, and expose services — all from your Workers applications.

Perfect for AI code execution, interactive development environments, data analysis platforms, CI/CD systems, and any application that needs secure code execution at the edge.

## Getting Started

### Prerequisites

1. Install [Node.js](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) (version 16.17.0 or later)
2. Ensure Docker is running locally ([see setup guide](https://developers.cloudflare.com/sandbox/get-started/#ensure-docker-is-running-locally))
3. For deploying to production, sign up for a [Cloudflare account](https://dash.cloudflare.com/sign-up/workers-and-pages)

### 1. Create a new project

Create a new Sandbox SDK project using the minimal template:

```bash
npm create cloudflare@latest -- my-sandbox --template=cloudflare/sandbox-sdk/examples/minimal
cd my-sandbox
```

### 2. Test locally

Start the development server:

```bash
npm run dev
```

> **Note:** First run builds the Docker container (2-3 minutes). Subsequent runs are much faster.

Test the endpoints:

```bash
# Execute Python code
curl http://localhost:8787/run

# File operations
curl http://localhost:8787/file
```

### 3. Deploy to production

Deploy your Worker and container:

```bash
npx wrangler deploy
```

> **Wait for provisioning:** After first deployment, wait 2-3 minutes before making requests.

**📖 [View the complete getting started guide](https://developers.cloudflare.com/sandbox/get-started/)** for detailed instructions and explanations.

## Quick API Example

```typescript
import { getSandbox, proxyToSandbox, type Sandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Required for preview URLs
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, 'my-sandbox');

    // Execute Python code
    if (url.pathname === '/run') {
      const result = await sandbox.exec('python3 -c "print(2 + 2)"');
      return Response.json({ output: result.stdout, success: result.success });
    }

    // Work with files
    if (url.pathname === '/file') {
      await sandbox.writeFile('/workspace/hello.txt', 'Hello, Sandbox!');
      const file = await sandbox.readFile('/workspace/hello.txt');
      return Response.json({ content: file.content });
    }

    return new Response('Try /run or /file');
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

## Contributing

We welcome contributions from the community! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on:

- Setting up your development environment
- Creating pull requests
- Code style and testing requirements

## Development

This repository contains the SDK source code. Quick start:

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

- [Minimal](./examples/minimal) - Start here: exec commands, read/write files
- [Code Interpreter](./examples/code-interpreter) - Give [gpt-oss](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/) on Workers AI a Python REPL
- [Claude Code](./examples/claude-code) - Run [Claude Code](https://claude.ai/code) headless on any repo
- [OpenAI Agents](./examples/openai-agents) - `Shell` and `Editor` tools for [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/)
- [OpenCode](./examples/opencode) - [OpenCode](https://github.com/sst/opencode) web UI or [SDK](https://opencode.ai/docs/sdk/) in a sandbox
- [TypeScript Validator](./examples/typescript-validator) - Build with npm in sandbox, execute in [isolates](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)

## Status

**Beta** - The SDK is in active development. APIs may change before v1.0.

## License

[Apache License 2.0](LICENSE)

## Links

- [Documentation](https://developers.cloudflare.com/sandbox/)
- [GitHub Issues](https://github.com/cloudflare/sandbox-sdk/issues)
- [Developer Discord](https://discord.cloudflare.com)
- [Cloudflare Developers](https://twitter.com/CloudflareDev)
