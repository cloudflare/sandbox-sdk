import { describe, expect, it, vi } from 'vitest';
import {
  type R2EgressParams,
  r2EgressHandler
} from '../src/storage-mount/r2-egress-handler';

// ---------------------------------------------------------------------------
// Mock R2 binding factory
// ---------------------------------------------------------------------------

interface MockObject {
  body: string;
  contentType?: string;
  customMetadata?: Record<string, string>;
  etag?: string;
  storageClass?: 'Standard' | 'InfrequentAccess';
  failArrayBuffer?: boolean;
}

function makeR2Object(key: string, obj: MockObject): R2ObjectBody {
  const etag = obj.etag ?? `"etag-${key}"`;
  const size = obj.body.length;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(obj.body));
      controller.close();
    }
  });
  return {
    key,
    size,
    etag: etag.replace(/"/g, ''),
    httpEtag: etag,
    uploaded: new Date('2024-01-01T00:00:00Z'),
    httpMetadata: obj.contentType ? { contentType: obj.contentType } : {},
    customMetadata: obj.customMetadata ?? {},
    storageClass: obj.storageClass ?? 'Standard',
    body: stream,
    bodyUsed: false,
    text: () => Promise.resolve(obj.body),
    arrayBuffer: () => {
      if (obj.failArrayBuffer) {
        throw new Error('arrayBuffer should not be called');
      }
      return Promise.resolve(encoder.encode(obj.body).buffer as ArrayBuffer);
    },
    json: () => Promise.resolve(JSON.parse(obj.body)),
    blob: () => Promise.resolve(new Blob([obj.body]))
  } as unknown as R2ObjectBody;
}

function makeR2Head(key: string, obj: MockObject): R2Object {
  const etag = obj.etag ?? `"etag-${key}"`;
  return {
    key,
    size: obj.body.length,
    etag: etag.replace(/"/g, ''),
    httpEtag: etag,
    uploaded: new Date('2024-01-01T00:00:00Z'),
    httpMetadata: obj.contentType ? { contentType: obj.contentType } : {},
    customMetadata: obj.customMetadata ?? {},
    storageClass: obj.storageClass ?? 'Standard'
  } as unknown as R2Object;
}

function sliceBody(body: string, range: R2Range): string {
  if ('suffix' in range) {
    return body.slice(-range.suffix);
  }
  const offset = range.offset ?? 0;
  return range.length !== undefined
    ? body.slice(offset, offset + range.length)
    : body.slice(offset);
}

async function readBodyValue(value: unknown): Promise<string> {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(value);
  }
  if (value instanceof ReadableStream) {
    const reader = value.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (chunk) chunks.push(chunk as Uint8Array);
    }
    return new TextDecoder().decode(
      chunks.reduce((acc, c) => {
        const merged = new Uint8Array(acc.length + c.length);
        merged.set(acc);
        merged.set(c, acc.length);
        return merged;
      }, new Uint8Array(0))
    );
  }
  return '';
}

function createMockR2Bucket(store: Map<string, MockObject>): R2Bucket {
  const uploads = new Map<
    string,
    { key: string; parts: Map<number, string> }
  >();

  return {
    get: vi.fn(async (key: string, opts?: { range?: R2Range }) => {
      const obj = store.get(key);
      if (!obj) return null;
      if (opts?.range) {
        return makeR2Object(key, {
          ...obj,
          body: sliceBody(obj.body, opts.range)
        });
      }
      return makeR2Object(key, obj);
    }),
    put: vi.fn(async (key: string, value: unknown, options?: R2PutOptions) => {
      const body = await readBodyValue(value);
      const httpMetadata = options?.httpMetadata;
      const contentType =
        typeof httpMetadata === 'object' &&
        httpMetadata &&
        'contentType' in httpMetadata
          ? httpMetadata.contentType
          : undefined;
      const stored: MockObject = {
        body,
        contentType,
        customMetadata: options?.customMetadata,
        storageClass:
          options?.storageClass === 'Standard' ||
          options?.storageClass === 'InfrequentAccess'
            ? options.storageClass
            : undefined
      };
      store.set(key, stored);
      return makeR2Head(key, stored);
    }),
    head: vi.fn(async (key: string) => {
      const obj = store.get(key);
      return obj ? makeR2Head(key, obj) : null;
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (opts?: R2ListOptions) => {
      const prefix = opts?.prefix ?? '';
      const delimiter = opts?.delimiter ?? '';
      const limit = opts?.limit ?? 1000;

      const allKeys = [...store.keys()].filter((k) =>
        prefix ? k.startsWith(prefix) : true
      );

      const prefixSet = new Set<string>();
      const objects: R2Object[] = [];

      for (const key of allKeys) {
        if (delimiter) {
          const rest = key.slice(prefix.length);
          const delimIdx = rest.indexOf(delimiter);
          if (delimIdx !== -1) {
            prefixSet.add(prefix + rest.slice(0, delimIdx + 1));
            continue;
          }
        }
        objects.push(makeR2Head(key, store.get(key)!));
        if (objects.length >= limit) break;
      }

      return {
        objects,
        truncated: false,
        cursor: undefined,
        delimitedPrefixes: [...prefixSet]
      } as unknown as R2Objects;
    }),
    createMultipartUpload: vi.fn(async (key: string) => {
      const uploadId = `upload-${key}-${Date.now()}`;
      uploads.set(uploadId, { key, parts: new Map() });
      return {
        key,
        uploadId,
        uploadPart: vi.fn(async (partNumber: number, value: unknown) => {
          const body = await readBodyValue(value);
          uploads.get(uploadId)!.parts.set(partNumber, body);
          return { partNumber, etag: `part-etag-${partNumber}` };
        }),
        complete: vi.fn(async () => {
          const upload = uploads.get(uploadId)!;
          const combined = [...upload.parts.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, v]) => v)
            .join('');
          store.set(key, { body: combined });
          return makeR2Head(key, { body: combined });
        }),
        abort: vi.fn(async () => {
          uploads.delete(uploadId);
        })
      } as unknown as R2MultipartUpload;
    }),
    resumeMultipartUpload: vi.fn((key: string, uploadId: string) => {
      return {
        key,
        uploadId,
        uploadPart: vi.fn(async (partNumber: number) => ({
          partNumber,
          etag: `part-etag-${partNumber}`
        })),
        complete: vi.fn(async (parts: R2UploadedPart[]) => {
          const joined = parts.map((p) => `part-${p.partNumber}`).join('');
          store.set(key, { body: joined });
          return makeR2Head(key, { body: joined });
        }),
        abort: vi.fn(async () => {
          uploads.delete(uploadId);
        })
      } as unknown as R2MultipartUpload;
    })
  } as unknown as R2Bucket;
}

function makeEnv(bucket: R2Bucket, bindingName = 'MY_BUCKET'): Cloudflare.Env {
  return { [bindingName]: bucket } as unknown as Cloudflare.Env;
}

function makeCtx(params: R2EgressParams = { buckets: { MY_BUCKET: {} } }) {
  return { containerId: 'test-container', className: 'Sandbox', params };
}

function req(method: string, path: string, body?: string): Request {
  return new Request(`http://r2.internal${path}`, {
    method,
    body: body ?? null,
    headers: body ? { 'Content-Type': 'application/octet-stream' } : {}
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('r2EgressHandler', () => {
  describe('GetBucketLocation', () => {
    it('returns LocationConstraint XML', async () => {
      const r2 = createMockR2Bucket(new Map());
      const res = await r2EgressHandler(
        req('GET', '/MY_BUCKET?location'),
        makeEnv(r2),
        makeCtx()
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('<LocationConstraint');
    });
  });

  describe('ListObjectsV2', () => {
    it('returns ListBucketResult XML with objects', async () => {
      const store = new Map<string, MockObject>([
        ['file1.txt', { body: 'hello' }],
        ['file2.txt', { body: 'world' }]
      ]);
      const r2 = createMockR2Bucket(store);
      const res = await r2EgressHandler(
        req('GET', '/MY_BUCKET?list-type=2'),
        makeEnv(r2),
        makeCtx()
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('<ListBucketResult');
      expect(text).toContain('<Key>file1.txt</Key>');
      expect(text).toContain('<Key>file2.txt</Key>');
      expect(text).toContain('<IsTruncated>false</IsTruncated>');
    });

    it('returns CommonPrefixes when delimiter is provided', async () => {
      const store = new Map<string, MockObject>([
        ['folder/a.txt', { body: 'a' }],
        ['folder/b.txt', { body: 'b' }],
        ['root.txt', { body: 'r' }]
      ]);
      const r2 = createMockR2Bucket(store);
      const res = await r2EgressHandler(
        req('GET', '/MY_BUCKET?list-type=2&delimiter=/'),
        makeEnv(r2),
        makeCtx()
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('<CommonPrefixes>');
      expect(text).toContain('<Prefix>folder/</Prefix>');
      expect(text).toContain('<Key>root.txt</Key>');
    });
  });

  describe('HeadObject', () => {
    it('returns 200 with metadata headers for existing key', async () => {
      const store = new Map<string, MockObject>([
        ['test.txt', { body: 'hello', contentType: 'text/plain' }]
      ]);
      const r2 = createMockR2Bucket(store);
      const res = await r2EgressHandler(
        req('HEAD', '/MY_BUCKET/test.txt'),
        makeEnv(r2),
        makeCtx()
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Length')).toBe('5');
      expect(res.headers.get('Content-Type')).toBe('text/plain');
      expect(res.headers.get('ETag')).toBeTruthy();
    });

    it('returns 404 for missing key', async () => {
      const r2 = createMockR2Bucket(new Map());
      const res = await r2EgressHandler(
        req('HEAD', '/MY_BUCKET/missing.txt'),
        makeEnv(r2),
        makeCtx()
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GetObject', () => {
    it('returns object body with 200', async () => {
      const store = new Map<string, MockObject>([
        ['hello.txt', { body: 'Hello, World!', failArrayBuffer: true }]
      ]);
      const r2 = createMockR2Bucket(store);
      const res = await r2EgressHandler(
        req('GET', '/MY_BUCKET/hello.txt'),
        makeEnv(r2),
        makeCtx()
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe('Hello, World!');
    });

    it('returns 404 for missing key', async () => {
      const r2 = createMockR2Bucket(new Map());
      const res = await r2EgressHandler(
        req('GET', '/MY_BUCKET/missing.txt'),
        makeEnv(r2),
        makeCtx()
      );
      expect(res.status).toBe(404);
    });

    it('returns 206 with correct Content-Range for a fixed byte range', async () => {
      const store = new Map<string, MockObject>([
        ['large.bin', { body: '0123456789', failArrayBuffer: true }]
      ]);
      const r2 = createMockR2Bucket(store);
      const res = await r2EgressHandler(
        new Request('http://r2.internal/MY_BUCKET/large.bin', {
          headers: { Range: 'bytes=2-5' }
        }),
        makeEnv(r2),
        makeCtx()
      );
      expect(res.status).toBe(206);
      expect(res.headers.get('Content-Range')).toBe('bytes 2-5/10');
      expect(res.headers.get('Content-Length')).toBe('4');
      expect(await res.text()).toBe('2345');
    });

    it('returns 206 with correct Content-Range for an open-ended range', async () => {
      const store = new Map<string, MockObject>([
        ['large.bin', { body: '0123456789' }]
      ]);
      const r2 = createMockR2Bucket(store);
      const res = await r2EgressHandler(
        new Request('http://r2.internal/MY_BUCKET/large.bin', {
          headers: { Range: 'bytes=7-' }
        }),
        makeEnv(r2),
        makeCtx()
      );
      expect(res.status).toBe(206);
      expect(res.headers.get('Content-Range')).toBe('bytes 7-9/10');
      expect(res.headers.get('Content-Length')).toBe('3');
    });

    it('advertises Accept-Ranges: bytes on non-range GET responses', async () => {
      const store = new Map<string, MockObject>([
        ['file.txt', { body: 'hello' }]
      ]);
      const r2 = createMockR2Bucket(store);
      const res = await r2EgressHandler(
        req('GET', '/MY_BUCKET/file.txt'),
        makeEnv(r2),
        makeCtx()
      );
      expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    });
  });

  describe('PutObject', () => {
    it('stores object and returns 200 with ETag', async () => {
      const store = new Map<string, MockObject>();
      const r2 = createMockR2Bucket(store);
      const res = await r2EgressHandler(
        new Request('http://r2.internal/MY_BUCKET/new-file.txt', {
          method: 'PUT',
          body: 'new content',
          headers: {
            'Content-Length': '11',
            'Content-Type': 'text/plain'
          }
        }),
        makeEnv(r2),
        makeCtx()
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('ETag')).toBeTruthy();
      expect(store.has('new-file.txt')).toBe(true);
      expect(r2.put).toHaveBeenCalledTimes(1);
      expect(r2.put).toHaveBeenCalledWith(
        'new-file.txt',
        expect.any(ReadableStream),
        { httpMetadata: { contentType: 'text/plain' } }
      );
      expect(r2.createMultipartUpload).not.toHaveBeenCalled();
      expect(store.get('new-file.txt')?.body).toBe('new content');
    });

    it('accepts zero-length PUT requests with no body stream', async () => {
      const store = new Map<string, MockObject>();
      const r2 = createMockR2Bucket(store);
      const request = {
        method: 'PUT',
        url: 'http://r2.internal/MY_BUCKET/empty.txt',
        headers: new Headers({
          'Content-Length': '0',
          'Content-Type': 'text/plain'
        }),
        body: null
      } as unknown as Request;

      const res = await r2EgressHandler(request, makeEnv(r2), makeCtx());

      expect(res.status).toBe(200);
      expect(res.headers.get('ETag')).toBeTruthy();
      expect(store.get('empty.txt')?.body).toBe('');
      expect(store.get('empty.txt')?.contentType).toBe('text/plain');
    });

    it('copies an object when x-amz-copy-source is present', async () => {
      const store = new Map<string, MockObject>([
        [
          'source.txt',
          {
            body: 'copy me',
            contentType: 'text/plain',
            customMetadata: { source: 'yes' },
            failArrayBuffer: true
          }
        ]
      ]);
      const r2 = createMockR2Bucket(store);
      const res = await r2EgressHandler(
        new Request('http://r2.internal/MY_BUCKET/copied.txt', {
          method: 'PUT',
          headers: { 'x-amz-copy-source': '/MY_BUCKET/source.txt' }
        }),
        makeEnv(r2),
        makeCtx()
      );

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('<CopyObjectResult');
      expect(store.get('copied.txt')).toEqual({
        body: 'copy me',
        contentType: 'text/plain',
        customMetadata: { source: 'yes' },
        storageClass: 'Standard'
      });
    });

    it('replaces metadata on copy when requested', async () => {
      const store = new Map<string, MockObject>([
        ['source.txt', { body: 'copy me', contentType: 'text/plain' }]
      ]);
      const r2 = createMockR2Bucket(store);
      const res = await r2EgressHandler(
        new Request('http://r2.internal/MY_BUCKET/copied.txt', {
          method: 'PUT',
          headers: {
            'x-amz-copy-source': '/MY_BUCKET/source.txt',
            'x-amz-metadata-directive': 'REPLACE',
            'Content-Type': 'application/json'
          }
        }),
        makeEnv(r2),
        makeCtx()
      );

      expect(res.status).toBe(200);
      expect(store.get('copied.txt')?.contentType).toBe('application/json');
    });
  });

  describe('DeleteObject', () => {
    it('deletes object and returns 204', async () => {
      const store = new Map<string, MockObject>([
        ['to-delete.txt', { body: 'gone' }]
      ]);
      const r2 = createMockR2Bucket(store);
      const res = await r2EgressHandler(
        req('DELETE', '/MY_BUCKET/to-delete.txt'),
        makeEnv(r2),
        makeCtx()
      );
      expect(res.status).toBe(204);
      expect(store.has('to-delete.txt')).toBe(false);
    });
  });

  describe('Multipart upload', () => {
    it('initiates multipart upload and returns XML with uploadId', async () => {
      const r2 = createMockR2Bucket(new Map());
      const res = await r2EgressHandler(
        req('POST', '/MY_BUCKET/big-file.bin?uploads'),
        makeEnv(r2),
        makeCtx()
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('<InitiateMultipartUploadResult');
      expect(text).toContain('<Bucket>MY_BUCKET</Bucket>');
      expect(text).toContain('<Key>big-file.bin</Key>');
      expect(text).toContain('<UploadId>');
    });

    it('completes multipart upload and returns ETag', async () => {
      const store = new Map<string, MockObject>();
      const r2 = createMockR2Bucket(store);

      // Initiate
      const initRes = await r2EgressHandler(
        req('POST', '/MY_BUCKET/big-file.bin?uploads'),
        makeEnv(r2),
        makeCtx()
      );
      const initText = await initRes.text();
      const uploadIdMatch = /<UploadId>([^<]+)<\/UploadId>/.exec(initText);
      const uploadId = uploadIdMatch![1];

      // Complete
      const completeBody = `<CompleteMultipartUpload>
        <Part><PartNumber>1</PartNumber><ETag>"part-etag-1"</ETag></Part>
        <Part><PartNumber>2</PartNumber><ETag>"part-etag-2"</ETag></Part>
      </CompleteMultipartUpload>`;

      const completeRes = await r2EgressHandler(
        new Request(
          `http://r2.internal/MY_BUCKET/big-file.bin?uploadId=${uploadId}`,
          { method: 'POST', body: completeBody }
        ),
        makeEnv(r2),
        makeCtx()
      );
      expect(completeRes.status).toBe(200);
      const completeText = await completeRes.text();
      expect(completeText).toContain('<CompleteMultipartUploadResult');
      expect(completeText).toContain('<ETag>');
    });

    it('aborts multipart upload and returns 204', async () => {
      const r2 = createMockR2Bucket(new Map());

      const initRes = await r2EgressHandler(
        req('POST', '/MY_BUCKET/abort-test.bin?uploads'),
        makeEnv(r2),
        makeCtx()
      );
      const initText = await initRes.text();
      const uploadIdMatch = /<UploadId>([^<]+)<\/UploadId>/.exec(initText);
      const uploadId = uploadIdMatch![1];

      const abortRes = await r2EgressHandler(
        req('DELETE', `/MY_BUCKET/abort-test.bin?uploadId=${uploadId}`),
        makeEnv(r2),
        makeCtx()
      );
      expect(abortRes.status).toBe(204);
    });
  });

  describe('read-only mounts', () => {
    const readOnlyCtx = () =>
      makeCtx({ buckets: { MY_BUCKET: { readOnly: true } } });

    it('allows read operations', async () => {
      const store = new Map<string, MockObject>([
        ['readable.txt', { body: 'read me' }]
      ]);
      const r2 = createMockR2Bucket(store);

      const res = await r2EgressHandler(
        req('GET', '/MY_BUCKET/readable.txt'),
        makeEnv(r2),
        readOnlyCtx()
      );

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('read me');
    });

    it.each([
      ['PUT', '/MY_BUCKET/new-file.txt'],
      ['DELETE', '/MY_BUCKET/existing.txt'],
      ['POST', '/MY_BUCKET/big-file.bin?uploads'],
      ['POST', '/MY_BUCKET/big-file.bin?uploadId=upload-1'],
      ['DELETE', '/MY_BUCKET/big-file.bin?uploadId=upload-1']
    ])('rejects mutating operation %s %s', async (method, path) => {
      const r2 = createMockR2Bucket(new Map());

      const res = await r2EgressHandler(
        req(method, path, method === 'POST' ? '<xml />' : undefined),
        makeEnv(r2),
        readOnlyCtx()
      );

      expect(res.status).toBe(403);
      expect(await res.text()).toContain('read-only');
    });

    it('rejects copy object requests', async () => {
      const r2 = createMockR2Bucket(new Map());

      const res = await r2EgressHandler(
        new Request('http://r2.internal/MY_BUCKET/copied.txt', {
          method: 'PUT',
          headers: { 'x-amz-copy-source': '/MY_BUCKET/source.txt' }
        }),
        makeEnv(r2),
        readOnlyCtx()
      );

      expect(res.status).toBe(403);
      expect(await res.text()).toContain('read-only');
    });
  });

  describe('Bucket allowlist', () => {
    it('returns 403 when bucket is not in the allowlist', async () => {
      const r2 = createMockR2Bucket(new Map([['key.txt', { body: 'hi' }]]));
      const res = await r2EgressHandler(
        req('GET', '/OTHER_BUCKET/key.txt'),
        makeEnv(r2, 'OTHER_BUCKET'),
        makeCtx()
      );
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).toContain('OTHER_BUCKET');
    });

    it('returns 403 when bucket is not in params', async () => {
      const r2 = createMockR2Bucket(new Map([['key.txt', { body: 'hi' }]]));
      const res = await r2EgressHandler(
        req('GET', '/MY_BUCKET/key.txt'),
        makeEnv(r2),
        {
          containerId: 'test-container',
          className: 'Sandbox',
          params: { buckets: {} }
        }
      );
      expect(res.status).toBe(403);
    });

    it('returns 500 when bucket is in allowlist but not in env', async () => {
      const res = await r2EgressHandler(
        req('GET', '/MY_BUCKET/some-key'),
        {} as Cloudflare.Env,
        makeCtx()
      );
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toContain('MY_BUCKET');
    });
  });

  describe('XML escaping', () => {
    it('escapes special characters in object keys', async () => {
      const store = new Map<string, MockObject>([
        ['path/with <special> & "chars"', { body: 'content' }]
      ]);
      const r2 = createMockR2Bucket(store);
      const res = await r2EgressHandler(
        req('GET', '/MY_BUCKET?list-type=2'),
        makeEnv(r2),
        makeCtx()
      );
      const text = await res.text();
      expect(text).toContain('&lt;special&gt;');
      expect(text).toContain('&amp;');
    });
  });
});
