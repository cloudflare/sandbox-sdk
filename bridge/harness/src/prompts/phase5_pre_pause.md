# Phase 5: Pre-Pause Sentinel Data

Write sentinel data that will be used to verify session persistence after a pause/resume cycle. Execute each step and confirm success.

## Step 1 — Write magic sentinel

The harness has generated this unique magic value: `{magic_uuid}`

Run:

```
mkdir -p /workspace/sentinel
echo '{magic_uuid}' > /workspace/sentinel/magic.txt
cat /workspace/sentinel/magic.txt
```

Confirm the magic value was written correctly.

## Step 2 — Write timestamp sentinel

Run:

```
date -Iseconds > /workspace/sentinel/timestamp.txt
cat /workspace/sentinel/timestamp.txt
```

Record the timestamp value.

## Step 3 — Write workspace checksum

Run:

```
find /workspace -type f -not -path '/workspace/sentinel/checksum.txt' | sort | xargs sha256sum | sha256sum > /workspace/sentinel/checksum.txt
cat /workspace/sentinel/checksum.txt
```

Record the checksum value.

## Step 4 — Write environment snapshot

Run:

```
env | sort > /workspace/sentinel/env_snapshot.txt
wc -l /workspace/sentinel/env_snapshot.txt
```

## Step 5 — Write a multi-line structured file

Run:

```
cat > /workspace/sentinel/structured.json << 'EOF'
{
  "test_harness": "cloudflare-sandbox-bridge",
  "magic": "{magic_uuid}",
  "phases_completed": [1, 2, 3, 4, 5],
  "status": "pre_pause"
}
EOF
python3 -c "import json; d=json.load(open('/workspace/sentinel/structured.json')); print(d['magic'])"
```

Expected: prints `{magic_uuid}`.

## Step 6 — List all sentinels

Run:

```
ls -la /workspace/sentinel/
```

Confirm all five files exist: `magic.txt`, `timestamp.txt`, `checksum.txt`, `env_snapshot.txt`, `structured.json`.

## Final Report

Print: "Pre-pause sentinel data written. Ready for session persistence."

List the sentinel values:

- magic: (value)
- timestamp: (value)
- checksum: (value)
- file count: (value)
