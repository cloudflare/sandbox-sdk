import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WarmPool } from '../../../../packages/sandbox/src/bridge/warm-pool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_INSTANCES_ERROR =
  'Maximum number of running container instances exceeded. Try again later, or try configuring a higher value for max_instances';

/**
 * Creates a mock Sandbox DO namespace that returns stubs with
 * Container-inherited RPC methods.
 */
function createMockSandboxNamespace(behavior: {
  startAndWaitForPorts: () => Promise<void>;
  getState: () => Promise<{ status: string }>;
}) {
  const stubs = new Map<string, ReturnType<typeof createStub>>();

  function createStub() {
    return {
      startAndWaitForPorts: behavior.startAndWaitForPorts,
      stop: vi.fn(async () => {}),
      renewActivityTimeout: vi.fn(),
      getState: behavior.getState
    };
  }

  return {
    namespace: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn((id: { name: string }) => {
        if (!stubs.has(id.name)) {
          stubs.set(id.name, createStub());
        }
        return stubs.get(id.name)!;
      })
    },
    stubs,
    /** Override getState for a specific container UUID */
    setContainerState(uuid: string, status: string) {
      const ns = this.namespace;
      ns.get(ns.idFromName(uuid));
      stubs.get(uuid)!.getState = vi.fn(async () => ({ status }));
    }
  };
}

/**
 * Runs a callback inside a WarmPool DO with a mocked Sandbox namespace.
 * Pre-seeds storage with optional warm containers, assignments, and maxInstances.
 */
async function withPool(
  opts: {
    warmTarget?: number;
    maxInstances?: number | null;
    warmContainers?: string[];
    assignments?: [string, string][];
    containerBehavior?: {
      startAndWaitForPorts: () => Promise<void>;
      getState: () => Promise<{ status: string }>;
    };
  },
  callback: (pool: WarmPool, mock: ReturnType<typeof createMockSandboxNamespace>) => Promise<void>
) {
  const behavior = opts.containerBehavior ?? {
    startAndWaitForPorts: vi.fn(async () => {}),
    getState: vi.fn(async () => ({ status: 'running' as const }))
  };

  const mock = createMockSandboxNamespace(behavior);

  // Use a unique ID per test to avoid state leakage between tests
  const id = env.WarmPool.newUniqueId();
  const stub = env.WarmPool.get(id);

  await runInDurableObject(stub, async (instance: WarmPool, state) => {
    // Inject mock Sandbox namespace
    (instance as unknown as { env: Record<string, unknown> }).env.Sandbox = mock.namespace;

    // Pre-seed storage
    if (opts.warmContainers?.length) {
      await state.storage.put('warmContainers', new Set(opts.warmContainers));
    }
    if (opts.assignments?.length) {
      await state.storage.put('assignments', new Map(opts.assignments));
    }
    if (opts.maxInstances !== undefined && opts.maxInstances !== null) {
      await state.storage.put('knownMaxInstances', opts.maxInstances);
    }

    // Configure
    await instance.configure({
      warmTarget: opts.warmTarget ?? 0,
      refreshInterval: 60_000
    });

    await callback(instance, mock);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WarmPool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── Default pool size ──────────────────────────────────────────────────

  describe('default pool size 0', () => {
    it('does not pre-warm any containers when warmTarget is 0', async () => {
      let startCount = 0;
      await withPool(
        {
          warmTarget: 0,
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {
              startCount++;
            }),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          await pool.alarm();
          expect(startCount).toBe(0);
        }
      );
    });
  });

  // ── adjustPool ─────────────────────────────────────────────────────────

  describe('adjustPool', () => {
    it('starts containers to reach warmTarget', async () => {
      let startCount = 0;
      await withPool(
        {
          warmTarget: 3,
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {
              startCount++;
            }),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          await pool.alarm();
          expect(startCount).toBe(3);
        }
      );
    });

    it('clamps container starts to remaining capacity', async () => {
      let startCount = 0;
      await withPool(
        {
          warmTarget: 5,
          maxInstances: 3,
          assignments: [
            ['user1', 'c1'],
            ['user2', 'c2']
          ],
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {
              startCount++;
            }),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          await pool.alarm();
          expect(startCount).toBe(1);
        }
      );
    });

    it('only fires one probe when completely at capacity', async () => {
      let startCount = 0;
      await withPool(
        {
          warmTarget: 5,
          maxInstances: 3,
          assignments: [
            ['user1', 'c1'],
            ['user2', 'c2'],
            ['user3', 'c3']
          ],
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {
              startCount++;
              throw new Error(MAX_INSTANCES_ERROR);
            }),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          await pool.alarm();
          expect(startCount).toBe(1);
        }
      );
    });

    it('does not start containers when warm target already met', async () => {
      let startCount = 0;
      await withPool(
        {
          warmTarget: 3,
          warmContainers: ['w1', 'w2', 'w3'],
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {
              startCount++;
            }),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          await pool.alarm();
          expect(startCount).toBe(0);
        }
      );
    });
  });

  // ── getContainer ───────────────────────────────────────────────────────

  describe('getContainer', () => {
    it('assigns warm container when one is available', async () => {
      await withPool(
        {
          warmTarget: 2,
          maxInstances: 3,
          warmContainers: ['warm1'],
          assignments: [
            ['user1', 'c1'],
            ['user2', 'c2']
          ],
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {}),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          const result = await pool.getContainer('user3');
          expect(result).toBe('warm1');
        }
      );
    });

    it('starts a new container on-demand when pool is empty and below capacity', async () => {
      let started = false;
      await withPool(
        {
          warmTarget: 0,
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {
              started = true;
            }),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          const result = await pool.getContainer('user1');
          expect(started).toBe(true);
          expect(typeof result).toBe('string');
        }
      );
    });

    it('returns existing assignment if container is still running', async () => {
      await withPool(
        {
          assignments: [['user1', 'c1']],
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {}),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          const result = await pool.getContainer('user1');
          expect(result).toBe('c1');
        }
      );
    });

    it('throws when at capacity and no warm containers available', async () => {
      await withPool(
        {
          warmTarget: 2,
          maxInstances: 2,
          assignments: [
            ['user1', 'c1'],
            ['user2', 'c2']
          ],
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {}),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          await expect(pool.getContainer('user3')).rejects.toThrow(
            'Cannot start container: instance limit reached (2/2)'
          );
        }
      );
    });

    it('surfaces capacity error when limit is discovered during start', async () => {
      await withPool(
        {
          warmTarget: 0,
          assignments: [['user1', 'c1']],
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {
              throw new Error(MAX_INSTANCES_ERROR);
            }),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          await expect(pool.getContainer('user2')).rejects.toThrow('instance limit reached');
        }
      );
    });

    it('recovers stale assignment and starts new container', async () => {
      let started = false;
      await withPool(
        {
          warmTarget: 0,
          maxInstances: 2,
          assignments: [
            ['user1', 'c1'],
            ['user2', 'c2']
          ],
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {
              started = true;
            }),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool, mock) => {
          mock.setContainerState('c1', 'stopped');
          const result = await pool.getContainer('user1');
          expect(started).toBe(true);
          expect(typeof result).toBe('string');
        }
      );
    });
  });

  // ── startContainer error detection ─────────────────────────────────────

  describe('startContainer / error detection', () => {
    it('records knownMaxInstances when max_instances error is thrown', async () => {
      await withPool(
        {
          warmTarget: 3,
          assignments: [
            ['user1', 'c1'],
            ['user2', 'c2']
          ],
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {
              throw new Error(MAX_INSTANCES_ERROR);
            }),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          await pool.alarm();
          const stats = await pool.getStats();
          expect(stats.maxInstances).toBe(2);
        }
      );
    });

    it('does not record limit on non-capacity errors', async () => {
      await withPool(
        {
          warmTarget: 3,
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {
              throw new Error('Some other network error');
            }),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          await pool.alarm();
          const stats = await pool.getStats();
          expect(stats.maxInstances).toBeNull();
        }
      );
    });
  });

  // ── Probe mechanism ────────────────────────────────────────────────────

  describe('probe mechanism', () => {
    it('clears cached limit when probe succeeds', async () => {
      let startCount = 0;
      await withPool(
        {
          warmTarget: 3,
          maxInstances: 2,
          assignments: [
            ['user1', 'c1'],
            ['user2', 'c2']
          ],
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {
              startCount++;
            }),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          await pool.alarm();
          const stats = await pool.getStats();
          expect(stats.maxInstances).toBeNull();
          // 1 probe + 2 remaining (warmTarget=3, minus the 1 probe already added)
          expect(startCount).toBe(3);
        }
      );
    });

    it('preserves cached limit when probe fails', async () => {
      await withPool(
        {
          warmTarget: 3,
          maxInstances: 2,
          assignments: [
            ['user1', 'c1'],
            ['user2', 'c2']
          ],
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {
              throw new Error(MAX_INSTANCES_ERROR);
            }),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          await pool.alarm();
          const stats = await pool.getStats();
          expect(stats.maxInstances).toBe(2);
        }
      );
    });
  });

  // ── capacityExhausted mid-loop ─────────────────────────────────────────

  describe('capacityExhausted mid-loop', () => {
    it('stops starting containers after hitting capacity error mid-loop', async () => {
      let startCount = 0;
      await withPool(
        {
          warmTarget: 5,
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {
              startCount++;
              if (startCount >= 3) {
                throw new Error(MAX_INSTANCES_ERROR);
              }
            }),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          await pool.alarm();
          // 2 succeeded, 3rd failed, loop stopped
          expect(startCount).toBe(3);
        }
      );
    });
  });

  // ── reportStopped / recovery ───────────────────────────────────────────

  describe('recovery paths', () => {
    it('reportStopped frees capacity for new containers', async () => {
      await withPool(
        {
          warmTarget: 0,
          maxInstances: 2,
          assignments: [
            ['user1', 'c1'],
            ['user2', 'c2']
          ],
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {}),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          await expect(pool.getContainer('user3')).rejects.toThrow('instance limit reached');
          await pool.reportStopped('c1');
          const result = await pool.getContainer('user3');
          expect(typeof result).toBe('string');
        }
      );
    });

    it('health check removes dead containers and adjustPool refills', async () => {
      let startCount = 0;
      await withPool(
        {
          warmTarget: 2,
          maxInstances: 3,
          warmContainers: ['w1'],
          assignments: [
            ['user1', 'c1'],
            ['user2', 'c2']
          ],
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {
              startCount++;
            }),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool, mock) => {
          mock.setContainerState('c1', 'stopped');
          await pool.alarm();
          expect(startCount).toBe(1);
          const stats = await pool.getStats();
          expect(stats.assigned).toBe(1);
          expect(stats.warm).toBe(2);
        }
      );
    });
  });

  // ── getStats ───────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('includes knownMaxInstances in stats', async () => {
      await withPool(
        {
          warmTarget: 2,
          maxInstances: 10
        },
        async (pool) => {
          const stats = await pool.getStats();
          expect(stats.maxInstances).toBe(10);
        }
      );
    });

    it('returns null maxInstances when no limit known', async () => {
      await withPool(
        {
          warmTarget: 2
        },
        async (pool) => {
          const stats = await pool.getStats();
          expect(stats.maxInstances).toBeNull();
        }
      );
    });
  });

  // ── Multiple alarm cycles ──────────────────────────────────────────────

  describe('multiple alarm cycles', () => {
    it('learns limit on first cycle, respects it on second, detects increase on third', async () => {
      let totalStarted = 0;
      let realLimit = 2;

      await withPool(
        {
          warmTarget: 3,
          containerBehavior: {
            startAndWaitForPorts: vi.fn(async () => {
              totalStarted++;
              if (totalStarted > realLimit) {
                totalStarted--;
                throw new Error(MAX_INSTANCES_ERROR);
              }
            }),
            getState: vi.fn(async () => ({ status: 'running' }))
          }
        },
        async (pool) => {
          // Cycle 1: no limit known, starts 2 successfully, 3rd fails
          await pool.alarm();
          const stats1 = await pool.getStats();
          expect(stats1.warm).toBe(2);
          expect(stats1.maxInstances).toBe(2);

          // Cycle 2: at limit, probe fires and fails
          await pool.alarm();
          const stats2 = await pool.getStats();
          expect(stats2.warm).toBe(2);
          expect(stats2.maxInstances).toBe(2);

          // Cycle 3: real limit raised to 5, probe succeeds, pool fills to warmTarget
          realLimit = 5;
          await pool.alarm();
          const stats3 = await pool.getStats();
          expect(stats3.warm).toBe(3);
          expect(stats3.maxInstances).toBeNull();
        }
      );
    });
  });
});
