import { expect, test } from 'bun:test';

test('runs Bun beneath the explicit tini process reaper', async () => {
  expect(process.pid).not.toBe(1);
  expect(process.ppid).toBe(1);
  expect((await Bun.file('/proc/1/comm').text()).trim()).toBe('tini');
});
