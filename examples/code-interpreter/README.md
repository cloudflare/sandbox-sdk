# Cloudflare GPT-OSS with Python Sandbox

A Cloudflare Worker that integrates the GPT-OSS model with Python code execution capabilities using the Cloudflare Sandbox SDK.

## Features

- ✅ **GPT-OSS Model Integration**: Uses Cloudflare's `@cf/openai/gpt-oss-120b` model via direct API calls
- ✅ **Python Code Execution**: Executes Python code in a secure sandboxed environment
- ✅ **Function Calling**: Implements function calling to bridge the model with code execution
- ✅ **Type Safety**: Full TypeScript support with OpenAI SDK types
- ✅ **Container-based Isolation**: Runs Python in Docker containers via Durable Objects

## How It Works

1. **Initial Request**: User sends a prompt to the Worker
2. **Model Processing**: GPT-OSS model receives the prompt with an `execute_python` function tool
3. **Function Detection**: Model decides if Python execution is needed
4. **Code Execution**: Python code runs in an isolated Cloudflare Sandbox container
5. **Result Integration**: Execution results are sent back to the model
6. **Final Response**: Model generates a response incorporating the execution results

## API Endpoint

```bash
POST /foo
Content-Type: application/json

{
  "input": "Your prompt here"
}
```

## Example Usage

```bash
# Simple calculation
curl -X POST http://localhost:8787/foo \
  -H "Content-Type: application/json" \
  -d '{"input": "Calculate 5 factorial using Python"}'

# Execute specific code
curl -X POST http://localhost:8787/foo \
  -H "Content-Type: application/json" \
  -d '{"input": "Execute this Python: print(sum(range(1, 101)))"}'

# Complex operations
curl -X POST http://localhost:8787/foo \
  -H "Content-Type: application/json" \
  -d '{"input": "Use Python to find all prime numbers under 20"}'
```

## Setup

1. From the project root, run
```bash
npm install
npm run build
```

2. In this directory, create `.dev.vars` file with your Cloudflare credentials:
```
CLOUDFLARE_API_KEY=your_api_key_here
CLOUDFLARE_ACCOUNT_ID=your_account_id_here
```

3. Run locally:
```bash
cd examples/code-interpreter # if you're not already here
npm run dev
```

## Notes & Limitations

- The openai SDK currently throws an error when using this model with workers AI, so REST API is used instead
- Calling the tool `code_interpreter`, akin to OpenAI's `code_interpreter` tool type currently throws an error; so the tool is setup as 'execute_python' function instead
