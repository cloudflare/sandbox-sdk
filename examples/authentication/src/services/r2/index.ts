import type { Sandbox } from '@cloudflare/sandbox';
import { AwsClient } from 'aws4fetch';

import type { ServiceConfig } from '../../proxy';

/**
 * R2 bucket access via S3-compatible proxy.
 * Supports both Bearer tokens (simple HTTP) and AWS Signature V4 (s3fs).
 */

/** Extract access key ID from AWS Sig V4 Authorization header */
function extractAccessKeyFromAuth(authHeader: string): string | null {
  const match = authHeader.match(/Credential=([^/]+)\//);
  return match ? match[1] : null;
}

export const r2: ServiceConfig<Env> = {
  target: 'https://unused.example.com', // Dynamically constructed from R2_ENDPOINT

  validate: (req) => {
    const auth = req.headers.get('Authorization');
    if (auth?.startsWith('AWS4-HMAC-SHA256'))
      return extractAccessKeyFromAuth(auth);
    if (auth?.startsWith('Bearer ')) return auth.replace('Bearer ', '');
    return null;
  },

  transform: async (req, ctx) => {
    const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT } = ctx.env;
    if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ENDPOINT) {
      return new Response('R2 credentials not configured', { status: 500 });
    }

    const url = new URL(req.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const bucket = pathParts[0];
    const key = pathParts.slice(1).join('/');

    if (!bucket) {
      return new Response('Bucket name required in path', { status: 400 });
    }

    // Build R2 URL and copy query params
    const r2Url = new URL(`/${bucket}/${key}`, R2_ENDPOINT);
    for (const [name, value] of url.searchParams) {
      r2Url.searchParams.set(name, value);
    }

    // Re-sign request with real R2 credentials
    const awsClient = new AwsClient({
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY
    });

    const newRequest = new Request(r2Url.toString(), {
      method: req.method,
      headers: filterHeaders(req.headers),
      body: ['GET', 'HEAD'].includes(req.method) ? null : req.body,
      // @ts-expect-error - duplex required for streaming bodies
      duplex: 'half'
    });

    const signedRequest = await awsClient.sign(newRequest, {
      aws: { service: 's3' }
    });
    const response = await fetch(signedRequest);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        ...Object.fromEntries(response.headers),
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};

/** Filter to only S3-relevant headers (allowlist to avoid signature issues) */
function filterHeaders(headers: Headers): Headers {
  const allowed = new Set([
    'content-type',
    'content-encoding',
    'content-disposition',
    'content-language',
    'cache-control',
    'expires',
    'range',
    'x-amz-acl',
    'x-amz-storage-class',
    'x-amz-server-side-encryption',
    'x-amz-copy-source',
    'x-amz-copy-source-range'
  ]);

  const filtered = new Headers();
  for (const [key, value] of headers) {
    const lower = key.toLowerCase();
    if (allowed.has(lower) || lower.startsWith('x-amz-meta-')) {
      filtered.set(key, value);
    }
  }
  return filtered;
}

/** Configure s3fs to mount an R2 bucket via the proxy */
export async function configureR2(
  sandbox: Sandbox,
  proxyBase: string,
  token: string,
  bucket: string,
  mountPath: string
): Promise<void> {
  const proxyEndpoint = `${proxyBase}/proxy/r2`;
  const passwordFilePath = `/tmp/.passwd-s3fs-${bucket}`;

  // s3fs password file uses JWT as access key ID (proxy extracts and validates it)
  await sandbox.writeFile(passwordFilePath, `${bucket}:${token}:unused`);
  await sandbox.exec(`chmod 0600 ${passwordFilePath}`);
  await sandbox.exec(`mkdir -p ${mountPath}`);

  const s3fsCmd = [
    `s3fs ${bucket} ${mountPath}`,
    `-o passwd_file=${passwordFilePath}`,
    `-o url=${proxyEndpoint}`,
    `-o use_path_request_style`
  ].join(' ');

  await sandbox.exec(s3fsCmd);
}
