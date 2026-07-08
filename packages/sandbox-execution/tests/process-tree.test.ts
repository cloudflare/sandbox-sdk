import { expect, spyOn, test } from 'bun:test';
import {
  getDescendantPids,
  signalProcessTree
} from '../src/process/process-tree';

async function waitForDescendant(pid: number): Promise<number[]> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const descendants = await getDescendantPids(pid);
    if (descendants.length > 0) return descendants;
    await Bun.sleep(10);
  }
  return [];
}

async function expectPidGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(pid, 0);
      await Bun.sleep(10);
    } catch {
      return;
    }
  }
  expect(() => process.kill(pid, 0)).toThrow();
}

test('rejects unsafe process IDs', async () => {
  for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(signalProcessTree(pid, 15)).rejects.toThrow(
      'PID must be a positive safe integer'
    );
  }
});

test('rejects invalid signal numbers before signaling', async () => {
  for (const signal of [0, 65, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(signalProcessTree(process.pid, signal)).rejects.toThrow(
      'signal must be an integer from 1 through 64'
    );
  }
});

test('propagates operational signaling errors', async () => {
  const kill = spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('operation not permitted'), {
      code: 'EPERM'
    });
  });
  try {
    await expect(signalProcessTree(process.pid, 15)).rejects.toThrow(
      'operation not permitted'
    );
  } finally {
    kill.mockRestore();
  }
});

test('enumerates and signals a detached process tree', async () => {
  const child = Bun.spawn(['bash', '-c', 'sleep 30 & wait'], {
    detached: true,
    stdout: 'ignore',
    stderr: 'ignore'
  });
  const descendants = await waitForDescendant(child.pid);
  expect(descendants.length).toBeGreaterThan(0);
  await signalProcessTree(child.pid, 9);
  await child.exited;
  await Promise.all(descendants.map(expectPidGone));
});

test('falls back for a target that is not a process-group leader', async () => {
  const leader = Bun.spawn(['bash', '-c', 'bash -c "sleep 30 & wait" & wait'], {
    detached: true,
    stdout: 'ignore',
    stderr: 'ignore'
  });
  const children = await waitForDescendant(leader.pid);
  const target = children.find((pid) => pid !== leader.pid);
  expect(target).toBeDefined();
  if (target === undefined) throw new Error('Expected descendant target');
  const descendants = await waitForDescendant(target);
  expect(descendants.length).toBeGreaterThan(0);
  await signalProcessTree(target, 9);
  await Promise.all([target, ...descendants].map(expectPidGone));
  try {
    process.kill(-leader.pid, 9);
  } catch {
    // The fallback may already have allowed the group leader to exit.
  }
  await leader.exited;
});
