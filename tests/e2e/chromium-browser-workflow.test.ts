import { randomUUID } from 'node:crypto';
import type { ExecResult, ReadFileResult } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';

describe('Chromium Browser Workflow', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    sandbox = await createTestSandbox({ type: 'chromium' });
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers(createUniqueSession());
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  test('has Chrome binaries available', async () => {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command:
          'google-chrome-stable --version && chromium --version && chromium-browser --version'
      })
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as ExecResult;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Chrome|Chromium/);
    expect(result.stdout.split('\n').filter(Boolean)).toHaveLength(3);
  }, 120000);

  test('renders local HTML and captures a PNG screenshot', async () => {
    const id = randomUUID().slice(0, 8);
    const htmlPath = `/workspace/chromium-${id}.html`;
    const screenshotPath = `/workspace/chromium-${id}.png`;
    const pageTitle = `Chromium E2E ${id}`;
    const pageBody = `Chromium smoke test ${id}`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${pageTitle}</title><style>body{margin:0;font-family:sans-serif;background:#f4f4f5;color:#111827}main{display:flex;align-items:center;justify-content:center;height:100vh;font-size:32px}</style></head><body><main>${pageBody}</main></body></html>`;

    const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: htmlPath, content: html })
    });

    expect(writeResponse.status).toBe(200);

    const command = [
      'set -euo pipefail',
      `rm -f '${screenshotPath}'`,
      'chromium \\',
      '  --headless=new \\',
      '  --disable-gpu \\',
      '  --disable-dev-shm-usage \\',
      '  --hide-scrollbars \\',
      '  --no-sandbox \\',
      '  --window-size=1280,720 \\',
      '  --virtual-time-budget=1000 \\',
      `  --screenshot='${screenshotPath}' \\`,
      `  --dump-dom 'file://${htmlPath}'`
    ].join('\n');

    const execResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command })
    });

    expect(execResponse.status).toBe(200);
    const execResult = (await execResponse.json()) as ExecResult;
    expect(execResult.exitCode).toBe(0);
    expect(execResult.stdout).toContain(pageTitle);
    expect(execResult.stdout).toContain(pageBody);

    const readResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: screenshotPath })
    });

    expect(readResponse.status).toBe(200);
    const screenshot = (await readResponse.json()) as ReadFileResult;
    expect(screenshot.success).toBe(true);
    expect(screenshot.isBinary).toBe(true);
    expect(screenshot.encoding).toBe('base64');
    expect(screenshot.mimeType).toMatch(/image\/png/);
    expect(screenshot.content.length).toBeGreaterThan(100);

    const pngHeader = Buffer.from(screenshot.content, 'base64').subarray(0, 4);
    expect(Array.from(pngHeader)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 120000);
});
