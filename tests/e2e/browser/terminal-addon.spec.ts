import { createHash } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

type BrowserDiagnostic = {
  kind: 'console' | 'request-failed' | 'response';
  message: string;
  url?: string;
};

const diagnosticsByAttempt = new Map<string, BrowserDiagnostic[]>();

function attemptID(testInfo: TestInfo): string {
  return `${testInfo.testId}:${testInfo.retry}`;
}

function browserSandboxID(testInfo: TestInfo): string {
  const runID = process.env.TEST_SANDBOX_ID ?? 'browser-test-sandbox';
  const testID = createHash('sha256')
    .update(testInfo.testId)
    .digest('hex')
    .slice(0, 12);
  return `${runID}-${testID}-retry-${testInfo.retry}`;
}

function terminalTestURL(testInfo: TestInfo): string {
  const params = new URLSearchParams({
    sandboxId: browserSandboxID(testInfo),
    sandboxType: 'browser'
  });
  return `/terminal-test?${params.toString()}`;
}

function capturePageDiagnostics(
  page: Page,
  diagnostics: BrowserDiagnostic[]
): void {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      diagnostics.push({ kind: 'console', message: message.text() });
    }
  });
  page.on('requestfailed', (request) => {
    diagnostics.push({
      kind: 'request-failed',
      message: request.failure()?.errorText ?? 'Request failed',
      url: request.url()
    });
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/terminal/create') && !response.ok()) {
      diagnostics.push({
        kind: 'response',
        message: `HTTP ${response.status()}`,
        url: response.url()
      });
    }
  });
}

test.describe('Terminal Addon', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const diagnostics: BrowserDiagnostic[] = [];
    diagnosticsByAttempt.set(attemptID(testInfo), diagnostics);

    capturePageDiagnostics(page, diagnostics);

    await page.goto(terminalTestURL(testInfo));
  });

  test.afterEach(async ({ request }, testInfo) => {
    const sandboxID = browserSandboxID(testInfo);
    const diagnostics = diagnosticsByAttempt.get(attemptID(testInfo)) ?? [];
    let cleanupError: string | undefined;

    try {
      const params = new URLSearchParams({
        sandboxId: sandboxID,
        sandboxType: 'browser'
      });
      const response = await request.post(`/cleanup?${params.toString()}`, {
        timeout: 10_000
      });
      if (!response.ok()) {
        cleanupError = `HTTP ${response.status()}`;
      }
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }

    if (cleanupError) {
      diagnostics.push({
        kind: 'request-failed',
        message: `Sandbox cleanup failed: ${cleanupError}`
      });
    }

    if (testInfo.status !== testInfo.expectedStatus || cleanupError) {
      await testInfo.attach('browser-network-diagnostics', {
        body: Buffer.from(
          JSON.stringify({ sandboxID, diagnostics }, undefined, 2)
        ),
        contentType: 'application/json'
      });
    }

    diagnosticsByAttempt.delete(attemptID(testInfo));

    if (cleanupError && testInfo.status === testInfo.expectedStatus) {
      throw new Error(
        `Browser sandbox cleanup failed for ${sandboxID}: ${cleanupError}`
      );
    }
  });

  test.describe('Connection', () => {
    test('connects and reaches connected state', async ({ page }) => {
      await expect(page.getByTestId('connection-status')).toHaveText(
        'connected',
        {
          timeout: 30000
        }
      );
    });

    test('displays shell prompt after connecting', async ({ page }) => {
      await expect(page.getByTestId('connection-status')).toHaveText(
        'connected',
        {
          timeout: 30000
        }
      );

      await expect(page.locator('.xterm-rows')).toContainText(/[$#]/, {
        timeout: 10000
      });
    });
  });

  test.describe('Terminal I/O', () => {
    test('displays command output', async ({ page }) => {
      await expect(page.getByTestId('connection-status')).toHaveText(
        'connected',
        {
          timeout: 30000
        }
      );

      const marker = `test-output-${Date.now()}`;

      await page.locator('.xterm').click();
      await page.keyboard.type(`echo "${marker}"\n`);

      await expect(page.locator('.xterm-rows')).toContainText(marker, {
        timeout: 10000
      });
    });

    test('handles multiple commands', async ({ page }) => {
      await expect(page.getByTestId('connection-status')).toHaveText(
        'connected',
        {
          timeout: 30000
        }
      );

      await page.locator('.xterm').click();

      await page.keyboard.type('echo "first"\n');
      await expect(page.locator('.xterm-rows')).toContainText('first', {
        timeout: 5000
      });

      await page.keyboard.type('echo "second"\n');
      await expect(page.locator('.xterm-rows')).toContainText('second', {
        timeout: 5000
      });
    });
  });

  test.describe('Resize', () => {
    test('sends resize when terminal dimensions change', async ({ page }) => {
      await expect(page.getByTestId('connection-status')).toHaveText(
        'connected',
        {
          timeout: 30000
        }
      );

      await page.setViewportSize({ width: 1200, height: 800 });
      await page.waitForTimeout(500);

      await page.locator('.xterm').click();
      await page.keyboard.type('stty size\n');

      await page.waitForFunction(
        () => {
          const content =
            document.querySelector('.xterm-rows')?.textContent ?? '';
          return /\d+\s+\d+/.test(content);
        },
        { timeout: 5000 }
      );
    });
  });

  test.describe('Reconnection', () => {
    test('reconnects after WebSocket close', async ({ page }) => {
      await expect(page.getByTestId('connection-status')).toHaveText(
        'connected',
        {
          timeout: 30000
        }
      );

      await page.evaluate(() => {
        (window as unknown as { testCloseWs?: () => void }).testCloseWs?.();
      });

      await expect(page.getByTestId('connection-status')).toHaveText(
        'disconnected',
        {
          timeout: 10000
        }
      );

      await expect(page.getByTestId('connection-status')).toHaveText(
        'connected',
        {
          timeout: 30000
        }
      );
    });

    test('preserves terminal content after reconnect', async ({ page }) => {
      await expect(page.getByTestId('connection-status')).toHaveText(
        'connected',
        {
          timeout: 30000
        }
      );

      const marker = `persist-${Date.now()}`;
      await page.locator('.xterm').click();
      await page.keyboard.type(`echo "${marker}"\n`);
      await expect(page.locator('.xterm-rows')).toContainText(marker, {
        timeout: 5000
      });

      await page.evaluate(() => {
        (window as unknown as { testCloseWs?: () => void }).testCloseWs?.();
      });

      await expect(page.getByTestId('connection-status')).toHaveText(
        'disconnected',
        {
          timeout: 10000
        }
      );

      await expect(page.getByTestId('connection-status')).toHaveText(
        'connected',
        {
          timeout: 30000
        }
      );

      await expect(page.locator('.xterm-rows')).toContainText(marker, {
        timeout: 10000
      });
    });
  });

  test.describe('Terminal Isolation', () => {
    test('different terminal sessions are independent', async ({
      browser,
      page: pageA
    }, testInfo) => {
      const contextB = await browser.newContext();

      const pageB = await contextB.newPage();
      const diagnostics = diagnosticsByAttempt.get(attemptID(testInfo));
      if (diagnostics) capturePageDiagnostics(pageB, diagnostics);

      const marker = `marker-${Date.now()}`;

      await pageB.goto(terminalTestURL(testInfo));

      await expect(pageA.getByTestId('connection-status')).toHaveText(
        'connected',
        {
          timeout: 30000
        }
      );
      await expect(pageB.getByTestId('connection-status')).toHaveText(
        'connected',
        {
          timeout: 30000
        }
      );

      await pageA.locator('.xterm').click();
      await pageA.keyboard.type(`export TEST_VAR="${marker}"\n`);
      await pageA.keyboard.type('echo "set:$TEST_VAR"\n');
      await expect(pageA.locator('.xterm-rows')).toContainText(
        `set:${marker}`,
        {
          timeout: 5000
        }
      );

      await pageB.locator('.xterm').click();
      await pageB.keyboard.type('echo "check:$TEST_VAR"\n');

      await pageB.waitForFunction(
        () =>
          document
            .querySelector('.xterm-rows')
            ?.textContent?.includes('check:'),
        { timeout: 5000 }
      );

      const contentB = await pageB.locator('.xterm-rows').textContent();
      expect(contentB).toContain('check:');
      expect(contentB).not.toContain(marker);

      await contextB.close();
    });
  });
});
