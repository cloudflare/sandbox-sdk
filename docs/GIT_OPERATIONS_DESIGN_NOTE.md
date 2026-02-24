# Git operations design note

This note documents the scope, tradeoffs, and migration guidance for the new Git APIs.

## API tiers

To keep common workflows simple, prefer the **core** methods first:

- `gitCheckout()`
- `gitStatus()`
- `listBranches()`
- `checkoutBranch()`
- `createBranch()`
- `deleteBranch()`
- `gitAdd()`
- `gitCommit()`

Advanced methods are available for specialized workflows:

- `gitReset()`
- `gitRestore()`

## Status parsing approach

`gitStatus()` uses:

- `git status --porcelain=1 -b`

This provides a stable machine-oriented format while preserving branch metadata.

### Supported status states

Current parsing supports:

- tracked modifications (`M`, `A`, `D`, etc.)
- untracked files (`??`)
- conflict states (for example `UU`, `AA`, `DU`, `UD`)
- rename/copy paths (`old -> new`, returns destination path)
- detached HEAD (`## HEAD (no branch)`)
- ahead/behind counts from header metadata

### Known constraints

- Parsing targets porcelain v1 output (`--porcelain=1`).
- For rename/copy records, the destination path is returned as `path`.
- Unrecognized future porcelain variants are treated as raw paths when possible.

## Migration guidance

If you currently use `exec('git ...')` for standard workflows:

- Replace status checks with `gitStatus()`.
- Replace branch discovery with `listBranches()`.
- Replace common branch/file operations with typed Git methods.

Use raw `exec('git ...')` only for operations not yet modeled by the SDK.
