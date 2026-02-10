import { expect, test } from '@playwright/test';

test.describe('Terminal Addon', () => {
  const sandboxId = process.env.TEST_SANDBOX_ID || 'browser-test-sandbox';

  test.beforeEach(async ({ page }) => {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await page.goto(
      `/terminal-test?sandboxId=${sandboxId}&sessionId=${sessionId}`
    );
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

  test.describe('Session Isolation', () => {
    test('different sessions have independent terminals', async ({
      browser
    }) => {
      const contextA = await browser.newContext();
      const contextB = await browser.newContext();

      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();

      const sessionA = `iso-a-${Date.now()}`;
      const sessionB = `iso-b-${Date.now()}`;
      const marker = `marker-${Date.now()}`;

      await pageA.goto(
        `/terminal-test?sandboxId=${sandboxId}&sessionId=${sessionA}`
      );
      await pageB.goto(
        `/terminal-test?sandboxId=${sandboxId}&sessionId=${sessionB}`
      );

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

      await contextA.close();
      await contextB.close();
    });
  });
});
