import { describe, expect, test, vi } from 'vitest';
import { ResourceActivityGate } from '../src/resource-activity-gate';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createGate() {
  const renew = vi.fn();
  const stop = vi.fn(async () => undefined);
  const gate = new ResourceActivityGate(renew, stop);
  return { gate, renew, stop };
}

describe('ResourceActivityGate', () => {
  test('active process renews and does not stop', async () => {
    const { gate, stop, renew } = createGate();
    await gate.runExpiry(
      {
        availability: async () => 'available' as const,
        processesHasActive: async () => true,
        terminalsHasActive: async () => false
      },
      false
    );
    expect(stop).not.toHaveBeenCalled();
    expect(renew).toHaveBeenCalled();
  });

  test('active terminal renews and does not stop', async () => {
    const { gate, stop } = createGate();
    await gate.runExpiry(
      {
        availability: async () => 'available' as const,
        processesHasActive: async () => false,
        terminalsHasActive: async () => true
      },
      false
    );
    expect(stop).not.toHaveBeenCalled();
  });

  test('confirmed absence commits stop', async () => {
    const { gate, stop } = createGate();
    await gate.runExpiry(
      {
        availability: async () => 'available' as const,
        processesHasActive: async () => false,
        terminalsHasActive: async () => false
      },
      false
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('transient query failure renews and never stops', async () => {
    const { gate, stop, renew } = createGate();
    await gate.runExpiry(
      {
        availability: async () => 'available' as const,
        processesHasActive: async () => {
          throw new Error('temporary');
        },
        terminalsHasActive: async () => false
      },
      false
    );
    expect(stop).not.toHaveBeenCalled();
    expect(renew).toHaveBeenCalled();
  });

  test('generation change during availability query prevents stop', async () => {
    const { gate, stop } = createGate();
    const availability = deferred<'available'>();
    const expiry = gate.runExpiry(
      {
        availability: () => availability.promise,
        processesHasActive: async () => false,
        terminalsHasActive: async () => false
      },
      false
    );
    gate.recordActivity();
    availability.resolve('available');
    await expiry;
    expect(stop).not.toHaveBeenCalled();
  });

  test('generation change during process query prevents stop', async () => {
    const { gate, stop } = createGate();
    const active = deferred<boolean>();
    const expiry = gate.runExpiry(
      {
        availability: async () => 'available' as const,
        processesHasActive: () => active.promise,
        terminalsHasActive: async () => false
      },
      false
    );
    gate.recordActivity();
    active.resolve(false);
    await expiry;
    expect(stop).not.toHaveBeenCalled();
  });

  test('generation change during terminal query prevents stop', async () => {
    const { gate, stop } = createGate();
    const active = deferred<boolean>();
    const expiry = gate.runExpiry(
      {
        availability: async () => 'available' as const,
        processesHasActive: async () => false,
        terminalsHasActive: () => active.promise
      },
      false
    );
    await Promise.resolve();
    gate.recordActivity();
    active.resolve(false);
    await expiry;
    expect(stop).not.toHaveBeenCalled();
  });

  test('in-flight operation prevents stop without leaked count', async () => {
    const { gate, stop } = createGate();
    const operation = gate.beginOperation();
    await gate.runExpiry(
      {
        availability: async () => 'available' as const,
        processesHasActive: async () => false,
        terminalsHasActive: async () => false
      },
      false
    );
    expect(stop).not.toHaveBeenCalled();
    operation.finish();
    await gate.runExpiry(
      {
        availability: async () => 'available' as const,
        processesHasActive: async () => false,
        terminalsHasActive: async () => false
      },
      false
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('expiry does not renew for an in-flight non-waking operation', async () => {
    const { gate, stop, renew } = createGate();
    const operation = gate.beginNonWakingOperation();
    const probe = {
      availability: vi.fn(async () => 'available' as const),
      processesHasActive: vi.fn(async () => false),
      terminalsHasActive: vi.fn(async () => false)
    };

    await gate.runExpiry(probe, false);

    expect(stop).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
    expect(probe.availability).not.toHaveBeenCalled();

    operation.finish();
    operation.finish();
    await gate.runExpiry(probe, false);

    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('operation after committed stop waits for stop', async () => {
    const stopDone = deferred<void>();
    const renew = vi.fn();
    const gate = new ResourceActivityGate(renew, () => stopDone.promise);
    const expiry = gate.runExpiry(
      {
        availability: async () => 'available' as const,
        processesHasActive: async () => false,
        terminalsHasActive: async () => false
      },
      false
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const operation = gate.beginOperation();
    let unblocked = false;
    const beforeCall = operation.beforeCall.then(() => {
      unblocked = true;
    });
    await Promise.resolve();
    expect(unblocked).toBe(false);
    stopDone.resolve();
    await expiry;
    await beforeCall;
    operation.finish();
    expect(unblocked).toBe(true);
  });

  test('non-waking operation awaits a committed stop without renewing', async () => {
    const stopDone = deferred<void>();
    const renew = vi.fn();
    const gate = new ResourceActivityGate(renew, () => stopDone.promise);
    const expiry = gate.runExpiry(
      {
        availability: async () => 'absent' as const,
        processesHasActive: async () => false,
        terminalsHasActive: async () => false
      },
      false
    );
    await Promise.resolve();
    const renewsBeforeObservation = renew.mock.calls.length;
    const operation = gate.beginNonWakingOperation();
    let admitted = false;
    const admission = operation.beforeCall.then(() => {
      admitted = true;
    });

    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(renew).toHaveBeenCalledTimes(renewsBeforeObservation);

    stopDone.resolve();
    await Promise.all([expiry, admission]);
    const renewsAfterStop = renew.mock.calls.length;
    operation.finish();
    expect(renew).toHaveBeenCalledTimes(renewsAfterStop);
  });

  test('repeated expiry during committed stop skips probes', async () => {
    const stopDone = deferred<void>();
    const stop = vi.fn(() => stopDone.promise);
    const gate = new ResourceActivityGate(vi.fn(), stop);
    const firstExpiry = gate.runExpiry(
      {
        availability: async () => 'available' as const,
        processesHasActive: async () => false,
        terminalsHasActive: async () => false
      },
      false
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const availability = vi.fn(async () => 'available' as const);
    const processesHasActive = vi.fn(async () => false);
    const terminalsHasActive = vi.fn(async () => false);
    const repeatedExpiries = Promise.all([
      gate.runExpiry(
        { availability, processesHasActive, terminalsHasActive },
        false
      ),
      gate.runExpiry(
        { availability, processesHasActive, terminalsHasActive },
        false
      )
    ]);

    await Promise.resolve();
    expect(availability).not.toHaveBeenCalled();
    expect(processesHasActive).not.toHaveBeenCalled();
    expect(terminalsHasActive).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);

    stopDone.resolve();
    await Promise.all([firstExpiry, repeatedExpiries]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('absent runtime commits stop without probes', async () => {
    const { gate, stop } = createGate();
    const processesHasActive = vi.fn(async () => false);
    const terminalsHasActive = vi.fn(async () => false);
    await gate.runExpiry(
      {
        availability: async () => 'absent' as const,
        processesHasActive,
        terminalsHasActive
      },
      false
    );
    expect(processesHasActive).not.toHaveBeenCalled();
    expect(terminalsHasActive).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('unknown runtime renews without probes or stop', async () => {
    const { gate, stop, renew } = createGate();
    const processesHasActive = vi.fn(async () => false);
    await gate.runExpiry(
      {
        availability: async () => 'unknown' as const,
        processesHasActive,
        terminalsHasActive: async () => false
      },
      false
    );
    expect(processesHasActive).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(renew).toHaveBeenCalled();
  });

  test('availability probe errors renew without stop', async () => {
    const { gate, stop, renew } = createGate();
    await gate.runExpiry(
      {
        availability: async () => {
          throw new Error('state unavailable');
        },
        processesHasActive: async () => false,
        terminalsHasActive: async () => false
      },
      false
    );
    expect(stop).not.toHaveBeenCalled();
    expect(renew).toHaveBeenCalled();
  });

  test('keepAlive bypasses stop and probes', async () => {
    const { gate, stop } = createGate();
    const availability = vi.fn(async () => 'available' as const);
    const processesHasActive = vi.fn(async () => false);
    await gate.runExpiry(
      {
        availability,
        processesHasActive,
        terminalsHasActive: async () => false
      },
      true
    );
    expect(availability).not.toHaveBeenCalled();
    expect(processesHasActive).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
});
