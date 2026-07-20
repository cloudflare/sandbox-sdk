# Reproduction for sandbox-sdk #825

This project demonstrates that `@cloudflare/sandbox@0.12.3`'s `createBackup()`
uses the waking `containerFetch()` path after a caller's running-state precheck.

## Run

```sh
npm install
npm run deploy
```

Open the printed URL and press **Trigger bug**.

The deployed demo executes the real, unmodified SDK `Sandbox.createBackup()`
implementation. Temporary Cloudflare preview accounts cannot provision Container
applications or R2 buckets, so `vite.config.ts` aliases only the
`@cloudflare/containers` platform boundary to `src/mock-containers.ts`, and the
worker supplies an in-memory structural R2 bucket. Those fakes deterministically
model a healthy → stopped race and record startup calls; all backup orchestration,
transport routing, and `containerFetch()` startup policy under test come from SDK
0.12.3.

The expected visible sequence is:

```text
state before race: healthy
state after stop:  stopped
createBackup():    invokes startAndWaitForPorts once and succeeds
state afterward:   healthy
```

A source-level Vitest reproduction was also run against the exact
`@cloudflare/sandbox@0.12.3` tag in the repository checkout and passed with the
same sequence.
