# TypeScript Validator Example

**Shows how to use Sandbox SDK to provide build tools that Workers don't include.**

Workers execute JavaScript and WASM instantly, but don't include build tools like npm or bundlers. This example demonstrates using Sandbox SDK to bundle npm dependencies in a container, then loading the output into a Dynamic Worker for execution. Dynamic Workers let you load and run user-provided code at runtime without redeploying—enabling interactive experiences like this playground.

## The Problem

Workers are designed to execute JavaScript and WebAssembly instantly. They don't include build tools:

- npm (can't install dependencies at runtime)
- Bundlers (esbuild, webpack, rollup)
- Compilers (rustc, emscripten, TinyGo)

## The Solution

Sandbox SDK provides build tools in isolated containers. Workers execute the output:

1. **Build once**: Run npm install + esbuild in a container
2. **Execute many times**: Load the bundle into Workers
3. **Rebuild only when needed**: Cache output until code changes

## How It Works

**User writes TypeScript with npm dependency:**

```typescript
import { z } from 'zod';

export const schema = z.object({
  name: z.string().min(1),
  email: z.string().email()
});
```

**Sandbox SDK bundles the npm dependency:**

- Writes code to container
- Runs `esbuild --bundle` to inline zod dependency
- Returns bundled JavaScript

**Dynamic Worker executes the bundled code:**

- Loads bundle into isolate
- Runs validation instantly
- Reuses same bundle until schema changes

## Getting Started

### Prerequisites

- Docker running locally
- Node.js 16.17.0+
- Cloudflare account (for deployment)

### Local Development

```bash
npm install
npm run dev
```

Visit http://localhost:8787 and:

1. Write a TypeScript schema using zod
2. Provide test data as JSON
3. Click "Validate"

**First validation**: Bundles npm dependencies with Sandbox SDK
**Subsequent validations**: Instant (uses cached bundle)

### Deployment

```bash
npm run deploy
```

> **Note:** Dynamic Workers are in closed beta. [Sign up here](https://forms.gle/MoeDxE9wNiqdf8ri9)

## Beyond This Example

This pattern works for any build step:

**npm dependencies**: Bundle JavaScript libraries (this example)
**Native code to WASM**: Compile Rust/C++/Go with rustc/emscripten/TinyGo
**Custom builds**: Run webpack, rollup, or custom toolchains

Sandbox SDK provides the build environment. Workers execute the output.

## Architecture

```
User Code (with npm dependencies)
    ↓ Sandbox SDK (build tools in container)
JavaScript Bundle
    ↓ Workers (execute in isolate)
Result
```

## Learn More

- [Sandbox SDK Docs](https://developers.cloudflare.com/sandbox/)
- [Dynamic Workers Docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)
