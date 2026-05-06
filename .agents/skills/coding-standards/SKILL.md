---
name: coding-standards
description: Use when writing or reviewing TypeScript in this repo. Covers the no-`any` rule and where to put new types, the uppercase-acronym style guide, and the rules for code comments (no historical context). (project)
---

# Coding Standards

## TypeScript: No `any`

**Never use `any`** unless absolutely necessary — and that should be a final resort.

Process when you reach for `any`:

1. Look for an existing type that fits. Most domains already have one.
2. If no suitable type exists, define a proper one in the right location:
   - **Shared types** → `packages/shared/src/types.ts` or relevant subdirectory
   - **SDK-specific types** → `packages/sandbox/src/clients/types.ts` or the appropriate client file
   - **Container-specific types** → under `packages/sandbox-container/src/` with appropriate naming
3. Use the new type everywhere it applies — don't leave one-off shapes scattered around.

This catches errors at compile time instead of runtime and keeps the codebase consistent.

## Style: Uppercase Acronyms

When an acronym appears inside a camelCase or PascalCase identifier, keep it **fully uppercase**:

| ✅ Do             | ❌ Don't          |
| ----------------- | ----------------- |
| `SandboxRPCAPI`   | `SandboxRpcApi`   |
| `containerURL`    | `containerUrl`    |
| `parseHTTPHeader` | `parseHttpHeader` |
| `getAPIKey`       | `getApiKey`       |

Applies to all acronyms: API, URL, HTTP, RPC, SSE, SSH, DNS, ID, etc.

**Exception:** library-provided names keep their original casing (e.g. capnweb's `RpcTarget` stays `RpcTarget`).

## Code Comments

**Write comments for future readers, not for the current conversation.**

Comments should describe the current state of the code. A developer reading the code months later won't have context about bugs that were fixed, conversations that happened, or earlier implementations.

### Don't reference historical context

```typescript
// ❌ Bad: references a bug the reader knows nothing about
// Uses character tracking to avoid the bug where indexOf('') returns wrong position

// ❌ Bad: implies something was wrong before
// Start the server with proper WebSocket typing

// ❌ Bad: "prevent" implies there was a problem to prevent
// Assign synchronously to prevent race conditions
```

### Do describe current behavior and design intent

```typescript
// ✅ Good: describes what the code does now
// Returns parsed events and any remaining unparsed content

// ✅ Good: explains design rationale without historical context
// Assigned synchronously so concurrent callers share the same connection attempt

// ✅ Good: explains a non-obvious implementation choice
// Uses IIFE to ensure promise exists before any await points
```

### Smell test

If your comment contains "to avoid", "to fix", "to prevent", "instead of", or "properly" — reconsider whether you're describing current behavior or quietly referencing something that no longer exists. Rewrite to describe what the code does now and why this design was chosen.

## API Design

When adding or modifying SDK methods:

- Use clear, descriptive names that indicate what the method does
- Validate inputs before passing to container APIs
- Provide helpful error messages with context (use the custom error classes in `packages/shared/src/errors/`)
