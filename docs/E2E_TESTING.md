# E2E Testing

E2E tests run real Workers code against a Docker-backed Sandbox container. They should prove current product mechanics, not preserve removed API shapes.

## What to cover

- argv-only `sandbox.exec()` launches and explicit Bash argv for shell scripts;
- launch-confirmed process handles that can be recovered by ID across Worker requests;
- log replay/follow with cursors after disconnect;
- active process and terminal pinning after the launching request returns;
- `createTerminal()` / `getTerminal(id)` PTY reconnect behavior;
- Pi, Codex, and OpenCode harness flows using current APIs.

## Commands

```bash
npm run test:e2e:vitest -- -- tests/e2e/process-lifecycle-workflow.test.ts
npm run test:e2e:vitest -- -- tests/e2e/pty.test.ts
npm run test:e2e
```

Use `test:e2e:vitest` when filtering individual files or test names.

## Environment notes

Docker must be running. Wrangler must be able to start local Workers and download any required runtime assets. Browser E2E requires Playwright browsers. If an environment dependency fails, rerun fresh when feasible and record the exact command and error instead of skipping product assertions.
