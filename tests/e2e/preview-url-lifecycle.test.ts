import type { PortExposeResult } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import {
  getContainerStatus,
  stopContainerAndWait as stopContainer,
  waitForContainerHealthy
} from './helpers/container-lifecycle';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';

const skipPortExposureTests =
  process.env.TEST_WORKER_URL?.endsWith('.workers.dev') ?? false;

const PREVIEW_PORTS = {
  validHttp: 9852,
  webSocket: 9853,
  staleAfterStop: 9854,
  portAPIs: 9855,
  rotatedToken: 9856,
  revoked: 9857,
  reusedURL: 9858,
  unrelatedRuntime: 9859,
  destroy: 9860
} as const;

const REUSED_URL_TOKEN = 'lifecycleok';
const ROTATED_TOKEN_A = 'lifecycle_a';
const ROTATED_TOKEN_B = 'lifecycle_b';

type ExposedPortsResponse = Array<{
  port: number;
  url: string;
  status: string;
}>;

async function responseText(response: Response): Promise<string> {
  return await response.text().catch(() => '<unreadable>');
}

async function assertOK(response: Response, action: string): Promise<void> {
  if (!response.ok) {
    throw new Error(
      `${action} failed: ${response.status} ${await responseText(response)}`
    );
  }
}

async function writePreviewServer(
  workerUrl: string,
  headers: Record<string, string>,
  port: number
): Promise<void> {
  const serverCode = `
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: ${port},
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) {
        return;
      }
      return new Response("Expected WebSocket", { status: 400 });
    }
    if (url.pathname === "/hello") {
      return new Response("hello from lifecycle port ${port}", { status: 200 });
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
      path: `/workspace/preview-lifecycle-server-${port}.ts`,
      content: serverCode
    })
  });
  await assertOK(response, `Writing preview server for port ${port}`);
}

async function startPreviewServer(
  workerUrl: string,
  headers: Record<string, string>,
  port: number
): Promise<void> {
  await writePreviewServer(workerUrl, headers, port);

  const startResponse = await fetch(`${workerUrl}/api/exec-and-wait-for-port`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      command: [
        '/bin/bash',
        '-lc',
        `bun run /workspace/preview-lifecycle-server-${port}.ts`
      ],
      port
    })
  });
  await assertOK(
    startResponse,
    `Starting preview server and waiting for port ${port}`
  );
}

async function exposePreviewPort(
  workerUrl: string,
  headers: Record<string, string>,
  port: number,
  token?: string
): Promise<string> {
  const body: { port: number; name: string; token?: string } = {
    port,
    name: `preview-lifecycle-${port}`
  };
  if (token !== undefined) {
    body.token = token;
  }

  const exposeResponse = await fetch(`${workerUrl}/api/port/expose`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  await assertOK(exposeResponse, `Exposing preview port ${port}`);
  const preview = (await exposeResponse.json()) as PortExposeResult;
  return preview.url;
}

async function unexposePreviewPort(
  workerUrl: string,
  headers: Record<string, string>,
  port: number
): Promise<void> {
  const response = await fetch(`${workerUrl}/api/exposed-ports/${port}`, {
    method: 'DELETE',
    headers
  });
  await assertOK(response, `Unexposing preview port ${port}`);
}

async function getExposedPorts(
  workerUrl: string,
  headers: Record<string, string>
): Promise<ExposedPortsResponse> {
  const response = await fetch(`${workerUrl}/api/exposed-ports`, { headers });
  await assertOK(response, 'Reading exposed preview ports');
  return (await response.json()) as ExposedPortsResponse;
}

async function isPortExposed(
  workerUrl: string,
  headers: Record<string, string>,
  port: number
): Promise<boolean> {
  const response = await fetch(`${workerUrl}/api/exposed-ports/${port}`, {
    headers
  });
  await assertOK(response, `Reading exposed state for preview port ${port}`);
  const body = (await response.json()) as { exposed: boolean };
  return body.exposed;
}

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
  await assertOK(response, 'Writing unrelated runtime file');
}

function createPortHeaders(
  headers: Record<string, string>
): Record<string, string> {
  return { ...headers };
}

describe('Preview URL lifecycle', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let portHeaders: Record<string, string>;
  let sandbox: TestSandbox | null = null;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers();
    portHeaders = createPortHeaders(headers);
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
  }, 120000);

  test.skipIf(skipPortExposureTests)(
    'valid preview URL reaches a service in the current runtime',
    async () => {
      const port = PREVIEW_PORTS.validHttp;
      try {
        await startPreviewServer(workerUrl, headers, port);
        const previewUrl = await exposePreviewPort(
          workerUrl,
          portHeaders,
          port
        );

        const response = await fetch(previewURL(previewUrl, '/hello'));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(`hello from lifecycle port ${port}`);
      } finally {
        await unexposePreviewPort(workerUrl, portHeaders, port).catch(
          () => undefined
        );
        await stopContainer(workerUrl, portHeaders).catch(() => undefined);
      }
    },
    180000
  );

  test.skipIf(skipPortExposureTests)(
    'WebSocket preview URL connects only while activated in the current runtime',
    async () => {
      const port = PREVIEW_PORTS.webSocket;
      let ws: WebSocket | null = null;
      try {
        await startPreviewServer(workerUrl, headers, port);
        const previewUrl = await exposePreviewPort(
          workerUrl,
          portHeaders,
          port
        );

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
        await unexposePreviewPort(workerUrl, portHeaders, port).catch(
          () => undefined
        );
        await stopContainer(workerUrl, portHeaders).catch(() => undefined);
      }
    },
    180000
  );

  test.skipIf(skipPortExposureTests)(
    'authorized preview URL after container stop is stale and does not wake the container',
    async () => {
      const port = PREVIEW_PORTS.staleAfterStop;
      try {
        await startPreviewServer(workerUrl, headers, port);
        const previewUrl = await exposePreviewPort(
          workerUrl,
          portHeaders,
          port
        );

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
        await unexposePreviewPort(workerUrl, portHeaders, port).catch(
          () => undefined
        );
        await stopContainer(workerUrl, portHeaders).catch(() => undefined);
      }
    },
    180000
  );

  test.skipIf(skipPortExposureTests)(
    'preview port APIs report only current-runtime activated ports without waking',
    async () => {
      const port = PREVIEW_PORTS.portAPIs;
      try {
        await startPreviewServer(workerUrl, headers, port);
        const previewUrl = await exposePreviewPort(
          workerUrl,
          portHeaders,
          port
        );

        await expect(getExposedPorts(workerUrl, portHeaders)).resolves.toEqual([
          {
            port,
            url: previewUrl,
            status: 'active'
          }
        ]);
        await expect(isPortExposed(workerUrl, portHeaders, port)).resolves.toBe(
          true
        );

        await stopContainer(workerUrl, portHeaders);
        await expect(getExposedPorts(workerUrl, portHeaders)).resolves.toEqual(
          []
        );
        await expect(isPortExposed(workerUrl, portHeaders, port)).resolves.toBe(
          false
        );
        expect(await getContainerStatus(workerUrl, portHeaders)).not.toBe(
          'healthy'
        );

        await startPreviewServer(workerUrl, headers, port);
        await expect(getExposedPorts(workerUrl, portHeaders)).resolves.toEqual(
          []
        );
        await expect(isPortExposed(workerUrl, portHeaders, port)).resolves.toBe(
          false
        );
      } finally {
        await unexposePreviewPort(workerUrl, portHeaders, port).catch(
          () => undefined
        );
        await stopContainer(workerUrl, portHeaders).catch(() => undefined);
      }
    },
    180000
  );

  test.skipIf(skipPortExposureTests)(
    'old preview URL with a rotated token is rejected without waking the container',
    async () => {
      const port = PREVIEW_PORTS.rotatedToken;
      try {
        await startPreviewServer(workerUrl, headers, port);
        const oldPreviewUrl = await exposePreviewPort(
          workerUrl,
          portHeaders,
          port,
          ROTATED_TOKEN_A
        );
        const newPreviewUrl = await exposePreviewPort(
          workerUrl,
          portHeaders,
          port,
          ROTATED_TOKEN_B
        );
        expect(newPreviewUrl).not.toBe(oldPreviewUrl);

        await stopContainer(workerUrl, portHeaders);

        const response = await fetch(previewURL(oldPreviewUrl, '/hello'));
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
          code: 'INVALID_TOKEN'
        });
        expect(await getContainerStatus(workerUrl, portHeaders)).not.toBe(
          'healthy'
        );
      } finally {
        await unexposePreviewPort(workerUrl, portHeaders, port).catch(
          () => undefined
        );
        await stopContainer(workerUrl, portHeaders).catch(() => undefined);
      }
    },
    180000
  );

  test.skipIf(skipPortExposureTests)(
    'revoked preview URL after container stop is rejected without waking the container',
    async () => {
      const port = PREVIEW_PORTS.revoked;
      try {
        await startPreviewServer(workerUrl, headers, port);
        const previewUrl = await exposePreviewPort(
          workerUrl,
          portHeaders,
          port
        );

        await unexposePreviewPort(workerUrl, portHeaders, port);
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
        await unexposePreviewPort(workerUrl, portHeaders, port).catch(
          () => undefined
        );
        await stopContainer(workerUrl, portHeaders).catch(() => undefined);
      }
    },
    180000
  );

  test.skipIf(skipPortExposureTests)(
    'same preview URL stays stale until exposePort is called in the new runtime',
    async () => {
      const port = PREVIEW_PORTS.reusedURL;
      try {
        await startPreviewServer(workerUrl, headers, port);
        const previewUrl = await exposePreviewPort(
          workerUrl,
          portHeaders,
          port,
          REUSED_URL_TOKEN
        );

        const initialResponse = await fetch(previewURL(previewUrl, '/hello'));
        expect(initialResponse.status).toBe(200);
        expect(await initialResponse.text()).toBe(
          `hello from lifecycle port ${port}`
        );

        await stopContainer(workerUrl, portHeaders);
        await startPreviewServer(workerUrl, headers, port);

        const staleResponse = await fetch(previewURL(previewUrl, '/hello'));
        expect(staleResponse.status).toBe(410);
        expect(await staleResponse.json()).toMatchObject({
          code: 'STALE_PREVIEW_URL'
        });

        const reactivatedUrl = await exposePreviewPort(
          workerUrl,
          portHeaders,
          port
        );
        expect(reactivatedUrl).toBe(previewUrl);

        const reactivatedResponse = await fetch(
          previewURL(previewUrl, '/hello')
        );
        expect(reactivatedResponse.status).toBe(200);
        expect(await reactivatedResponse.text()).toBe(
          `hello from lifecycle port ${port}`
        );
      } finally {
        await unexposePreviewPort(workerUrl, portHeaders, port).catch(
          () => undefined
        );
        await stopContainer(workerUrl, portHeaders).catch(() => undefined);
      }
    },
    180000
  );

  test.skipIf(skipPortExposureTests)(
    'old preview URL stays stale after unrelated SDK work starts a new runtime',
    async () => {
      const port = PREVIEW_PORTS.unrelatedRuntime;
      try {
        await startPreviewServer(workerUrl, headers, port);
        const previewUrl = await exposePreviewPort(
          workerUrl,
          portHeaders,
          port
        );

        const initialResponse = await fetch(previewURL(previewUrl, '/hello'));
        expect(initialResponse.status).toBe(200);

        await stopContainer(workerUrl, portHeaders);
        await writeUnrelatedRuntimeFile(workerUrl, headers);
        await waitForContainerHealthy(workerUrl, portHeaders);

        const staleResponse = await fetch(previewURL(previewUrl, '/hello'));
        expect(staleResponse.status).toBe(410);
        expect(await staleResponse.json()).toMatchObject({
          code: 'STALE_PREVIEW_URL'
        });
        expect(await getContainerStatus(workerUrl, portHeaders)).toBe(
          'healthy'
        );
      } finally {
        await unexposePreviewPort(workerUrl, portHeaders, port).catch(
          () => undefined
        );
        await stopContainer(workerUrl, portHeaders).catch(() => undefined);
      }
    },
    180000
  );
});

describe('Preview URL lifecycle after sandbox destroy', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let portHeaders: Record<string, string>;
  let sandbox: TestSandbox | null = null;
  let destroyed = false;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers();
    portHeaders = createPortHeaders(headers);
  }, 120000);

  afterAll(async () => {
    if (!destroyed) {
      await cleanupTestSandbox(sandbox);
    }
  }, 120000);

  test.skipIf(skipPortExposureTests)(
    'old preview URL is rejected after sandbox destroy',
    async () => {
      const port = PREVIEW_PORTS.destroy;
      try {
        await startPreviewServer(workerUrl, headers, port);
        const previewUrl = await exposePreviewPort(
          workerUrl,
          portHeaders,
          port
        );

        const cleanupResponse = await fetch(`${workerUrl}/cleanup`, {
          method: 'POST',
          headers: portHeaders
        });
        await assertOK(cleanupResponse, 'Destroying preview lifecycle sandbox');
        destroyed = true;

        const response = await fetch(previewURL(previewUrl, '/hello'));
        expect(response.status).toBe(404);
        const body = (await response.json()) as { code?: string };
        expect(body.code).toBe('INVALID_TOKEN');
      } finally {
        if (!destroyed) {
          await unexposePreviewPort(workerUrl, portHeaders, port).catch(
            () => undefined
          );
          await stopContainer(workerUrl, portHeaders).catch(() => undefined);
        }
      }
    },
    180000
  );
});
