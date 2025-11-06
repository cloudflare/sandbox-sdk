# Manual Bucket Mounting Test

Manual test script for validating bucket mounting functionality with FUSE support.

## Background

The bucket mounting E2E test (`tests/e2e/bucket-mounting.test.ts`) requires FUSE (Filesystem in Userspace) support. When running locally with `wrangler dev`, containers lack the necessary device access (`--device /dev/fuse`) and capabilities (`--cap-add SYS_ADMIN`).

**Why:** Wrangler uses workerd (compiled C++ binary) to manage Docker containers via the socket API. The current version doesn't support passing additional Docker flags for device access. This limitation only affects local testing - production Cloudflare infrastructure has proper FUSE support.

## Prerequisites

1. Docker installed and running
2. R2 bucket: `sandbox-bucket-mount-test`
3. Environment variables configured:
   - `CLOUDFLARE_ACCOUNT_ID`
   - `AWS_ACCESS_KEY_ID` (R2 access key)
   - `AWS_SECRET_ACCESS_KEY` (R2 secret key)

## Running the Test

```bash
./test-bucket-mount-manual.sh
```

## Test Steps

1. Start Docker container with FUSE device access and required capabilities
2. Verify FUSE availability inside container
3. Create mount point at `/mnt/test-data`
4. Mount R2 bucket using s3fs with appropriate flags
5. Write test file to mounted bucket
6. Read test file back to verify
7. Unmount to flush writes
8. Verify file exists in R2 using wrangler CLI (independent verification)
9. Compare content from container vs R2
10. Re-mount filesystem
11. Delete test file via mounted filesystem
12. Unmount to flush delete
13. Verify file was deleted from R2
14. Clean up container

## Expected Result

Test confirms data round-trip through R2:
- File written through mounted filesystem
- Data uploaded to R2 via S3 API
- File retrieved independently via wrangler CLI
- Content integrity maintained
- Deletion propagated to R2

## CI Testing

In CI (GitHub Actions), E2E tests deploy to actual Cloudflare infrastructure where containers have proper FUSE support. The automated tests work correctly in that environment.

## Troubleshooting

### "fuse: device not found" Error

Container doesn't have access to `/dev/fuse`. Verify:
- FUSE kernel module loaded on host: `lsmod | grep fuse`
- `/dev/fuse` exists on host: `ls -la /dev/fuse`
- Container started with `--device /dev/fuse`

### "Operation not permitted" Error

Container lacks necessary capabilities. Verify:
- Container started with `--cap-add SYS_ADMIN`

### Mount Succeeds But Files Not Visible

- Verify bucket exists
- Verify credentials are correct
- Check bucket has files (empty buckets appear empty when mounted)
- Try `ls -la` to see hidden files

## References

- [S3FS Documentation](https://github.com/s3fs-fuse/s3fs-fuse)
- [FUSE in Docker Containers](https://docs.docker.com/engine/reference/run/#runtime-privilege-and-linux-capabilities)
- [Cloudflare R2 Documentation](https://developers.cloudflare.com/r2/)
