import { AwsClient } from 'aws4fetch';

// ---------------------------------------------------------------------------
// STS-backed ECS credential vending via outbound interception.
//
// The container is configured with:
//   AWS_CONTAINER_CREDENTIALS_FULL_URI=http://s3-credentials.local/
// When mount-s3's AWS CRT fetches that URL, the sandbox's outbound handler
// intercepts the request inside the Worker. The handler calls STS AssumeRole
// with broker credentials and returns the temporary credentials as JSON.
//
// The token never leaves the Worker isolate — there is no public credential
// endpoint to authenticate. The CRT still sets AWS_CONTAINER_AUTHORIZATION_TOKEN
// but we ignore it; the interception boundary is the trust boundary.
//
// AWS_CONTAINER_CREDENTIALS_FULL_URI reference:
//   https://docs.aws.amazon.com/sdkref/latest/guide/feature-container-credentials.html
// ---------------------------------------------------------------------------

interface STSCredentials {
  accessKeyID: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
  expiresAt: number;
}

interface ECSCredentialResponse {
  AccessKeyId: string;
  SecretAccessKey: string;
  Token: string;
  Expiration: string;
}

/** Refresh window: serve cached credentials only if more than 5 min remain */
const CACHE_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/** Per-isolate cache. The Sandbox DO is single-instance so this is effectively per-DO memory. */
let credentialCache: STSCredentials | null = null;

function isCacheStale(now: number): boolean {
  if (!credentialCache) return true;
  return now >= credentialCache.expiresAt - CACHE_REFRESH_WINDOW_MS;
}

/** Call STS AssumeRole with the broker credentials and return the temporary session. */
async function assumeRole(env: Env, sessionTag: string): Promise<STSCredentials> {
  const region = env.AWS_REGION || 'us-east-1';
  const durationSeconds = Math.max(
    900,
    Math.min(3600, parseInt(env.STS_DURATION_SECONDS || '3600', 10))
  );

  // STS requires every request to be SigV4-signed with the broker IAM key.
  // aws4fetch is a ~5kB library that implements exactly that and nothing else;
  // writing the HMAC-SHA256 signing chain by hand would be ~100 lines of crypto
  // boilerplate for a single endpoint, with no upside.
  const client = new AwsClient({
    accessKeyId: env.BROKER_AWS_ACCESS_KEY_ID,
    secretAccessKey: env.BROKER_AWS_SECRET_ACCESS_KEY,
    region,
    service: 'sts'
  });

  const sessionName = `sandbox-${sessionTag.replace(/[^a-zA-Z0-9=,.@-]/g, '-').slice(0, 64)}`;

  const params = new URLSearchParams({
    Action: 'AssumeRole',
    Version: '2011-06-15',
    RoleArn: env.AWS_ROLE_ARN,
    RoleSessionName: sessionName,
    DurationSeconds: String(durationSeconds)
  });

  const response = await client.fetch(`https://sts.${region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!response.ok) {
    throw new Error(`STS AssumeRole failed (${response.status}): ${await response.text()}`);
  }

  const xml = await response.text();
  const get = (tag: string): string => {
    const match = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
    if (!match) throw new Error(`STS response missing <${tag}>`);
    return match[1];
  };

  const expiration = get('Expiration');
  return {
    accessKeyID: get('AccessKeyId'),
    secretAccessKey: get('SecretAccessKey'),
    sessionToken: get('SessionToken'),
    expiration,
    expiresAt: new Date(expiration).getTime()
  };
}

/**
 * Outbound handler for `s3-credentials.local`.
 *
 * mount-s3's AWS CRT calls this URL whenever it needs to refresh credentials.
 * The handler returns the ECS container-credentials JSON shape, caching the
 * STS response in DO memory until 5 min before expiry.
 */
export async function credentialsHandler(_request: Request, env: Env): Promise<Response> {
  if (isCacheStale(Date.now())) {
    credentialCache = await assumeRole(env, crypto.randomUUID());
  }

  const creds = credentialCache as STSCredentials;
  const body: ECSCredentialResponse = {
    AccessKeyId: creds.accessKeyID,
    SecretAccessKey: creds.secretAccessKey,
    Token: creds.sessionToken,
    Expiration: creds.expiration
  };
  return Response.json(body);
}
