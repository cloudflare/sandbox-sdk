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

function makeCtxWithContainerId(
  params: S3CredentialProxyParams,
  containerId: string
) {
  return {
    containerId,
    className: 'Sandbox',
    params
  };
}

function makeRequest(
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
  body?: BodyInit
) {
  return new Request(`http://s3-credential-proxy.internal${path}`, {
    method,
    headers,
    body
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

describe('s3CredentialProxyHandler diagnostics', () => {
  it('does not expose diagnostics when debug is disabled', async () => {
    const req = new Request(
      'http://s3-credential-proxy.internal/__sandbox_credential_proxy_diagnostics__'
    );
    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams()) as Parameters<typeof s3CredentialProxyHandler>[2]
    );
    expect(res.status).toBe(404);
  });

  it('records diagnostics when debug is enabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('ok', { status: 200 })
    );

    await s3CredentialProxyHandler(
      makeRequest(`/${MOUNT_ID}/${BUCKET}/key.txt`),
      {
        SANDBOX_CREDENTIAL_PROXY_DEBUG: 'true',
        SANDBOX_CREDENTIAL_PROXY_DIAGNOSTICS_ENDPOINT: 'true'
      } as unknown as Cloudflare.Env,
      makeCtx(makeParams()) as Parameters<typeof s3CredentialProxyHandler>[2]
    );

    const res = await s3CredentialProxyHandler(
      new Request(
        'http://s3-credential-proxy.internal/__sandbox_credential_proxy_diagnostics__'
      ),
      {
        SANDBOX_CREDENTIAL_PROXY_DEBUG: 'true',
        SANDBOX_CREDENTIAL_PROXY_DIAGNOSTICS_ENDPOINT: 'true'
      } as unknown as Cloudflare.Env,
      makeCtx(makeParams()) as Parameters<typeof s3CredentialProxyHandler>[2]
    );
    const body = (await res.json()) as {
      events: Array<{ mountId: string; path: string }>;
    };
    expect(res.status).toBe(200);
    expect(body.events).toContainEqual(
      expect.objectContaining({
        mountId: MOUNT_ID,
        path: `/${BUCKET}/key.txt`
      })
    );

    vi.restoreAllMocks();
  });

  it('only returns diagnostics for the current container', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const env = {
      SANDBOX_CREDENTIAL_PROXY_DEBUG: 'true',
      SANDBOX_CREDENTIAL_PROXY_DIAGNOSTICS_ENDPOINT: 'true'
    } as unknown as Cloudflare.Env;

    await s3CredentialProxyHandler(
      makeRequest(`/${MOUNT_ID}/${BUCKET}/a.txt`),
      env,
      makeCtxWithContainerId(makeParams(), 'ctr-a') as Parameters<
        typeof s3CredentialProxyHandler
      >[2]
    );
    await s3CredentialProxyHandler(
      makeRequest(`/${MOUNT_ID}/${BUCKET}/b.txt`),
      env,
      makeCtxWithContainerId(makeParams(), 'ctr-b') as Parameters<
        typeof s3CredentialProxyHandler
      >[2]
    );

    const res = await s3CredentialProxyHandler(
      new Request(
        'http://s3-credential-proxy.internal/__sandbox_credential_proxy_diagnostics__'
      ),
      env,
      makeCtxWithContainerId(makeParams(), 'ctr-a') as Parameters<
        typeof s3CredentialProxyHandler
      >[2]
    );
    const body = (await res.json()) as {
      events: Array<{ containerId: string; path: string }>;
    };

    expect(body.events).toContainEqual(
      expect.objectContaining({
        containerId: 'ctr-a',
        path: `/${BUCKET}/a.txt`
      })
    );
    expect(body.events).not.toContainEqual(
      expect.objectContaining({ containerId: 'ctr-b' })
    );

    vi.restoreAllMocks();
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

  it('returns 403 for any POST on a read-only mount', async () => {
    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/key.txt?delete`, 'POST');
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
      if (h === 'x-amz-content-sha256') continue;
      expect(capturedRequest!.headers.get(h)).not.toBe('dummy-value');
    }
    expect(capturedRequest!.headers.get('x-amz-content-sha256')).toBe(
      'dummy-value'
    );
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

  it('forwards percent-containing object keys without throwing', async () => {
    let capturedRequest: Request | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
      capturedRequest = input instanceof Request ? input : new Request(input);
      return new Response('ok', { status: 200 });
    });

    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/literal%key.txt`);
    await expect(
      s3CredentialProxyHandler(
        req,
        {} as Cloudflare.Env,
        makeCtx(makeParams()) as Parameters<typeof s3CredentialProxyHandler>[2]
      )
    ).resolves.toBeInstanceOf(Response);

    expect(capturedRequest).toBeDefined();

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
    expect(capturedRequest!.headers.get('x-amz-content-sha256')).toBe(
      'UNSIGNED-PAYLOAD'
    );
    expect(capturedRequest!.headers.get('x-amz-date')).toBeDefined();

    vi.restoreAllMocks();
  });

  it('forwards positive-length request bodies with a body for r2 provider', async () => {
    let capturedRequest: Request | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
      capturedRequest = input instanceof Request ? input : new Request(input);
      return new Response('ok', { status: 200 });
    });

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed-body'));
        controller.close();
      }
    });
    const req = makeRequest(
      `/${MOUNT_ID}/${BUCKET}/key.txt`,
      'PUT',
      {
        'content-type': 'text/plain',
        'content-length': '13',
        'x-amz-content-sha256':
          '9b2885776f8cf270a81d7a8bc7c3df429d19fb78f4a886dd0e626a83d15c8d94'
      },
      body
    );
    await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(
        makeParams({ provider: 'r2', authStrategy: 's3-sigv4' })
      ) as Parameters<typeof s3CredentialProxyHandler>[2]
    );

    expect(capturedRequest!.headers.get('x-amz-content-sha256')).toBe(
      '9b2885776f8cf270a81d7a8bc7c3df429d19fb78f4a886dd0e626a83d15c8d94'
    );
    expect(capturedRequest!.headers.get('content-length')).toBe('13');
    expect(capturedRequest!.headers.get('Authorization')).not.toContain(
      'content-length'
    );
    expect(await capturedRequest!.text()).toBe('streamed-body');

    vi.restoreAllMocks();
  });

  it('short-circuits zero-length r2 object PUT requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/key.txt`, 'PUT', {
      'content-type': 'text/plain',
      'content-length': '0',
      'x-amz-content-sha256':
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    });
    const response = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(
        makeParams({ provider: 'r2', authStrategy: 's3-sigv4' })
      ) as Parameters<typeof s3CredentialProxyHandler>[2]
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('short-circuits r2 directory marker PUT requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/dir/`, 'PUT', {
      'content-length': '0',
      'x-amz-content-sha256':
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    });

    const response = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(
        makeParams({ provider: 'r2', authStrategy: 's3-sigv4' })
      ) as Parameters<typeof s3CredentialProxyHandler>[2]
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBe(
      '"d41d8cd98f00b204e9800998ecf8427e"'
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('short-circuits s3 directory marker PUT requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/dir/`, 'PUT', {
      'content-length': '0',
      'x-amz-content-sha256':
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    });

    const response = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(
        makeParams({ provider: 's3', authStrategy: 's3-sigv4' })
      ) as Parameters<typeof s3CredentialProxyHandler>[2]
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBe(
      '"d41d8cd98f00b204e9800998ecf8427e"'
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('short-circuits s3 zero-length regular object PUT requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/empty.txt`, 'PUT', {
      'content-type': 'text/plain',
      'content-length': '0',
      'x-amz-content-sha256':
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    });

    const response = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(
        makeParams({ provider: 's3', authStrategy: 's3-sigv4' })
      ) as Parameters<typeof s3CredentialProxyHandler>[2]
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('answers HEAD for short-circuited r2 directory markers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const ctx = makeCtx(
      makeParams({ provider: 'r2', authStrategy: 's3-sigv4' })
    ) as Parameters<typeof s3CredentialProxyHandler>[2];
    const putReq = makeRequest(`/${MOUNT_ID}/${BUCKET}/marker/`, 'PUT', {
      'content-length': '0',
      'x-amz-content-sha256':
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    });
    const headReq = makeRequest(`/${MOUNT_ID}/${BUCKET}/marker/`, 'HEAD');

    await s3CredentialProxyHandler(putReq, {} as Cloudflare.Env, ctx);
    const response = await s3CredentialProxyHandler(
      headReq,
      {} as Cloudflare.Env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe('0');
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('answers HEAD for short-circuited zero-length r2 objects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const ctx = makeCtx(
      makeParams({ provider: 'r2', authStrategy: 's3-sigv4' })
    ) as Parameters<typeof s3CredentialProxyHandler>[2];
    const putReq = makeRequest(`/${MOUNT_ID}/${BUCKET}/empty.txt`, 'PUT', {
      'content-length': '0',
      'content-type': 'text/plain',
      'x-amz-content-sha256':
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'x-amz-meta-mode': '33188'
    });
    const headReq = makeRequest(`/${MOUNT_ID}/${BUCKET}/empty.txt`, 'HEAD');

    await s3CredentialProxyHandler(putReq, {} as Cloudflare.Env, ctx);
    const response = await s3CredentialProxyHandler(
      headReq,
      {} as Cloudflare.Env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe('0');
    expect(response.headers.get('Content-Type')).toBe('text/plain');
    expect(response.headers.get('x-amz-meta-mode')).toBe('33188');
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('clears short-circuited zero-length objects on positive-length PUT', async () => {
    const forwardedRequests: Request[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      forwardedRequests.push(
        input instanceof Request ? input : new Request(input)
      );
      return new Response('ok', {
        status: 200,
        headers: { 'Content-Length': '2048' }
      });
    });
    const ctx = makeCtx(
      makeParams({ provider: 'r2', authStrategy: 's3-sigv4' })
    ) as Parameters<typeof s3CredentialProxyHandler>[2];
    const zeroPut = makeRequest(`/${MOUNT_ID}/${BUCKET}/overwrite.txt`, 'PUT', {
      'content-length': '0',
      'x-amz-content-sha256':
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('updated'));
        controller.close();
      }
    });
    const positivePut = makeRequest(
      `/${MOUNT_ID}/${BUCKET}/overwrite.txt`,
      'PUT',
      {
        'content-length': '7',
        'x-amz-content-sha256':
          '27eb5e51506c911f6fc4bb345c0d9db954755119e56d03aec0a59759a03d4f1d'
      },
      body
    );
    const headReq = makeRequest(`/${MOUNT_ID}/${BUCKET}/overwrite.txt`, 'HEAD');

    await s3CredentialProxyHandler(zeroPut, {} as Cloudflare.Env, ctx);
    await s3CredentialProxyHandler(positivePut, {} as Cloudflare.Env, ctx);
    const response = await s3CredentialProxyHandler(
      headReq,
      {} as Cloudflare.Env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe('2048');
    expect(forwardedRequests).toHaveLength(2);

    vi.restoreAllMocks();
  });

  it('clears short-circuited s3 zero-length objects on positive-length PUT', async () => {
    const forwardedRequests: Request[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      forwardedRequests.push(
        input instanceof Request ? input : new Request(input)
      );
      return new Response('ok', {
        status: 200,
        headers: { 'Content-Length': '2048' }
      });
    });
    const ctx = makeCtx(
      makeParams({ provider: 's3', authStrategy: 's3-sigv4' })
    ) as Parameters<typeof s3CredentialProxyHandler>[2];
    const zeroPut = makeRequest(`/${MOUNT_ID}/${BUCKET}/overwrite.txt`, 'PUT', {
      'content-length': '0',
      'x-amz-content-sha256':
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('updated'));
        controller.close();
      }
    });
    const positivePut = makeRequest(
      `/${MOUNT_ID}/${BUCKET}/overwrite.txt`,
      'PUT',
      {
        'content-length': '7',
        'x-amz-content-sha256':
          '27eb5e51506c911f6fc4bb345c0d9db954755119e56d03aec0a59759a03d4f1d'
      },
      body
    );
    const headReq = makeRequest(`/${MOUNT_ID}/${BUCKET}/overwrite.txt`, 'HEAD');

    await s3CredentialProxyHandler(zeroPut, {} as Cloudflare.Env, ctx);
    await s3CredentialProxyHandler(positivePut, {} as Cloudflare.Env, ctx);
    const response = await s3CredentialProxyHandler(
      headReq,
      {} as Cloudflare.Env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe('2048');
    expect(forwardedRequests).toHaveLength(2);

    vi.restoreAllMocks();
  });

  it('canonicalizes repeated and special query parameters for signing', async () => {
    let capturedRequest: Request | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
      capturedRequest = input instanceof Request ? input : new Request(input);
      return new Response('ok', { status: 200 });
    });

    const req = makeRequest(
      `/${MOUNT_ID}/${BUCKET}/key.txt?z=last&a=hello%20world&a=plus%2Bvalue`
    );
    await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams()) as Parameters<typeof s3CredentialProxyHandler>[2]
    );

    expect(capturedRequest!.url).toContain('z=last');
    expect(capturedRequest!.url).toContain('a=hello%20world');
    expect(capturedRequest!.url).toContain('a=plus%2Bvalue');
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

  it('signs gcs requests when endpoint includes an explicit port', async () => {
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
          endpoint: 'https://storage.googleapis.com:443'
        })
      ) as Parameters<typeof s3CredentialProxyHandler>[2]
    );

    expect(capturedRequest!.headers.get('Authorization')).toMatch(
      /^GOOG4-HMAC-SHA256/
    );
    expect(capturedRequest!.headers.get('x-goog-date')).toBeDefined();

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
