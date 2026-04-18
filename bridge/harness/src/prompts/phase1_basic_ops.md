# Phase 1: Basic Operations

Execute each test below using the shell tool. After each test, report **PASS** or **FAIL** with observed vs expected values. At the end, print a summary table.

## Test 1 — Simple echo

Run: `echo hello`
Expected: stdout is exactly `hello`, exit code 0.

## Test 2 — Non-zero exit code

Run: `sh -c 'exit 42'`
Expected: exit code is 42.

## Test 3 — Stderr capture

Run: `echo err >&2`
Expected: stderr contains `err`.

## Test 4 — Text file write and read

Run:

```
echo 'The quick brown fox jumps over the lazy dog.' > /workspace/test_basic.txt
cat /workspace/test_basic.txt
```

Expected: output matches the written string exactly.

## Test 5 — Binary data round-trip

Run:

```
printf '\x00\x01\x02\xfe\xff' > /workspace/binary_test.bin
xxd /workspace/binary_test.bin
```

Expected: xxd output shows bytes `00 01 02 fe ff`.

## Test 6 — Nested directory creation

Run:

```
mkdir -p /workspace/a/b/c
echo 'deep content' > /workspace/a/b/c/deep.txt
cat /workspace/a/b/c/deep.txt
```

Expected: output is `deep content`.

## Test 7 — Read nonexistent file

Run: `cat /workspace/this_file_does_not_exist_12345`
Expected: non-zero exit code and stderr mentions "No such file".

## Test 8 — Environment characterization

Run each and report the output (no pass/fail, just record):

```
pwd
whoami
uname -a
env | sort | head -20
```

## Test 9 — Multiple commands in sequence

Run:

```
echo "step1" > /workspace/seq.txt
echo "step2" >> /workspace/seq.txt
echo "step3" >> /workspace/seq.txt
cat /workspace/seq.txt
```

Expected: output has three lines: step1, step2, step3.

## Summary

Print a table:
| Test | Result |
|------|--------|
| ... | PASS/FAIL |
