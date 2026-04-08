# Phase 2: Large File & Complex Data Stress

Execute each test below using the shell tool. Report **PASS** or **FAIL** with details. Print a summary table at the end.

## Test 1 — Large binary file write and checksum

Run:

```
dd if=/dev/urandom of=/workspace/bigfile.bin bs=1M count=10 2>/dev/null
sha256sum /workspace/bigfile.bin
```

Record the SHA-256 hash. Then:

```
cat /workspace/bigfile.bin | sha256sum
```

Expected: both hashes are identical. Report PASS if they match.

## Test 2 — Large exec output

Run:

```
dd if=/dev/urandom bs=1M count=5 2>/dev/null | base64 | wc -c
```

Expected: output character count is greater than 6,000,000 (5 MB base64-encoded ≈ 6.67 MB).

## Test 3 — Deeply nested JSON

Run:

```
python3 -c "
import json
d = {'value': 'leaf'}
for i in range(200):
    d = {'level': i, 'child': d}
with open('/workspace/deep.json', 'w') as f:
    json.dump(d, f)
print('written')
"
```

Then:

```
python3 -c "
import json
with open('/workspace/deep.json') as f:
    d = json.load(f)
depth = 0
while 'child' in d:
    d = d['child']
    depth += 1
print(f'depth={depth} leaf={d}')
"
```

Expected: depth=200 and leaf contains `{'value': 'leaf'}`.

## Test 4 — Unicode stress

Run:

```
cat > /workspace/unicode_test.txt << 'UNICODE_EOF'
English: Hello, World!
Emoji: 🚀🌍🎉🔥💻🧪✅❌
CJK: 你好世界 こんにちは世界 안녕하세요
Arabic (RTL): مرحبا بالعالم
Combining: é = e + ◌́  (U+0065 U+0301)
Math: ∀x∈ℝ: x² ≥ 0
Box drawing: ┌──┐│  │└──┘
Null-adjacent: before\x01after
UNICODE_EOF
cat /workspace/unicode_test.txt
```

Expected: output matches the written content byte-for-byte. Verify with `wc -c /workspace/unicode_test.txt` and confirm non-zero size.

## Test 5 — Batch file creation (500 files)

Run:

```
mkdir -p /workspace/batch
for i in $(seq 1 500); do echo "file-$i" > /workspace/batch/$i.txt; done
echo "done creating"
```

Verify:

```
ls /workspace/batch | wc -l
cat /workspace/batch/1.txt
cat /workspace/batch/250.txt
cat /workspace/batch/500.txt
```

Expected: 500 files, spot-checked files contain `file-1`, `file-250`, `file-500`.

## Test 6 — Large file cleanup

Run:

```
rm /workspace/bigfile.bin
ls /workspace/bigfile.bin 2>&1
```

Expected: file is gone, ls reports error.

## Summary

Print a table:
| Test | Result |
|------|--------|
| ... | PASS/FAIL |
