import { describe, expect, it, vi } from 'vitest';
import {
  DUMMY_AUTH_HEADERS,
  s3CredentialProxyHandler
} from '../src/storage-mount/s3-credential-proxy-handler';
import type { S3CredentialProxyParams } from '../src/storage-mount/types';

const MOUNT_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
const BUCKET = 'my-bucket';
const ENDPOINT = 'https://abc123.r2.cloudflarestorage.com';
const CREDENTIALS = { accessKeyId: 'AKID', secretAccessKey: 'SECRET' };

function makeParams(
  overrides: Partial<S3CredentialProxyParams['mounts'][string]> = {}
): S3CredentialProxyParams {
  return {
    mounts: {
      [MOUNT_ID]: {
        endpoint: ENDPOINT,
        bucket: BUCKET,
        credentials: CREDENTIALS,
        readOnly: false,
        provider: 'r2',
        authStrategy: 's3-sigv4',
        ...overrides
      }
    }
  };
}

function makeCtx(params: S3CredentialProxyParams) {
  return {
    containerId: 'ctr-test',
    className: 'Sandbox',
    params
  };
}

function makeRequest(
  path: string,
  method = 'GET',
  headers: Record<string, string> = {}
) {
  return new Request(`http://s3-credential-proxy.internal${path}`, {
    method,
    headers
  });
}

describe('s3CredentialProxyHandler self-test', () => {
  it('returns 200 for the self-test path', async () => {
    const req = new Request(
      'http://s3-credential-proxy.internal/__sandbox_credential_proxy_self_test__'
    );
    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams()) as Parameters<typeof s3CredentialProxyHandler>[2]
    );
    expect(res.status).toBe(200);
  });
});

describe('s3CredentialProxyHandler mount resolution', () => {
  it('returns 400 when path has no mount ID segment', async () => {
    const req = new Request('http://s3-credential-proxy.internal/');
    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams()) as Parameters<typeof s3CredentialProxyHandler>[2]
    );
    expect(res.status).toBe(400);
  });

  it('returns 403 for an unknown mount ID', async () => {
    const req = makeRequest('/unknown-uuid/my-bucket/key.txt');
    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams()) as Parameters<typeof s3CredentialProxyHandler>[2]
    );
    expect(res.status).toBe(403);
  });

  it('resolves mount from per-mount-host shape (legacy)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const req = new Request(
      `http://${MOUNT_ID}.s3-credential-proxy.internal/${BUCKET}/key.txt`
    );
    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams()) as Parameters<typeof s3CredentialProxyHandler>[2]
    );
    expect(res.status).toBe(200);
    fetchSpy.mockRestore();
  });
});

describe('s3CredentialProxyHandler read-only enforcement', () => {
  it('returns 403 for PUT on a read-only mount', async () => {
    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/key.txt`, 'PUT');
    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams({ readOnly: true })) as Parameters<
        typeof s3CredentialProxyHandler
      >[2]
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 for DELETE on a read-only mount', async () => {
    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/key.txt`, 'DELETE');
    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams({ readOnly: true })) as Parameters<
        typeof s3CredentialProxyHandler
      >[2]
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 for multipart POST on a read-only mount', async () => {
    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/key.txt?uploads`, 'POST');
    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams({ readOnly: true })) as Parameters<
        typeof s3CredentialProxyHandler
      >[2]
    );
    expect(res.status).toBe(403);
  });

  it('allows GET on a read-only mount', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('data', { status: 200 }));

    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/key.txt`, 'GET');
    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams({ readOnly: true })) as Parameters<
        typeof s3CredentialProxyHandler
      >[2]
    );
    expect(res.status).toBe(200);
    fetchSpy.mockRestore();
  });
});

describe('s3CredentialProxyHandler dummy header stripping', () => {
  it('strips all dummy auth headers before forwarding', async () => {
    let capturedRequest: Request | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
      capturedRequest = input instanceof Request ? input : new Request(input);
      return new Response('ok', { status: 200 });
    });

    const dummyHeaders: Record<string, string> = {};
    for (const h of DUMMY_AUTH_HEADERS) {
      dummyHeaders[h] = 'dummy-value';
    }
    const req = makeRequest(
      `/${MOUNT_ID}/${BUCKET}/key.txt`,
      'GET',
      dummyHeaders
    );

    await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams()) as Parameters<typeof s3CredentialProxyHandler>[2]
    );

    expect(capturedRequest).toBeDefined();
    // SigV4 signing replaces some dummy headers with real values; verify
    // that none of the forwarded headers carry the original dummy value.
    for (const h of DUMMY_AUTH_HEADERS) {
      expect(capturedRequest!.headers.get(h)).not.toBe('dummy-value');
    }
    // GCS-specific headers must not be present on an S3/R2 signed request
    expect(capturedRequest!.headers.get('x-goog-date')).toBeNull();
    expect(capturedRequest!.headers.get('x-goog-content-sha256')).toBeNull();

    vi.restoreAllMocks();
  });
});

describe('s3CredentialProxyHandler URL reconstruction', () => {
  it('strips the mount ID prefix and forwards to the real endpoint', async () => {
    let capturedRequest: Request | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
      capturedRequest = input instanceof Request ? input : new Request(input);
      return new Response('ok', { status: 200 });
    });

    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/folder/file.txt`);
    await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams()) as Parameters<typeof s3CredentialProxyHandler>[2]
    );

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.url).toContain(
      `${ENDPOINT}/${BUCKET}/folder/file.txt`
    );

    vi.restoreAllMocks();
  });

  it('preserves query parameters when forwarding', async () => {
    let capturedRequest: Request | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
      capturedRequest = input instanceof Request ? input : new Request(input);
      return new Response('ok', { status: 200 });
    });

    const req = makeRequest(
      `/${MOUNT_ID}/${BUCKET}/key.txt?list-type=2&prefix=foo`
    );
    await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams()) as Parameters<typeof s3CredentialProxyHandler>[2]
    );

    expect(capturedRequest!.url).toContain('list-type=2');
    expect(capturedRequest!.url).toContain('prefix=foo');

    vi.restoreAllMocks();
  });
});

describe('s3CredentialProxyHandler SigV4 signing', () => {
  it('adds an AWS4-HMAC-SHA256 Authorization header for r2 provider', async () => {
    let capturedRequest: Request | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
      capturedRequest = input instanceof Request ? input : new Request(input);
      return new Response('ok', { status: 200 });
    });

    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/key.txt`);
    await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(
        makeParams({ provider: 'r2', authStrategy: 's3-sigv4' })
      ) as Parameters<typeof s3CredentialProxyHandler>[2]
    );

    expect(capturedRequest!.headers.get('Authorization')).toMatch(
      /^AWS4-HMAC-SHA256/
    );

    vi.restoreAllMocks();
  });
});

describe('s3CredentialProxyHandler GCS signing', () => {
  it('adds a GOOG4-HMAC-SHA256 Authorization header for gcs provider', async () => {
    let capturedRequest: Request | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
      capturedRequest = input instanceof Request ? input : new Request(input);
      return new Response('ok', { status: 200 });
    });

    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/key.txt`);
    await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(
        makeParams({
          provider: 'gcs',
          authStrategy: 'gcs',
          endpoint: 'https://storage.googleapis.com'
        })
      ) as Parameters<typeof s3CredentialProxyHandler>[2]
    );

    expect(capturedRequest!.headers.get('Authorization')).toMatch(
      /^GOOG4-HMAC-SHA256/
    );
    expect(capturedRequest!.headers.get('x-goog-date')).toBeDefined();
    expect(capturedRequest!.headers.get('x-goog-content-sha256')).toBe(
      'UNSIGNED-PAYLOAD'
    );

    vi.restoreAllMocks();
  });
});

describe('s3CredentialProxyHandler host header handling', () => {
  it('strips the intercepted proxy host header before signing', async () => {
    let capturedRequest: Request | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
      capturedRequest = input instanceof Request ? input : new Request(input);
      return new Response('ok', { status: 200 });
    });

    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/key.txt`, 'GET', {
      host: 's3-credential-proxy.internal'
    });

    await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams()) as Parameters<typeof s3CredentialProxyHandler>[2]
    );

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.headers.get('host')).not.toBe(
      's3-credential-proxy.internal'
    );

    vi.restoreAllMocks();
  });
});
