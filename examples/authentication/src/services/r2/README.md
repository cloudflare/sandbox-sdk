# R2 Service

Proxies S3-compatible requests to R2. Supports Bearer tokens (HTTP API) and AWS Signature V4 (s3fs).

## How It Works

1. Sandbox sends request with JWT (as Bearer token or AWS access key ID)
2. Proxy validates JWT
3. Proxy re-signs request with real R2 credentials using `aws4fetch`
4. Proxy forwards to R2

For s3fs mounting, the JWT is used as the access key ID in the password file. The proxy extracts it from the AWS Signature V4 `Credential` field.

## Configuration

**Worker secrets:**

```bash
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_ENDPOINT  # https://<account-id>.r2.cloudflarestorage.com
```

Get credentials from: Cloudflare Dashboard > R2 > Manage R2 API Tokens

## Usage

**HTTP API:**

```typescript
const response = await fetch(`${proxyBase}/proxy/r2/bucket/file.txt`, {
  headers: { Authorization: `Bearer ${token}` }
});
```

**s3fs mount:**

```typescript
await configureR2(sandbox, proxyBase, token, 'my-bucket', '/mnt/storage');
// Then in sandbox: ls /mnt/storage
```

## Why Use This?

The SDK's `mountBucket` puts credentials in a password file inside the container. This proxy keeps credentials in the Worker - the sandbox only gets a short-lived JWT.
