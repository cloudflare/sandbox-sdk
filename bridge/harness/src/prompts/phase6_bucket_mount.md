# Phase 6: Bucket Mount / Unmount

Execute each test below using the shell tool. These tests verify that S3-compatible bucket mounting works end-to-end. Report **PASS** or **FAIL**. Print a summary table at the end.

The R2 bucket is already mounted at `/workspace/r2-test`. All tests operate on that mount point.

## Test 1 — Mount point exists

Run: `ls -d /workspace/r2-test`
Expected: exit code 0, output is `/workspace/r2-test`.

## Test 2 — Write file to mounted bucket

Run:

```
echo "mount-round-trip-{magic_uuid}" > /workspace/r2-test/harness-mount-test.txt
echo "write ok"
```

Expected: `write ok`, exit code 0.

## Test 3 — Read file back from mounted bucket

Run: `cat /workspace/r2-test/harness-mount-test.txt`
Expected: output is exactly `mount-round-trip-{magic_uuid}`.

## Test 4 — List files on mount point

Run: `ls /workspace/r2-test/`
Expected: exit code 0, listing includes `harness-mount-test.txt`.

## Test 5 — Write a second file and verify both exist

Run:

```
echo "second-file" > /workspace/r2-test/harness-mount-test-2.txt
ls /workspace/r2-test/harness-mount-test*.txt | wc -l
```

Expected: `2`.

## Test 6 — Clean up test files

Run:

```
rm /workspace/r2-test/harness-mount-test.txt /workspace/r2-test/harness-mount-test-2.txt
ls /workspace/r2-test/harness-mount-test*.txt 2>&1 || echo "cleanup ok"
```

Expected: the `ls` fails (no matching files) and `cleanup ok` is printed.

## Summary

Print a table:
| Test | Result |
|------|--------|
| ... | PASS/FAIL |
