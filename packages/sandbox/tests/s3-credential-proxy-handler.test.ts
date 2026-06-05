import { describe, expect, it, vi } from 'vitest';
import {
  DUMMY_AUTH_HEADERS,
  evictDirectoryMarkerCacheForMount,
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
    for (const h of DUMMY_AUTH_HEADERS) {
      expect(capturedRequest!.headers.get(h)).not.toBe('dummy-value');
    }
    expect(capturedRequest!.headers.get('x-amz-content-sha256')).toBe(
      'UNSIGNED-PAYLOAD'
    );
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

describe('s3CredentialProxyHandler mount scope enforcement', () => {
  it('rejects requests for a different bucket', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const req = makeRequest(`/${MOUNT_ID}/other-bucket/key.txt`);

    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams()) as Parameters<typeof s3CredentialProxyHandler>[2]
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('outside mounted bucket scope');
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('rejects object requests outside the configured prefix', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/other/file.txt`);

    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams({ prefix: 'project-a' })) as Parameters<
        typeof s3CredentialProxyHandler
      >[2]
    );

    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('allows object requests inside the configured prefix', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/project-a/file.txt`);

    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams({ prefix: 'project-a' })) as Parameters<
        typeof s3CredentialProxyHandler
      >[2]
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
  });

  it('allows bucket root probes for prefixed mounts without forwarding upstream', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/`);

    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams({ prefix: 'project-a' })) as Parameters<
        typeof s3CredentialProxyHandler
      >[2]
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('rejects list requests outside the configured prefix', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const req = makeRequest(
      `/${MOUNT_ID}/${BUCKET}/project-a/?list-type=2&prefix=other%2F`
    );

    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams({ prefix: 'project-a' })) as Parameters<
        typeof s3CredentialProxyHandler
      >[2]
    );

    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('rejects bucket root list requests without a scoped prefix query', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/?list-type=2`);

    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams({ prefix: 'project-a' })) as Parameters<
        typeof s3CredentialProxyHandler
      >[2]
    );

    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('allows bucket root list requests inside the configured prefix', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const req = makeRequest(
      `/${MOUNT_ID}/${BUCKET}/?delimiter=%2F&max-keys=1000&prefix=project-a%2Fvalidation%2F`
    );

    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams({ prefix: 'project-a' })) as Parameters<
        typeof s3CredentialProxyHandler
      >[2]
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
  });

  it('rejects object requests outside the configured prefix with an allowed query prefix', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const req = makeRequest(
      `/${MOUNT_ID}/${BUCKET}/other/file.txt?prefix=project-a%2F`
    );

    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams({ prefix: 'project-a' })) as Parameters<
        typeof s3CredentialProxyHandler
      >[2]
    );

    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('allows list requests inside the configured prefix', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const req = makeRequest(
      `/${MOUNT_ID}/${BUCKET}/project-a/?list-type=2&prefix=project-a%2Fsub%2F`
    );

    const res = await s3CredentialProxyHandler(
      req,
      {} as Cloudflare.Env,
      makeCtx(makeParams({ prefix: 'project-a' })) as Parameters<
        typeof s3CredentialProxyHandler
      >[2]
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();

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

  it('forwards zero-length object PUT requests upstream', async () => {
    const forwardedRequests: Request[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
      forwardedRequests.push(
        input instanceof Request ? input : new Request(input)
      );
      return new Response(null, { status: 200 });
    });
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
    expect(forwardedRequests).toHaveLength(1);
    expect(forwardedRequests[0].method).toBe('PUT');
    expect(forwardedRequests[0].headers.get('content-length')).toBe('0');
    expect(await forwardedRequests[0].arrayBuffer()).toHaveProperty(
      'byteLength',
      0
    );

    vi.restoreAllMocks();
  });

  it('forwards zero-length directory marker PUT requests upstream', async () => {
    const forwardedRequests: Request[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
      forwardedRequests.push(
        input instanceof Request ? input : new Request(input)
      );
      return new Response(null, { status: 200 });
    });
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
    expect(forwardedRequests).toHaveLength(1);
    expect(forwardedRequests[0].method).toBe('PUT');
    expect(forwardedRequests[0].url).toContain(`${ENDPOINT}/${BUCKET}/dir/`);

    vi.restoreAllMocks();
  });

  it('answers HEAD for zero-length directory marker PUT requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 200 })
    );
    const ctx = makeCtx(
      makeParams({ provider: 'r2', authStrategy: 's3-sigv4' })
    ) as Parameters<typeof s3CredentialProxyHandler>[2];
    const putReq = makeRequest(`/${MOUNT_ID}/${BUCKET}/dir/`, 'PUT', {
      'content-type': 'application/x-directory',
      'content-length': '0',
      'x-amz-meta-mode': '493',
      'x-amz-content-sha256':
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    });
    const headReq = makeRequest(`/${MOUNT_ID}/${BUCKET}/dir`, 'HEAD');

    await s3CredentialProxyHandler(putReq, {} as Cloudflare.Env, ctx);
    const response = await s3CredentialProxyHandler(
      headReq,
      {} as Cloudflare.Env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe('0');
    expect(response.headers.get('Content-Type')).toBe(
      'application/x-directory'
    );
    expect(response.headers.get('x-amz-meta-mode')).toBe('493');

    vi.restoreAllMocks();
  });

  it('forwards HEAD requests upstream after zero-length PUT requests', async () => {
    const forwardedRequests: Request[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      forwardedRequests.push(
        input instanceof Request ? input : new Request(input)
      );
      return new Response(null, { status: 200 });
    });
    const ctx = makeCtx(
      makeParams({ provider: 'r2', authStrategy: 's3-sigv4' })
    ) as Parameters<typeof s3CredentialProxyHandler>[2];
    const zeroPut = makeRequest(`/${MOUNT_ID}/${BUCKET}/empty.txt`, 'PUT', {
      'content-length': '0',
      'x-amz-content-sha256':
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    });
    const headReq = makeRequest(`/${MOUNT_ID}/${BUCKET}/empty.txt`, 'HEAD');

    await s3CredentialProxyHandler(zeroPut, {} as Cloudflare.Env, ctx);
    const response = await s3CredentialProxyHandler(
      headReq,
      {} as Cloudflare.Env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(forwardedRequests).toHaveLength(2);
    expect(forwardedRequests[1].method).toBe('HEAD');

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

  it('forwards zero-length gcs PUT requests with an empty body', async () => {
    let capturedRequest: Request | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
      capturedRequest = input instanceof Request ? input : new Request(input);
      return new Response('ok', { status: 200 });
    });

    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/empty.txt`, 'PUT', {
      'content-length': '0'
    });
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

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.method).toBe('PUT');
    expect(capturedRequest!.headers.get('content-length')).toBeNull();
    expect(capturedRequest!.headers.get('Authorization')).toMatch(
      /^GOOG4-HMAC-SHA256/
    );
    expect(capturedRequest!.headers.get('Authorization')).not.toContain(
      'content-length'
    );
    expect(await capturedRequest!.arrayBuffer()).toHaveProperty(
      'byteLength',
      0
    );

    vi.restoreAllMocks();
  });

  it('does not forward x-amz headers to gcs upstream requests', async () => {
    let capturedRequest: Request | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
      capturedRequest = input instanceof Request ? input : new Request(input);
      return new Response('ok', { status: 200 });
    });

    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/small.txt`, 'PUT', {
      'content-type': 'text/plain',
      expect: ':',
      'content-length': '1024',
      'x-amz-content-sha256':
        'a3c9b4d194aedb820ad8b22957a67476e6b737950db3777d8f25fb8d1419cf27',
      'x-amz-meta-mode': '33188'
    });
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

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.headers.get('x-amz-content-sha256')).toBeNull();
    expect(capturedRequest!.headers.get('x-amz-meta-mode')).toBeNull();
    expect(capturedRequest!.headers.get('expect')).toBeNull();
    expect(capturedRequest!.headers.get('content-length')).toBeNull();
    expect(capturedRequest!.headers.get('x-goog-meta-mode')).toBe('33188');
    expect(capturedRequest!.headers.get('x-goog-content-sha256')).toBe(
      'UNSIGNED-PAYLOAD'
    );
    expect(capturedRequest!.headers.get('Authorization')).toMatch(
      /^GOOG4-HMAC-SHA256/
    );
    expect(capturedRequest!.headers.get('Authorization')).not.toContain(
      'x-amz'
    );
    expect(capturedRequest!.headers.get('Authorization')).not.toContain(
      'content-length'
    );

    vi.restoreAllMocks();
  });

  it('does not forward expect headers to gcs upstream requests', async () => {
    let capturedRequest: Request | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
      capturedRequest = input instanceof Request ? input : new Request(input);
      return new Response('ok', { status: 200 });
    });

    const req = makeRequest(`/${MOUNT_ID}/${BUCKET}/key.txt`, 'PUT', {
      expect: ''
    });
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

    expect(capturedRequest!.headers.has('expect')).toBe(false);

    vi.restoreAllMocks();
  });

  it('answers HEAD for gcs zero-length directory marker PUT requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 200 })
    );
    const ctx = makeCtx(
      makeParams({
        provider: 'gcs',
        authStrategy: 'gcs',
        endpoint: 'https://storage.googleapis.com'
      })
    ) as Parameters<typeof s3CredentialProxyHandler>[2];
    const putReq = makeRequest(`/${MOUNT_ID}/${BUCKET}/gcs-dir/`, 'PUT', {
      'content-type': 'application/x-directory',
      'content-length': '0',
      'x-amz-meta-mode': '493'
    });
    const headReq = makeRequest(`/${MOUNT_ID}/${BUCKET}/gcs-dir`, 'HEAD');

    const putResponse = await s3CredentialProxyHandler(
      putReq,
      {} as Cloudflare.Env,
      ctx
    );
    const headResponse = await s3CredentialProxyHandler(
      headReq,
      {} as Cloudflare.Env,
      ctx
    );

    expect(putResponse.status).toBe(200);
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get('Content-Length')).toBe('0');
    expect(headResponse.headers.get('Content-Type')).toBe(
      'application/x-directory'
    );
    expect(headResponse.headers.get('x-amz-meta-mode')).toBe('493');

    vi.restoreAllMocks();
  });
});

describe('s3CredentialProxyHandler directory marker cache eviction', () => {
  it('evicts directory marker cache entries for a mount on evictDirectoryMarkerCacheForMount', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const ctx = makeCtx(
      makeParams({ provider: 'r2', authStrategy: 's3-sigv4' })
    ) as Parameters<typeof s3CredentialProxyHandler>[2];

    const putReq = makeRequest(`/${MOUNT_ID}/${BUCKET}/evict-dir/`, 'PUT', {
      'content-length': '0',
      'x-amz-content-sha256':
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    });
    await s3CredentialProxyHandler(putReq, {} as Cloudflare.Env, ctx);

    evictDirectoryMarkerCacheForMount(MOUNT_ID);

    const headReq = makeRequest(`/${MOUNT_ID}/${BUCKET}/evict-dir`, 'HEAD');
    await s3CredentialProxyHandler(headReq, {} as Cloudflare.Env, ctx);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0]).toBeInstanceOf(Request);
    expect((fetchSpy.mock.calls[1][0] as Request).method).toBe('HEAD');

    vi.restoreAllMocks();
  });

  it('only evicts cache entries for the given mount ID', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const OTHER_MOUNT_ID = 'bbbbcccc-dddd-eeee-ffff-000011112222';
    const ctxA = makeCtx(
      makeParams({ provider: 'r2', authStrategy: 's3-sigv4' })
    ) as Parameters<typeof s3CredentialProxyHandler>[2];
    const ctxB = makeCtx(
      makeParams({ provider: 'r2', authStrategy: 's3-sigv4' })
    ) as Parameters<typeof s3CredentialProxyHandler>[2];
    (ctxB as Record<string, unknown>).params = {
      mounts: { [OTHER_MOUNT_ID]: makeParams().mounts[MOUNT_ID] }
    };

    await s3CredentialProxyHandler(
      makeRequest(`/${MOUNT_ID}/${BUCKET}/dir-a/`, 'PUT', {
        'content-length': '0',
        'x-amz-content-sha256':
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      }),
      {} as Cloudflare.Env,
      ctxA
    );
    await s3CredentialProxyHandler(
      makeRequest(`/${OTHER_MOUNT_ID}/${BUCKET}/dir-b/`, 'PUT', {
        'content-length': '0',
        'x-amz-content-sha256':
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      }),
      {} as Cloudflare.Env,
      ctxB
    );

    evictDirectoryMarkerCacheForMount(MOUNT_ID);

    const headA = await s3CredentialProxyHandler(
      makeRequest(`/${MOUNT_ID}/${BUCKET}/dir-a`, 'HEAD'),
      {} as Cloudflare.Env,
      ctxA
    );
    const headB = await s3CredentialProxyHandler(
      makeRequest(`/${OTHER_MOUNT_ID}/${BUCKET}/dir-b`, 'HEAD'),
      {} as Cloudflare.Env,
      ctxB
    );

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(headA.status).toBe(200);
    expect(headB.status).toBe(200);

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
