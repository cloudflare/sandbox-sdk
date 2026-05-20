import type { PortExposeResult, Process } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import {
  getContainerStatus,
  stopContainerAndWait as stopContainer
} from './helpers/container-lifecycle';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';

const skipPortExposureTests =
  process.env.TEST_WORKER_URL?.endsWith('.workers.dev') ?? false;
const PREVIEW_LIFECYCLE_PORT = 9852;
const PREVIEW_TOKEN = 'lifecycleok';

async function writePreviewServer(
  workerUrl: string,
  headers: Record<string, string>
): Promise<void> {
  const serverCode = `
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: ${PREVIEW_LIFECYCLE_PORT},
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) {
        return;
      }
      return new Response("Expected WebSocket", { status: 400 });
    }
    if (url.pathname === "/hello") {
      return new Response("hello from lifecycle port", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    message(ws, message) {
      ws.send(message);
    }
  }
});
await Bun.sleep(300000);
  `.trim();

  const response = await fetch(`${workerUrl}/api/file/write`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      path: '/workspace/preview-lifecycle-server.ts',
      content: serverCode
    })
  });
  expect(response.status).toBe(200);
}

async function startPreviewServer(
  workerUrl: string,
  headers: Record<string, string>
): Promise<void> {
  await writePreviewServer(workerUrl, headers);

  const startResponse = await fetch(`${workerUrl}/api/process/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      command: 'bun run /workspace/preview-lifecycle-server.ts'
    })
  });
  expect(startResponse.status).toBe(200);
  const process = (await startResponse.json()) as Pick<Process, 'id'>;

  const waitPortResponse = await fetch(
    `${workerUrl}/api/process/${process.id}/waitForPort`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        port: PREVIEW_LIFECYCLE_PORT,
        timeout: 15000,
        mode: 'tcp'
      })
    }
  );
  expect(waitPortResponse.status).toBe(200);
}

async function exposeLifecyclePort(
  workerUrl: string,
  headers: Record<string, string>
): Promise<string> {
  const exposeResponse = await fetch(`${workerUrl}/api/port/expose`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      port: PREVIEW_LIFECYCLE_PORT,
      name: 'preview-lifecycle',
      token: PREVIEW_TOKEN
    })
  });
  expect(exposeResponse.status).toBe(200);
  const preview = (await exposeResponse.json()) as PortExposeResult;
  return preview.url;
}

type ExposedPortsResponse = Array<{
  port: number;
  url: string;
  status: string;
}>;

function previewURL(previewUrl: string, path: string): string {
  return new URL(path, previewUrl).toString();
}

function previewWebSocketURL(previewUrl: string, path: string): string {
  return previewURL(previewUrl, path).replace(/^http/, 'ws');
}

async function connectWebSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WebSocket open timeout')), 10_000);
  });
  return ws;
}

async function expectWebSocketStatus(
  url: string,
  expectedStatus: number
): Promise<void> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.on('unexpected-response', (_request, response) => {
      try {
        expect(response.statusCode).toBe(expectedStatus);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        ws.close();
      }
    });
    ws.on('open', () => {
      ws.close();
      reject(new Error('WebSocket connected unexpectedly'));
    });
    ws.on('error', reject);
    setTimeout(
      () => reject(new Error('WebSocket status assertion timeout')),
      10_000
    );
  });
}

function replacePreviewToken(previewUrl: string, replacement: string): string {
  const url = new URL(previewUrl);
  const firstDot = url.hostname.indexOf('.');
  const subdomain = url.hostname.slice(0, firstDot);
  const domain = url.hostname.slice(firstDot + 1);
  const lastHyphen = subdomain.lastIndexOf('-');
  url.hostname = `${subdomain.slice(0, lastHyphen + 1)}${replacement}.${domain}`;
  return url.toString();
}

async function writeUnrelatedRuntimeFile(
  workerUrl: string,
  headers: Record<string, string>
): Promise<void> {
  const response = await fetch(`${workerUrl}/api/file/write`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      path: '/workspace/preview-lifecycle-unrelated.txt',
      content: `unrelated runtime start ${Date.now()}`
    })
  });
  expect(response.status).toBe(200);
}

describe('Preview URL lifecycle', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let portHeaders: Record<string, string>;
  let sandbox: TestSandbox | null = null;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers(createUniqueSession());
    // Port APIs use the sandbox's default session, while file/process setup
    // uses the test session headers for deterministic workspace state.
    portHeaders = { ...headers };
    delete portHeaders['X-Session-Id'];
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
  }, 120000);

  test.skipIf(skipPortExposureTests)(
    'valid preview URL reaches a service in the current runtime',
    async () => {
      try {
        await startPreviewServer(workerUrl, headers);
        const previewUrl = await exposeLifecyclePort(workerUrl, portHeaders);

        const response = await fetch(previewURL(previewUrl, '/hello'));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('hello from lifecycle port');
      } finally {
        await stopContainer(workerUrl, portHeaders).catch(() => undefined);
      }
    },
    180000
  );

  test.skipIf(skipPortExposureTests)(
    'WebSocket preview URL connects only while activated in the current runtime',
    async () => {
      let ws: WebSocket | null = null;
      try {
        await startPreviewServer(workerUrl, headers);
        const previewUrl = await exposeLifecyclePort(workerUrl, portHeaders);

        ws = await connectWebSocket(previewWebSocketURL(previewUrl, '/ws'));
        const echoPromise = new Promise<string>((resolve, reject) => {
          ws?.on('message', (data) => resolve(data.toString()));
          setTimeout(() => reject(new Error('WebSocket echo timeout')), 5_000);
        });
        ws.send('preview websocket lifecycle');
        expect(await echoPromise).toBe('preview websocket lifecycle');
        ws.close();
        ws = null;

        await stopContainer(workerUrl, portHeaders);
        expect(await getContainerStatus(workerUrl, portHeaders)).not.toBe(
          'healthy'
        );

        await expectWebSocketStatus(
          previewWebSocketURL(previewUrl, '/ws'),
          410
        );
        expect(await getContainerStatus(workerUrl, portHeaders)).not.toBe(
          'healthy'
        );
      } finally {
        ws?.close();
        await stopContainer(workerUrl, portHeaders).catch(() => undefined);
      }
    },
    180000
  );

  test.skipIf(skipPortExposureTests)(
    'authorized preview URL after container stop is stale and does not wake the container',
    async () => {
      try {
        await startPreviewServer(workerUrl, headers);
        const previewUrl = await exposeLifecyclePort(workerUrl, portHeaders);

        const healthyResponse = await fetch(previewURL(previewUrl, '/hello'));
        expect(healthyResponse.status).toBe(200);

        await stopContainer(workerUrl, portHeaders);
        expect(await getContainerStatus(workerUrl, portHeaders)).not.toBe(
          'healthy'
        );

        const staleResponse = await fetch(previewURL(previewUrl, '/hello'));
        expect(staleResponse.status).toBe(410);
        expect(await staleResponse.json()).toMatchObject({
          code: 'STALE_PREVIEW_URL'
        });
        expect(await getContainerStatus(workerUrl, portHeaders)).not.toBe(
          'healthy'
        );
      } finally {
        await stopContainer(workerUrl, portHeaders).catch(() => undefined);
      }
    },
    180000
  );

  test.skipIf(skipPortExposureTests)(
    'bad token after container stop is rejected without waking the container',
    async () => {
      try {
        await startPreviewServer(workerUrl, headers);
        const previewUrl = await exposeLifecyclePort(workerUrl, portHeaders);

        await stopContainer(workerUrl, portHeaders);
        const badTokenUrl = replacePreviewToken(previewUrl, 'badtoken');

        const response = await fetch(previewURL(badTokenUrl, '/hello'));
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
          code: 'INVALID_TOKEN'
        });
        expect(await getContainerStatus(workerUrl, portHeaders)).not.toBe(
          'healthy'
        );
      } finally {
        await stopContainer(workerUrl, portHeaders).catch(() => undefined);
      }
    },
    180000
  );

  test.skipIf(skipPortExposureTests)(
    'revoked preview URL after container stop is rejected without waking the container',
    async () => {
      try {
        await startPreviewServer(workerUrl, headers);
        const previewUrl = await exposeLifecyclePort(workerUrl, portHeaders);

        const deleteResponse = await fetch(
          `${workerUrl}/api/exposed-ports/${PREVIEW_LIFECYCLE_PORT}`,
          {
            method: 'DELETE',
            headers: portHeaders
          }
        );
        expect(deleteResponse.status).toBe(200);

        await stopContainer(workerUrl, portHeaders);

        const response = await fetch(previewURL(previewUrl, '/hello'));
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
          code: 'INVALID_TOKEN'
        });
        expect(await getContainerStatus(workerUrl, portHeaders)).not.toBe(
          'healthy'
        );
      } finally {
        await stopContainer(workerUrl, portHeaders).catch(() => undefined);
      }
    },
    180000
  );

  test.skipIf(skipPortExposureTests)(
    'same preview URL stays stale until exposePort is called in the new runtime',
    async () => {
      try {
        await startPreviewServer(workerUrl, headers);
        const previewUrl = await exposeLifecyclePort(workerUrl, portHeaders);

        const initialResponse = await fetch(previewURL(previewUrl, '/hello'));
        expect(initialResponse.status).toBe(200);
        expect(await initialResponse.text()).toBe('hello from lifecycle port');

        await stopContainer(workerUrl, portHeaders);
        await startPreviewServer(workerUrl, headers);

        const staleResponse = await fetch(previewURL(previewUrl, '/hello'));
        expect(staleResponse.status).toBe(410);
        expect(await staleResponse.json()).toMatchObject({
          code: 'STALE_PREVIEW_URL'
        });

        const reactivatedUrl = await exposeLifecyclePort(
          workerUrl,
          portHeaders
        );
        expect(reactivatedUrl).toBe(previewUrl);

        const reactivatedResponse = await fetch(
          previewURL(previewUrl, '/hello')
        );
        expect(reactivatedResponse.status).toBe(200);
        expect(await reactivatedResponse.text()).toBe(
          'hello from lifecycle port'
        );
      } finally {
        await stopContainer(workerUrl, portHeaders).catch(() => undefined);
      }
    },
    180000
  );

  test.skipIf(skipPortExposureTests)(
    'old preview URL stays stale after unrelated SDK work starts a new runtime',
    async () => {
      try {
        await startPreviewServer(workerUrl, headers);
        const previewUrl = await exposeLifecyclePort(workerUrl, portHeaders);

        const initialResponse = await fetch(previewURL(previewUrl, '/hello'));
        expect(initialResponse.status).toBe(200);

        await stopContainer(workerUrl, portHeaders);
        await writeUnrelatedRuntimeFile(workerUrl, headers);
        expect(await getContainerStatus(workerUrl, portHeaders)).toBe(
          'healthy'
        );

        const staleResponse = await fetch(previewURL(previewUrl, '/hello'));
        expect(staleResponse.status).toBe(410);
        expect(await staleResponse.json()).toMatchObject({
          code: 'STALE_PREVIEW_URL'
        });
        expect(await getContainerStatus(workerUrl, portHeaders)).toBe(
          'healthy'
        );
      } finally {
        await stopContainer(workerUrl, portHeaders).catch(() => undefined);
      }
    },
    180000
  );

  test.skipIf(skipPortExposureTests)(
    'old preview URL is rejected after sandbox destroy',
    async () => {
      try {
        await startPreviewServer(workerUrl, headers);
        const previewUrl = await exposeLifecyclePort(workerUrl, portHeaders);

        const cleanupResponse = await fetch(`${workerUrl}/cleanup`, {
          method: 'POST',
          headers: portHeaders
        });
        expect(cleanupResponse.status).toBe(200);
        sandbox = null;

        const response = await fetch(previewURL(previewUrl, '/hello'));
        expect(response.status).toBe(404);
        const body = (await response.json()) as { code?: string };
        expect(body.code).toBe('INVALID_TOKEN');
      } finally {
        if (sandbox !== null) {
          await stopContainer(workerUrl, portHeaders).catch(() => undefined);
        }
      }
    },
    180000
  );
});
