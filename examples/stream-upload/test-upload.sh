#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:8787}"
SIZE_MB="${2:-35}"
TMPFILE=$(mktemp /tmp/upload-test-XXXXXX.bin)
DLFILE=$(mktemp /tmp/download-test-XXXXXX.bin)

cleanup() { rm -f "$TMPFILE" "$DLFILE"; }
trap cleanup EXIT

echo "=== Stream Upload/Download Integrity Test ==="
echo "Server:  $BASE_URL"
echo "Size:    ${SIZE_MB} MB"
echo ""

# 1. Generate random test file
echo "Generating ${SIZE_MB} MB random file..."
dd if=/dev/urandom of="$TMPFILE" bs=1048576 count="$SIZE_MB" 2>/dev/null
ORIG_HASH=$(shasum -a 256 "$TMPFILE" | awk '{print $1}')
echo "Original SHA-256: $ORIG_HASH"
echo ""

# 2. Upload
echo "Uploading..."
UPLOAD_RESP=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@$TMPFILE" \
  "${BASE_URL}/upload?filename=test-${SIZE_MB}mb.bin")

UPLOAD_HTTP=$(echo "$UPLOAD_RESP" | tail -1)
UPLOAD_BODY=$(echo "$UPLOAD_RESP" | sed '$d')

if [ "$UPLOAD_HTTP" != "200" ]; then
  echo "Upload FAILED (HTTP $UPLOAD_HTTP): $UPLOAD_BODY"
  exit 1
fi

UPLOAD_PATH=$(echo "$UPLOAD_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['path'])")
echo "Upload OK -> $UPLOAD_PATH"
echo ""

# 3. Download
echo "Downloading..."
DL_HTTP=$(curl -s -o "$DLFILE" -w "%{http_code}" \
  "${BASE_URL}/download?path=${UPLOAD_PATH}")

if [ "$DL_HTTP" != "200" ]; then
  echo "Download FAILED (HTTP $DL_HTTP)"
  cat "$DLFILE"
  exit 1
fi

DL_HASH=$(shasum -a 256 "$DLFILE" | awk '{print $1}')
echo "Downloaded SHA-256: $DL_HASH"
echo ""

# 4. Compare
ORIG_SIZE=$(wc -c < "$TMPFILE" | tr -d ' ')
DL_SIZE=$(wc -c < "$DLFILE" | tr -d ' ')

echo "Original size:   $ORIG_SIZE bytes"
echo "Downloaded size: $DL_SIZE bytes"
echo ""

if [ "$ORIG_HASH" = "$DL_HASH" ]; then
  echo "PASS - Files are identical"
  exit 0
else
  echo "FAIL - Hash mismatch!"
  exit 1
fi
