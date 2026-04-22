import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';

type DesktopStartResult = { success: boolean; resolution?: [number, number] };
type DesktopStatusResult = {
  status: 'active' | 'inactive';
  processes?: unknown;
  resolution?: [number, number];
};
type DesktopScreenshotResult = {
  success: boolean;
  data: string;
  imageFormat: string;
  width: number;
  height: number;
};
type CursorPositionResult = { success: boolean; x: number; y: number };
type StreamUrlResult = { url: string };

const skipPortExposureTests =
  process.env.TEST_WORKER_URL?.endsWith('.workers.dev') ?? false;

describe('Desktop Environment', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let sandbox: TestSandbox | null = null;

  beforeAll(async () => {
    sandbox = await createTestSandbox({ type: 'desktop' });
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers(createUniqueSession());
  }, 120000);

  afterAll(async () => {
    try {
      await fetch(`${workerUrl}/api/desktop/stop`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(2000)
      });
      await cleanupTestSandbox(sandbox);
    } catch {
      console.warn('Failed to cleanup sandbox in good time.');
    }
  }, 30000);

  test('should start desktop and report active status', async () => {
    const startResponse = await fetch(`${workerUrl}/api/desktop/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000)
    });

    expect(startResponse.status).toBe(200);
    const startData = (await startResponse.json()) as DesktopStartResult;
    expect(startData.success).toBe(true);
    expect(startData.resolution).toBeDefined();
    expect(startData.resolution).toHaveLength(2);

    const statusResponse = await fetch(`${workerUrl}/api/desktop/status`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000)
    });

    expect(statusResponse.status).toBe(200);
    const statusData = (await statusResponse.json()) as DesktopStatusResult;
    expect(statusData.status).toBe('active');
    expect(statusData.processes).toBeDefined();
    expect(statusData.resolution).toBeDefined();
  }, 60000);

  test('should capture a valid PNG screenshot', async () => {
    const response = await fetch(`${workerUrl}/api/desktop/screenshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000)
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as DesktopScreenshotResult;
    expect(data.success).toBe(true);
    expect(data.data).toBeDefined();
    expect(data.imageFormat).toBe('png');
    expect(data.width).toBeGreaterThan(0);
    expect(data.height).toBeGreaterThan(0);

    const binaryString = atob(data.data);
    const pngMagic = [0x89, 0x50, 0x4e, 0x47];
    for (let i = 0; i < pngMagic.length; i++) {
      expect(binaryString.charCodeAt(i)).toBe(pngMagic[i]);
    }
  }, 30000);

  test('should click at coordinates without error', async () => {
    const response = await fetch(`${workerUrl}/api/desktop/click`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ x: 500, y: 300 }),
      signal: AbortSignal.timeout(10000)
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ success: true })
    );
  }, 15000);

  test('should type text', async () => {
    const response = await fetch(`${workerUrl}/api/desktop/type`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'hello desktop' }),
      signal: AbortSignal.timeout(10000)
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ success: true })
    );
  }, 15000);

  test('should press key combination', async () => {
    const response = await fetch(`${workerUrl}/api/desktop/press`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'ctrl+a' }),
      signal: AbortSignal.timeout(10000)
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ success: true })
    );
  }, 15000);

  test('should return screen size matching configured resolution', async () => {
    const response = await fetch(`${workerUrl}/api/desktop/screen/size`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000)
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ success: true, width: 1024, height: 768 })
    );
  }, 15000);

  test('should return valid cursor coordinates', async () => {
    const response = await fetch(`${workerUrl}/api/desktop/cursor/position`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000)
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as CursorPositionResult;
    expect(data.success).toBe(true);
    expect(typeof data.x).toBe('number');
    expect(typeof data.y).toBe('number');
    expect(data.x).toBeGreaterThanOrEqual(0);
    expect(data.y).toBeGreaterThanOrEqual(0);
  }, 15000);

  test.skipIf(skipPortExposureTests)(
    'should generate desktop stream URL',
    async () => {
      const response = await fetch(`${workerUrl}/api/desktop/stream-url`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10000)
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as StreamUrlResult;
      expect(data.url).toBeDefined();
      expect(typeof data.url).toBe('string');
      expect(data.url).toContain('6080');
    },
    15000
  );

  test('should move mouse to specified coordinates', async () => {
    const response = await fetch(`${workerUrl}/api/desktop/mouse/move`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ x: 200, y: 150 }),
      signal: AbortSignal.timeout(10000)
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ success: true })
    );

    const posResponse = await fetch(
      `${workerUrl}/api/desktop/cursor/position`,
      {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10000)
      }
    );

    const posData = (await posResponse.json()) as CursorPositionResult;
    expect(posData.x).toBeGreaterThanOrEqual(0);
    expect(posData.y).toBeGreaterThanOrEqual(0);
  }, 15000);

  test('should handle idempotent start', async () => {
    const start = await fetch(`${workerUrl}/api/desktop/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000)
    });
    expect(start.status).toBe(200);

    const statusResponse = await fetch(`${workerUrl}/api/desktop/status`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000)
    });

    await expect(statusResponse.json()).resolves.toEqual(
      expect.objectContaining({ status: 'active' })
    );
  }, 15000);

  test('should stop desktop and report inactive status', async () => {
    const stopResponse = await fetch(`${workerUrl}/api/desktop/stop`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(10000)
    });

    expect(stopResponse.status).toBe(200);
    await expect(stopResponse.json()).resolves.toEqual(
      expect.objectContaining({ success: true })
    );

    const statusResponse = await fetch(`${workerUrl}/api/desktop/status`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000)
    });

    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toEqual(
      expect.objectContaining({ status: 'inactive' })
    );

    // Assert that attempting to make a request to a stopped instance fails.
    const response = await fetch(`${workerUrl}/api/desktop/screenshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000)
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error: expect.anything() })
    );
  }, 15000);
});
