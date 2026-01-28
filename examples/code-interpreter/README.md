# Code Interpreter with Workers AI

A Cloudflare Worker that gives the [gpt-oss model](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/) on Workers AI the ability to execute Python code using the Cloudflare Sandbox SDK.

## Features

- **Workers AI Integration**: Uses `@cf/openai/gpt-oss-120b` via the [workers-ai-provider](https://github.com/cloudflare/ai/tree/main/packages/workers-ai-provider) package
- **Vercel AI SDK**: Leverages `generateText()` and `tool()` for clean function calling
- **Sandbox Execution**: Python code runs in isolated Cloudflare Sandbox containers

## How It Works

1. User sends a prompt to the `/run` endpoint
2. GPT-OSS receives the prompt with an `execute_python` tool
3. Model decides if Python execution is needed
4. Code runs in an isolated Cloudflare Sandbox container
5. Results are sent back to the model for final response

## API Endpoint

```bash
POST /run
Content-Type: application/json

{
  "input": "Your prompt here"
}
```

## Example Usage

```bash
# Simple calculation
curl -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -d '{"input": "Calculate 5 factorial using Python"}'

# Execute specific code
curl -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -d '{"input": "Execute this Python: print(sum(range(1, 101)))"}'

# Complex operations
curl -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -d '{"input": "Use Python to find all prime numbers under 20"}'
```

## Setup

1. From the project root:

```bash
npm install
npm run build
```

2. Run locally:

```bash
cd examples/code-interpreter
npm run dev
```

> **Note:** First run builds the Docker container (2-3 minutes). Subsequent runs are much faster.

## Deploy

```bash
npx wrangler deploy
```

> **Wait for provisioning:** After first deployment, wait 2-3 minutes before making requests.
