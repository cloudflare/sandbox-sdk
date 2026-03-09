import { afterEach, describe, expect, it } from 'bun:test';
import { createNoOpLogger } from '@repo/shared';
import { Pty } from '../src/pty';

describe('Pty', () => {
  let pty: Pty;
  const logger = createNoOpLogger();

  afterEach(async () => {
    if (pty) {
      await pty.destroy();
    }
  });

  it('should receive data from terminal after spawn', async () => {
    pty = new Pty({ cwd: '/tmp', logger });
    await pty.initialize({ cols: 80, rows: 24 });

    const receivedData: Uint8Array[] = [];
    const disposable = pty.onData((data) => receivedData.push(data));

    await Bun.sleep(200);

    expect(receivedData.length).toBeGreaterThan(0);
    disposable.dispose();
  });

  it('should throw when writing to closed PTY', async () => {
    pty = new Pty({ cwd: '/tmp', logger });
    await pty.initialize({ cols: 80, rows: 24 });
    await pty.destroy();

    expect(() => pty.write('test')).toThrow('PTY is closed');
  });

  it('should buffer output for reconnection replay', async () => {
    pty = new Pty({ cwd: '/tmp', logger, bufferSize: 1024 });
    await pty.initialize({ cols: 80, rows: 24 });

    await Bun.sleep(200);

    const buffered = pty.getBufferedOutput();
    expect(buffered.length).toBeGreaterThan(0);
  });

  it('should broadcast to multiple data listeners', async () => {
    pty = new Pty({ cwd: '/tmp', logger });
    await pty.initialize({ cols: 80, rows: 24 });

    let count1 = 0;
    let count2 = 0;

    const d1 = pty.onData(() => count1++);
    const d2 = pty.onData(() => count2++);

    await Bun.sleep(200);

    expect(count1).toBeGreaterThan(0);
    expect(count1).toBe(count2);

    d1.dispose();
    d2.dispose();
  });
});
