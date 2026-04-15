# Phase 3: PTY / Process Stress

Execute each test below using the shell tool. These tests exercise process management, pipes, background jobs, and large output streams through the sandbox's exec transport. Report **PASS** or **FAIL**. Print a summary table at the end.

## Test 1 — Piped interactive-style command

Run:

```
echo "test input" | python3 -c "
import sys
sys.stdout.write('prompt> ')
sys.stdout.flush()
line = sys.stdin.readline().strip()
print(f'echo: {line}')
"
```

Expected: output contains `prompt> echo: test input`.

## Test 2 — Long-running output producer

Run:

```
yes "line" | head -n 50000 | wc -l
```

Expected: output is `50000`.

## Test 3 — Large binary-to-text pipeline

Run:

```
cat /dev/urandom | head -c 100000 | base64 | wc -c
```

Expected: character count > 130000 (100KB base64 ≈ 133KB).

## Test 4 — Rapid sequential commands in a loop

Run:

```
for i in $(seq 1 100); do echo "$i"; done | tail -5
```

Expected: output shows `96`, `97`, `98`, `99`, `100`.

Then verify completeness:

```
for i in $(seq 1 100); do echo "$i"; done | wc -l
```

Expected: `100`.

## Test 5 — Concurrent background processes

Run:

```
mkdir -p /workspace/bg_test
for i in $(seq 1 5); do
  (sleep 0.1 && echo "bg-$i" > /workspace/bg_test/$i.txt) &
done
wait
echo "all done"
cat /workspace/bg_test/1.txt
cat /workspace/bg_test/3.txt
cat /workspace/bg_test/5.txt
```

Expected: "all done" printed, files contain `bg-1`, `bg-3`, `bg-5`.

## Test 6 — Signal handling

Run:

```
sleep 300 &
BGPID=$!
echo "started $BGPID"
kill $BGPID 2>/dev/null
sleep 0.5
kill -0 $BGPID 2>&1 || echo "process gone"
```

Expected: output contains `process gone`.

## Test 7 — Pipe chain stress

Run:

```
seq 1 10000 | sort -n | uniq -c | awk '{print $1}' | sort | uniq -c | awk '{print $1, $2}'
```

Expected: output is `10000 1` (each number appears exactly once).

## Summary

Print a table:
| Test | Result |
|------|--------|
| ... | PASS/FAIL |
