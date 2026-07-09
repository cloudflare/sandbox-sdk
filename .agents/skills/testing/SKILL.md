---
name: testing
description: Trigger only when adding, updating, or running Sandbox SDK unit tests, E2E tests, bridge tests, process execution tests, terminal tests, or coding-agent harness tests.
---

# Testing

Use the smallest test that proves the behavior while iterating, then run repo checks before handoff.

## Choose unit vs E2E

- **Unit tests**: validation, error mapping, route handlers, mocks, loggers, process/terminal handle behavior that does not require Docker or Cloudflare.
- **Vitest E2E**: real SDK/container behavior, process supervision, cursor replay, terminals, tunnels, mounts, coding-agent harness flows, and Docker/native runtime parity.
- **Browser E2E**: UI/browser-facing examples and Playwright scenarios.
- Do not convert product failures to skips. Skip only for explicit environment prerequisites.

## Locations and runtimes

- `packages/sandbox/tests/**/*.test.ts` covers SDK, bridge internals, extension host behavior, and Workers-style runtime boundaries under Vitest/Miniflare-style tests.
- `packages/sandbox-container/tests/**/*.test.ts` covers container runtime services under Bun.
- `packages/sandbox-execution/tests/**/*.test.ts` covers runtime-local process execution utilities under Bun.
- Sidecar tests are colocated when they need sidecar-only build/runtime context; current interpreter sidecar tests live in `extensions/interpreter/src/sidecar/*.test.ts` and run with Bun.
- `tests/e2e/**/*.test.ts` covers deployed/local sandbox behavior through the public SDK; `tests/e2e/browser` covers Playwright browser scenarios.
- `bridge/worker/src/__tests__` exercises the bridge app through the package test adapter.
- Examples may have local tests; follow their package scripts and keep them aligned with current public APIs.

## Commands

```bash
npm run check
npm test
npm test -w @cloudflare/sandbox
npm test -w @repo/sandbox-container
npm run test:e2e:vitest -- -- tests/e2e/file.ts
npm run test:e2e:vitest -- -- tests/e2e/file.ts -t 'test name'
npm run test:e2e:browser
npm run test:e2e
```

Use `test:e2e:vitest` when filtering; the `test:e2e` wrapper does not pass arguments through reliably.

## Mocks and fixtures

- Prefer existing test adapters and factories near the code under test.
- Use `createNoOpLogger()` or injected mock loggers for log assertions.
- Mock bridge route dependencies at the app boundary; avoid mocking implementation details deeper than needed.
- Keep fixtures small and current. Do not add negative tests that only preserve removed names or historical API shapes.

## Process and terminal conventions

- Use argv-only launches: `sandbox.exec(['node', 'script.js'])` or explicit shell argv `['/bin/bash', '-lc', script]`.
- For async work, assert `process.id` recovery with `sandbox.getProcess(id)` and resume logs with `logs({ since, replay, follow })`.
- Prove `exec()` is launch-oriented, while output and waits observe completion; use numeric signals for process control.
- Test that discovery does not wake an absent runtime and stale handles cannot target a replacement runtime.
- Test cursor behavior with stdout/stderr byte identity and bounded replay, not text-only output; abort and cancellation must release only the local observation.
- Use terminals for their separate interactive PTY semantics: create, connect/reconnect with cursor, resize, interrupt, and terminate.
- Coding-agent E2E should prove Pi/Codex/OpenCode mechanics: setup command launch, process recovery after Worker response, cursor replay, and active resource pinning.

## Docker/native runtime and environment failures

- E2E tests may require Docker, Wrangler, Cloudflare credentials, network access, FUSE, or Playwright browsers.
- If the environment is missing a prerequisite, rerun fresh when feasible and record the exact command, exit code, and error.
- Do not mask a regression as an environment skip after the test has reached product code.
