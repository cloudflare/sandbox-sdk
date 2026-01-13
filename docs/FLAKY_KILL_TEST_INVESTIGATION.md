# Flaky E2E Test Investigation: Child Process Killing

This document captures the detailed investigation of a flaky E2E test that verifies child processes are killed when their parent process is terminated.

## Problem Statement

**Test**: `tests/e2e/process-lifecycle-workflow.test.ts` - "should kill child processes when killing parent process"

**Symptom**: Test intermittently fails with:

```
AssertionError: expected 'RUNNING' to be 'NOT_RUNNING'
```

**Failure Rate**: Approximately 30-50% of runs fail, even with Vitest's built-in retry mechanism (`retry: 1`).

**Impact**:

- PR CI tests pass but Release workflow tests fail on the same code
- Blocks automated releases
- First observed failing on Jan 12, 2026 ("Remove oh-my-opencode" commit) before PR #348 was merged

---

## Test Mechanics

The test creates a process hierarchy:

```bash
# User command passed to startProcess()
bash -c "sleep 300 & CHILD1=$!; sleep 300 & CHILD2=$!; echo $CHILD1 $CHILD2 > /tmp/marker; echo CHILDREN_READY; wait"
```

This creates the following process tree inside the container:

```
Session shell (persistent bash, PID 1)
  └── { } wrapper subshell (CMD_PID - stored in pidFile)
      └── bash -c "..."
          ├── sleep 300 & (CHILD1 - written to marker file)
          └── sleep 300 & (CHILD2 - written to marker file)
```

Test flow:

1. Start process via `POST /api/process/start`
2. Wait for "CHILDREN_READY" in output
3. Read child PIDs (e.g., 99, 100) from marker file
4. Verify children are RUNNING via `kill -0`
5. Kill parent via `DELETE /api/process/{id}`
6. Wait for parent to exit
7. Verify children are NOT_RUNNING - **this step fails intermittently**

---

## Timeline of Investigation

### Phase 1: Initial Analysis

**Finding**: The original implementation used `set -m` (job control) to enable process groups, then `kill -- -$pid` to kill the group. This worked locally but failed in CI.

**PR #348 Fix**: Replaced job control with `/proc` tree traversal:

```typescript
const collectDescendants = (targetPid: number, pids: number[]) => {
  const childrenFile = `/proc/${targetPid}/task/${targetPid}/children`;
  const children = readFileSync(childrenFile, 'utf8')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  for (const childPid of children) {
    collectDescendants(childPid, pids);
  }
  pids.push(targetPid);
};
```

**Result**: PR tests passed, but Release workflow tests still failed.

### Phase 2: Verified /proc Traversal Works

**Test**: Ran Docker containers to verify `/proc/PID/task/PID/children` correctly shows child processes.

```bash
# Inside container
{
  bash -c "sleep 300 & sleep 300 & wait"
} & CMD_PID=$!

# /proc correctly shows:
# CMD_PID -> bash_c_pid -> [sleep_pid1, sleep_pid2]
```

**Result**: The `/proc` traversal mechanism is correct. Backgrounded processes DO appear in `/proc/.../children`.

### Phase 3: Signal Delivery Race Condition Hypothesis

**Hypothesis**: SIGTERM might race with process exit - if parent dies before children process SIGTERM, children get reparented to init (PID 1) and survive.

**Test**: Verified that when `bash -c` is killed, its children get reparented to PID 1:

```
After killing bash -c:
  PID 9: RUNNING (ppid=1)
  PID 10: RUNNING (ppid=1)
```

**Fix Attempt**: Changed to SIGKILL (immediate, cannot be blocked):

```typescript
killPids(allPids, 'SIGKILL');
```

**Result**: Still flaky (~40% failure rate).

### Phase 4: Multi-Round Kill Strategy

**Hypothesis**: Processes might become visible only after their parent is killed and they're reparented.

**Fix Attempt**: Kill in rounds, re-traverse after each kill:

```typescript
for (let round = 0; round < 3; round++) {
  killPids(Array.from(pidSet), 'SIGKILL');
  await new Promise((r) => setTimeout(r, 50));
  pidSet.clear();
  collectDescendants(pid, pidSet);
}
```

**Result**: Made flakiness worse (~60% failure rate).

### Phase 5: pgrep Backup Strategy

**Fix Attempt**: Use `pgrep -P` as backup to find children by parent PID:

```typescript
const killDescendantsViaPgrep = (parentPid: number) => {
  const result = spawnSync('pgrep', ['-P', String(parentPid)]);
  // ... recursively kill
};
```

**Result**: No improvement.

### Phase 6: Process Group Kill

**Fix Attempt**: Use negative PID to kill entire process group:

```typescript
process.kill(-pid, 'SIGKILL');
```

**Result**: No improvement (processes may be in different groups).

---

## Key Findings

### 1. Process Tree Structure Varies

The exact structure depends on bash optimizations:

**With subshell wrapper** (what session.ts generates):

```
{ bash -c "..." } &  →  subshell → bash -c → children
```

**Direct backgrounding**:

```
bash -c "..." &  →  bash -c → children (or optimized away)
```

Bash may eliminate intermediate subshells through "exec optimization" when possible.

### 2. /proc Traversal is Correct

When the process tree is stable, `/proc/PID/task/PID/children` correctly shows all descendants. The traversal algorithm finds all PIDs.

### 3. Kill Signals are Delivered

SIGKILL is synchronous at the kernel level - the signal IS delivered. But there may be a timing window where:

1. We read PIDs from marker file (e.g., 99, 100)
2. We traverse from CMD_PID, which may not include 99, 100 if tree has changed
3. We kill only the PIDs we found
4. PIDs 99, 100 survive

### 4. The Race is Between Collection and Verification

The marker file contains PIDs that bash's `$!` captured at spawn time. These are the actual `sleep` process PIDs.

The `/proc` traversal finds PIDs from CMD_PID downward. If the intermediate `bash -c` has exited and been reaped, its children become orphans under PID 1 - and we never find them.

### 5. Container Logs Not Visible

Container stdout/stderr doesn't flow through to test output via wrangler dev. This made debugging difficult - we couldn't see what PIDs were actually being collected vs. killed.

---

## Current State of Code

**File**: `packages/sandbox-container/src/session.ts` - `killCommand()` method

Current implementation:

1. Read PID from pidFile (CMD_PID)
2. Traverse `/proc` to collect all descendants
3. Send SIGKILL to all collected PIDs
4. Wait for PIDs to die (5s timeout)
5. If not all dead, re-traverse and kill again

**File**: `tests/e2e/process-lifecycle-workflow.test.ts`

Test has a 200ms delay added after `waitForExit` to give kernel time for cleanup.

---

## Hypotheses Not Yet Tested

### 1. Container Runtime Differences

The test might behave differently in:

- Local Docker (arm64 emulated as amd64)
- CI Docker (native amd64)
- Cloudflare container runtime (production)

### 2. PID Reuse

If PIDs are reused quickly, the marker file PIDs might refer to different processes by the time we check. However, this would cause false positives (check passes incorrectly), not false negatives.

### 3. Wrangler Dev Container Management

Wrangler manages the Docker container lifecycle. There may be races in how it handles container state between requests.

### 4. E2E Test Infrastructure Races

The test uses a shared sandbox instance. Other operations might interfere:

- Session mutex might affect timing
- Background process cleanup might race

---

## Recommendations for Future Work

### Short Term

1. **Increase retry count**: Change `retry: 1` to `retry: 3` in `vitest.e2e.config.ts` to reduce CI flakiness impact.

2. **Add delay in test**: The 200ms delay after `waitForExit` should be tested to see if it helps.

3. **Test isolation**: Consider giving this specific test its own sandbox instance to eliminate interference.

### Medium Term

4. **Alternative kill mechanism**: Instead of `/proc` traversal, consider:
   - Using `setsid` to create a new session for commands, then `kill -- -$SID`
   - Tracking all spawned PIDs explicitly during process creation
   - Using cgroups to group all processes

5. **Container logging**: Add a mechanism to capture container logs during E2E tests for debugging.

### Long Term

6. **Process supervisor**: Implement a process supervisor in the container that tracks all spawned processes and can kill them reliably.

7. **Test redesign**: The test could be redesigned to not rely on precise PID checking:
   - Use a unique marker process name and check if ANY process with that name exists
   - Use file locks or other coordination mechanisms

---

## Related Files

- `packages/sandbox-container/src/session.ts` - killCommand() implementation
- `packages/sandbox-container/src/services/session-manager.ts` - SessionManager.killCommand()
- `packages/sandbox-container/src/services/process-service.ts` - ProcessService.killProcess()
- `tests/e2e/process-lifecycle-workflow.test.ts` - The flaky test
- `.github/workflows/release.yml` - Release workflow that runs E2E tests
- `vitest.e2e.config.ts` - E2E test configuration with retry settings

---

## Git History Context

| Commit    | Description                                                        | Relevance                   |
| --------- | ------------------------------------------------------------------ | --------------------------- |
| `35f1fbc` | Fix killProcess not terminating child processes (#339)             | Original fix using `set -m` |
| `6e164a4` | Fix child process killing and improve session documentation (#348) | `/proc` traversal approach  |
| `163c728` | Remove oh-my-opencode                                              | First observed test failure |

---

## Session Commands for Reproduction

```bash
# Run the flaky test multiple times
cd /Users/naresh/github/cloudflare/sandbox-sdk
for i in 1 2 3 4 5; do
  npm run test:e2e -- -- tests/e2e/process-lifecycle-workflow.test.ts -t 'should kill child processes'
done

# Rebuild container after code changes
npm run build -w @repo/sandbox-container
docker build --no-cache -f packages/sandbox/Dockerfile --target default \
  --platform linux/amd64 --build-arg SANDBOX_VERSION=0.6.11 \
  -t cloudflare/sandbox-test:0.6.11 .
cd tests/e2e/test-worker
docker build --no-cache -f Dockerfile.standalone --platform linux/amd64 \
  -t cloudflare/sandbox-test:0.6.11-standalone .

# Test process tree in Docker
docker run --rm ubuntu:22.04 bash -c '
{
  bash -c "sleep 300 & C1=\$!; sleep 300 & C2=\$!; echo \$C1 \$C2; wait"
} & CMD_PID=$!
sleep 0.3
ps --forest -o pid,ppid,cmd
cat /proc/$CMD_PID/task/$CMD_PID/children
pkill sleep
'
```

---

_Document created: January 13, 2026_
_Last investigation session: ~4 hours of debugging_
_Status: Root cause identified as race condition, reliable fix not yet found_
