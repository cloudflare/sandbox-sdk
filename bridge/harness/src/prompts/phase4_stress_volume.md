# Phase 4: Volume Stress

Execute each test below using the shell tool. These tests exercise high-frequency small operations to stress the exec transport and file I/O paths. Report **PASS** or **FAIL**. Print a summary table at the end.

## Test 1 — 200 sequential echo commands

Run:

```
for i in $(seq 1 200); do echo "ping-$i"; done | wc -l
```

Expected: `200`.

Spot-check:

```
for i in $(seq 1 200); do echo "ping-$i"; done | head -3
for i in $(seq 1 200); do echo "ping-$i"; done | tail -3
```

Expected: head shows `ping-1`, `ping-2`, `ping-3`; tail shows `ping-198`, `ping-199`, `ping-200`.

## Test 2 — 200 sequential file write-read cycles

Run:

```
mkdir -p /workspace/vol_test
for i in $(seq 1 200); do
  echo "payload-$i" > /workspace/vol_test/f$i.txt
done
echo "write done"

FAIL=0
for i in $(seq 1 200); do
  CONTENT=$(cat /workspace/vol_test/f$i.txt)
  if [ "$CONTENT" != "payload-$i" ]; then
    echo "MISMATCH at $i: got $CONTENT"
    FAIL=$((FAIL+1))
  fi
done
echo "failures: $FAIL"
```

Expected: `failures: 0`.

## Test 3 — 50 parallel file writes

Run:

```
mkdir -p /workspace/par_test
for i in $(seq 1 50); do
  (echo "par-$i" > /workspace/par_test/$i.txt) &
done
wait
echo "parallel write done"
ls /workspace/par_test | wc -l
```

Expected: `50` files.

Verify a sample:

```
cat /workspace/par_test/1.txt
cat /workspace/par_test/25.txt
cat /workspace/par_test/50.txt
```

Expected: `par-1`, `par-25`, `par-50`.

## Test 4 — Mixed operation burst

Run:

```
mkdir -p /workspace/mixed_test
ERRORS=0
for i in $(seq 1 100); do
  echo "line-$i" > /workspace/mixed_test/$i.txt
  cat /workspace/mixed_test/$i.txt > /dev/null
  ls /workspace/mixed_test/$i.txt > /dev/null 2>&1 || ERRORS=$((ERRORS+1))
done
echo "mixed errors: $ERRORS"
ls /workspace/mixed_test | wc -l
```

Expected: `mixed errors: 0` and `100` files.

## Test 5 — Timing measurement

Run:

```
START=$(date +%s%N)
for i in $(seq 1 100); do echo "$i" > /dev/null; done
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
echo "100 echo-to-devnull took ${ELAPSED}ms"
```

Report the timing (no pass/fail, just record for reference).

Then:

```
START=$(date +%s%N)
mkdir -p /workspace/timing_test
for i in $(seq 1 100); do
  echo "t-$i" > /workspace/timing_test/$i.txt
done
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
echo "100 file writes took ${ELAPSED}ms"
```

Report the timing.

## Summary

Print a table:
| Test | Result |
|------|--------|
| ... | PASS/FAIL |
