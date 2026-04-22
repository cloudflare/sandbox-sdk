import { AwsClient } from 'aws4fetch';

/**
 * Outbound handler for the virtual hostname `r2.worker`.
 *
 * The sandbox makes plain HTTP requests to `http://r2.worker/<bucket>/<key>`.
 * This handler intercepts those requests, re-targets them at the real R2
 * endpoint, and re-signs them with real AWS credentials. The sandbox never
 * sees the credentials.
 *
 * Usage from inside the sandbox:
 *   curl -X PUT "http://r2.worker/my-bucket/my-key" -d "data"
 *   curl "http://r2.worker/my-bucket/my-key"
 */
export async function r2Handler(request: Request, env: Env): Promise<Response> {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT } = env;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ENDPOINT) {
    return new Response('R2 credentials not configured', { status: 500 });
  }

  const url = new URL(request.url);
  const r2Url = new URL(url.pathname + url.search, R2_ENDPOINT);

  const awsClient = new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  });

  const r2Request = new Request(r2Url.toString(), {
    method: request.method,
    headers: request.headers,
    body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
    // @ts-expect-error - duplex required for streaming bodies
    duplex: 'half'
  });

  const signedRequest = await awsClient.sign(r2Request, {
    aws: { service: 's3' }
  });
  return fetch(signedRequest);
}
