# Phase 7: Bucket Unmount Verification

The R2 bucket has just been unmounted from `/workspace/r2-test`. Verify the unmount was clean.

## Test 1 — Mount point is no longer accessible

Run: `ls /workspace/r2-test/ 2>&1; echo "exit=$?"`
Expected: the directory is either empty, missing, or produces an error. The bucket contents should not be visible.

## Test 2 — Basic sandbox still functional

Run:

```
echo "post-unmount-ok"
pwd
```

Expected: output includes `post-unmount-ok`, exit code 0. The sandbox is still usable after unmount.

## Summary

Print a table:
| Test | Result |
|------|--------|
| ... | PASS/FAIL |
