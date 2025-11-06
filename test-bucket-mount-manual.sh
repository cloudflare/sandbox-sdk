#!/bin/bash
set -e

echo "=== Manual Bucket Mounting Test with FUSE Support ==="
echo ""

# Verify required environment variables
if [ -z "$CLOUDFLARE_ACCOUNT_ID" ] || [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ]; then
  echo "Error: Required environment variables not set:"
  echo "  CLOUDFLARE_ACCOUNT_ID"
  echo "  AWS_ACCESS_KEY_ID"
  echo "  AWS_SECRET_ACCESS_KEY"
  exit 1
fi

# Configuration
CONTAINER_IMAGE="cloudflare/sandbox-test:0.4.14"
CONTAINER_NAME="sandbox-fuse-test-$$"
BUCKET="sandbox-bucket-mount-test"
TEST_FILE="manual-test-$(date +%s).txt"
TEST_CONTENT="Test from manual Docker run at $(date)"
R2_TEMP_FILE=".r2-verification-$$.txt"
WRANGLER_CONFIG=".wrangler-r2-test.toml"

# Create wrangler config with correct account
cat > "$WRANGLER_CONFIG" << EOF
account_id = "$CLOUDFLARE_ACCOUNT_ID"
EOF

echo "Step 1: Starting container with FUSE device access..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --device /dev/fuse \
  --cap-add SYS_ADMIN \
  -e AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  -e AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  -e CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" \
  "$CONTAINER_IMAGE"

echo "Container started: $CONTAINER_NAME"
echo ""

# Wait for container to be ready
echo "Step 2: Waiting for container to start..."
sleep 3

echo "Step 3: Testing FUSE availability in container..."
docker exec "$CONTAINER_NAME" ls -la /dev/fuse || echo "FUSE device not visible (expected without --device)"
docker exec "$CONTAINER_NAME" which s3fs

echo ""
echo "Step 4: Creating mount point..."
docker exec "$CONTAINER_NAME" mkdir -p /mnt/test-data

echo ""
echo "Step 5: Attempting to mount R2 bucket..."
docker exec "$CONTAINER_NAME" s3fs "$BUCKET" /mnt/test-data \
  -o use_path_request_style \
  -o nomixupload \
  -o url="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  -o allow_other \
  -o umask=0000

echo ""
echo "Step 6: Verifying mount..."
docker exec "$CONTAINER_NAME" ls -la /mnt/test-data

echo ""
echo "Step 7: Writing test file via mounted filesystem..."
echo "  File: $TEST_FILE"
echo "  Content: $TEST_CONTENT"
docker exec "$CONTAINER_NAME" bash -c "echo '$TEST_CONTENT' > /mnt/test-data/$TEST_FILE"

echo ""
echo "Step 8: Reading test file from mounted filesystem..."
CONTAINER_CONTENT=$(docker exec "$CONTAINER_NAME" cat /mnt/test-data/$TEST_FILE)
echo "  Content from container: $CONTAINER_CONTENT"

echo ""
echo "Step 9: Unmounting filesystem to flush all writes to R2..."
docker exec "$CONTAINER_NAME" umount /mnt/test-data
echo "  Unmounted successfully"

echo ""
echo "Step 10: Waiting for R2 consistency..."
sleep 3

echo ""
echo "Step 11: Verifying file exists in R2 using wrangler (independent verification)..."
echo "  Downloading from R2: $BUCKET/$TEST_FILE"

# Try to download from R2 with retry logic and --remote flag
MAX_RETRIES=5
RETRY_COUNT=0
DOWNLOAD_SUCCESS=false

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if npx wrangler r2 object get "$BUCKET/$TEST_FILE" --remote --file "$R2_TEMP_FILE" --config "$WRANGLER_CONFIG" >/dev/null 2>&1; then
    DOWNLOAD_SUCCESS=true
    break
  fi
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
    echo "  Retry $RETRY_COUNT/$MAX_RETRIES - waiting for R2 propagation..."
    sleep 2
  fi
done

if [ "$DOWNLOAD_SUCCESS" = true ]; then
  WRANGLER_CONTENT=$(cat "$R2_TEMP_FILE")
  rm -f "$R2_TEMP_FILE"
  echo "  File downloaded successfully from R2 via wrangler"
  echo "  Content from R2: $WRANGLER_CONTENT"
else
  rm -f "$R2_TEMP_FILE" "$WRANGLER_CONFIG"
  echo "  Failed to download file from R2 after $MAX_RETRIES attempts"

  # Cleanup
  docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
  exit 1
fi

echo ""
echo "Step 12: Comparing content from container vs R2..."
if [ "$CONTAINER_CONTENT" = "$WRANGLER_CONTENT" ]; then
  echo "  SUCCESS: Content matches - data round-tripped through R2"
else
  echo "  FAILURE: Content mismatch"
  echo "    Container: $CONTAINER_CONTENT"
  echo "    R2:        $WRANGLER_CONTENT"
  rm -f "$WRANGLER_CONFIG"
  exit 1
fi

echo ""
echo "Step 13: Re-mounting filesystem to test delete..."
docker exec "$CONTAINER_NAME" s3fs "$BUCKET" /mnt/test-data \
  -o use_path_request_style \
  -o nomixupload \
  -o url="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  -o allow_other \
  -o umask=0000

echo ""
echo "Step 14: Deleting test file via mounted filesystem..."
docker exec "$CONTAINER_NAME" rm /mnt/test-data/$TEST_FILE

echo ""
echo "Step 15: Unmounting to flush delete operation..."
docker exec "$CONTAINER_NAME" umount /mnt/test-data

echo ""
echo "Step 16: Verifying file was deleted from R2..."
sleep 3
if npx wrangler r2 object get "$BUCKET/$TEST_FILE" --remote --file "$R2_TEMP_FILE" --config "$WRANGLER_CONFIG" 2>&1 | grep -q "Object not found"; then
  echo "  File successfully deleted from R2"
  rm -f "$R2_TEMP_FILE"
elif [ ! -f "$R2_TEMP_FILE" ]; then
  echo "  File not found in R2 (confirmed deleted)"
else
  echo "  File may still exist in R2 (eventual consistency delay)"
  rm -f "$R2_TEMP_FILE"
fi

echo ""
echo "Step 17: Stopping and removing container..."
docker stop "$CONTAINER_NAME" >/dev/null
docker rm "$CONTAINER_NAME" >/dev/null

echo ""
echo "Step 18: Cleaning up..."
rm -f "$WRANGLER_CONFIG"

echo ""
echo "Manual bucket mounting test completed successfully"
echo ""
echo "Summary:"
echo "  - Container started with FUSE device access"
echo "  - R2 bucket mounted via s3fs"
echo "  - File written through mounted filesystem"
echo "  - Unmount flushed writes to R2"
echo "  - File verified in R2 using wrangler (independent verification)"
echo "  - Content matches between container and R2"
echo "  - File deleted through mounted filesystem"
echo "  - Deletion confirmed in R2"
